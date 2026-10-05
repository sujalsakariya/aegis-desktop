import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import path from 'node:path'
import { LicenseManager, LICENSED_STATES } from './license.js'
import { Scanner } from './scanner.js'
import { QuarantineManager } from './quarantine.js'
import { RealtimeProtection } from './realtime.js'
import { SettingsStore, SETTING_KEYS } from './settings.js'
import { ScanScheduler, validateSchedule } from './scheduler.js'
import { UsbMonitor } from './usb.js'
import { UpdateManager } from './updates.js'
import { HistoryStore } from './history.js'
import { Cleaner } from './cleaner.js'
import { ClamEngine } from './engine.js'

// Set by vite-plugin-electron
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
// public/ is copied into dist/ by Vite; in development it is read directly.
const BRAND_DIR = path.join(process.env.VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST, 'brand')

/** The Aegis shield at a given size, with a sharper copy for high-DPI screens. */
function brandIcon(size) {
  const image = nativeImage.createFromPath(path.join(BRAND_DIR, `mark-${size}.png`))
  const sharper = nativeImage.createFromPath(path.join(BRAND_DIR, `mark-${size * 2}.png`))
  if (!image.isEmpty() && !sharper.isEmpty()) image.addRepresentation({ scaleFactor: 2, width: size, height: size, buffer: sharper.toPNG() })
  return image
}

// Passed by the login item so a launch at sign-in starts quietly in the tray.
const BACKGROUND_ARG = '--background'

let mainWindow = null
let tray = null
let isQuitting = false
let licenceReady = false
let trayHintShown = false

const licenseManager = new LicenseManager()
const quarantine = new QuarantineManager()
// The scanning engine ships inside the app (extraResources); in development it
// comes from vendor/engine/<platform>, filled by `npm run fetch-engine`.
const engine = new ClamEngine({
  resourcesDir: app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(app.getAppPath(), 'vendor', 'engine', process.platform),
  userData: app.getPath('userData'),
})
// The update manager is created below; the scanner only calls it once a scan starts.
const scanner = new Scanner({ quarantine, engine, downloadSignatures: () => updates.updateDefinitions() })
const realtime = new RealtimeProtection(scanner, quarantine)
const settings = new SettingsStore()
const scheduler = new ScanScheduler(scanner, app.getPath('userData'))
const usb = new UsbMonitor(settings, scanner)
const updates = new UpdateManager(engine)
const history = new HistoryStore()
const cleaner = new Cleaner()

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${name} is required`)
  return value
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || ''
  const allowed = VITE_DEV_SERVER_URL ? senderUrl.startsWith(VITE_DEV_SERVER_URL) : senderUrl.startsWith('file://')
  if (!allowed) throw new Error('Untrusted IPC sender')
}

function handler(handler) {
  return (event, ...args) => { assertTrustedSender(event); return handler(...args) }
}

function formatSize(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${unit ? value.toFixed(value >= 10 ? 0 : 1) : value} ${units[unit]}`
}

function requireLicense() {
  if (!licenseManager.isLicensed()) throw new Error('An active licence is required. Activate a licence on the Licence page.')
}

const NO_SCHEDULE = { daily: false, weekly: false, monthly: false, startup: false }

function savedSchedule() {
  return { ...NO_SCHEDULE, ...settings.get().scheduledScans }
}

/**
 * Single place that decides which protection modules run: the user's settings,
 * but only while the licence is active. Called at startup, after every settings
 * change and whenever the licence state changes.
 */
async function applyProtection() {
  const current = settings.get()
  const licensed = licenseManager.isLicensed()
  if (licensed && current.realTimeProtection) realtime.start()
  else realtime.stop()
  if (licensed && current.usbProtection) usb.start()
  else usb.stop()
  await scheduler.configure(savedSchedule(), { active: licensed && current.automaticScanning })
  if (!licensed && scanner.isBusy()) scanner.cancel()
}

/**
 * Keeps signatures current when "Update checks" is on and the device is
 * licensed. The update manager skips the download when the installed version
 * already matches the server.
 */
let definitionSync = null
function syncDefinitions() {
  if (definitionSync) return definitionSync
  definitionSync = (async () => {
    if (!licenseManager.isLicensed() || !settings.get().updateChecks) return null
    return updates.updateDefinitions({ background: true })
  })().catch(() => null).finally(() => { definitionSync = null })
  return definitionSync
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

function windowInFocus() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused())
}

/* ---------------- Notifications ---------------- */

/**
 * notifications=false or silentMode: nothing is shown.
 * dndMode: only critical notifications (threats) are shown.
 * Notifications never focus the window; clicking one opens it.
 */
function notify({ title, body, critical = false }) {
  const current = settings.get()
  if (!current.notifications || current.silentMode) return
  if (current.dndMode && !critical) return
  if (!Notification.isSupported()) return
  try {
    const notification = new Notification({ title, body, silent: false, icon: path.join(BRAND_DIR, 'mark-64.png') })
    notification.on('click', () => showWindow())
    notification.show()
  } catch { /* Notifications are best-effort. */ }
}

// A full scan can find many files; coalesce them into one notification.
let threatBatch = []
let threatTimer = null
function queueThreatNotification(detection) {
  threatBatch.push(detection)
  if (threatTimer) return
  threatTimer = setTimeout(() => {
    const batch = threatBatch
    threatBatch = []
    threatTimer = null
    const quarantinedCount = batch.filter((item) => item.quarantined).length
    if (batch.length === 1) {
      const [item] = batch
      notify({
        critical: true,
        title: item.quarantined ? `Threat quarantined: ${item.threatName}` : `Threat detected: ${item.threatName}`,
        body: item.quarantined ? `${path.basename(item.filePath)} was moved to quarantine.` : `${path.basename(item.filePath)} could not be quarantined. Open Aegis to review it.`,
      })
    } else {
      notify({
        critical: true,
        title: `${batch.length} threats detected`,
        body: `${quarantinedCount} moved to quarantine${quarantinedCount < batch.length ? `, ${batch.length - quarantinedCount} could not be moved` : ''}. Open Aegis to review.`,
      })
    }
  }, 3000)
}

function notifyScanFinished(status) {
  // The user is looking at the result already.
  if (status.source === 'manual' && windowInFocus()) return
  const label = status.source === 'usb' ? 'Removable drive scan' : status.source === 'scheduled' ? 'Scheduled scan' : status.source === 'startup' ? 'Startup scan' : 'Scan'
  if (status.state === 'failed') {
    notify({ title: `${label} failed`, body: String(status.error || 'The scan could not finish.').slice(0, 200) })
    return
  }
  const files = Number(status.filesScanned) || 0
  const threats = Number(status.threatsDetected) || 0
  const quarantinedCount = Number(status.quarantined) || 0
  notify({
    title: `${label} finished`,
    body: threats
      ? `${threats} threat(s) found in ${files.toLocaleString('en-US')} files; ${quarantinedCount} quarantined.`
      : `No threats found in ${files.toLocaleString('en-US')} files.`,
  })
}

/* ---------------- Window, tray, login item ---------------- */

/** A small shield drawn in code, so the tray needs no image asset. */
function trayIcon() {
  const size = 32
  const shield = [[0.5, 0.04], [0.92, 0.2], [0.84, 0.66], [0.5, 0.94], [0.16, 0.66], [0.08, 0.2]]
  const inside = (x, y, polygon) => {
    let hit = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i]
      const [xj, yj] = polygon[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
  const inner = shield.map(([x, y]) => [0.5 + (x - 0.5) * 0.46, 0.5 + (y - 0.5) * 0.46])
  const buffer = Buffer.alloc(size * size * 4)
  const samples = 4
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let outerCover = 0
      let innerCover = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size
          const y = (py + (sy + 0.5) / samples) / size
          if (inside(x, y, shield)) outerCover += 1
          if (inside(x, y, inner)) innerCover += 1
        }
      }
      const total = samples * samples
      const alpha = outerCover / total
      const white = innerCover / total
      // Premultiplied BGRA: brand green with a white core.
      const r = (0x0a * (1 - white) + 0xff * white) * alpha
      const g = (0x7d * (1 - white) + 0xff * white) * alpha
      const b = (0x55 * (1 - white) + 0xff * white) * alpha
      const offset = (py * size + px) * 4
      buffer[offset] = Math.round(b)
      buffer[offset + 1] = Math.round(g)
      buffer[offset + 2] = Math.round(r)
      buffer[offset + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 2 })
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quickScanFromTray() {
  scanner.start({ mode: 'quick', source: 'manual' })
    .then(() => notify({ title: 'Quick scan started', body: 'Aegis will let you know when it finishes.' }))
    .catch(() => showWindow())
}

function createTray() {
  if (tray || process.platform === 'darwin') return
  try {
    const logo = brandIcon(16)
    tray = new Tray(logo.isEmpty() ? trayIcon() : logo)
    tray.setToolTip('Aegis Security')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Aegis', click: () => showWindow() },
      { label: 'Quick scan', click: () => quickScanFromTray() },
      { type: 'separator' },
      { label: 'Quit Aegis', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('click', () => showWindow())
  } catch { tray = null }
}

function applyLoginItem() {
  // Development builds would register the bare Electron binary; skip them.
  if (!app.isPackaged || process.platform === 'linux') return
  try { app.setLoginItemSettings({ openAtLogin: Boolean(settings.get().launchAtStartup), args: [BACKGROUND_ARG] }) } catch { /* unsupported */ }
}

function applyTheme() {
  try { nativeTheme.themeSource = settings.get().theme } catch { /* ignore */ }
}

function createWindow({ hidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Aegis Antivirus',
    // Taskbar/title-bar icon (the installed app also gets it from the .exe).
    icon: path.join(BRAND_DIR, 'mark-256.png'),
    autoHideMenuBar: true,
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // Closing hides to the tray so real-time, USB and scheduled protection keep running.
  mainWindow.on('close', (event) => {
    if (isQuitting || !tray || !settings.get().runInBackground) return
    event.preventDefault()
    mainWindow.hide()
    if (!trayHintShown) {
      trayHintShown = true
      notify({ title: 'Aegis is still protecting this PC', body: 'It keeps running in the system tray. Right-click the tray icon to quit.' })
    }
  })

  // Windows sign-out or shutdown must not be blocked by the hide-to-tray handler.
  mainWindow.on('query-session-end', () => { isQuitting = true })
  mainWindow.on('session-end', () => { isQuitting = true })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/* ---------------- IPC ---------------- */

function scanOptions(value) {
  if (value === undefined) return { mode: 'quick', source: 'manual' }
  if (!value || typeof value !== 'object' || !['quick', 'full', 'custom'].includes(value.mode)) throw new Error('Invalid scan options')
  if (value.mode !== 'custom') return { mode: value.mode, source: 'manual' }
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 100 || value.paths.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 1024)) throw new Error('Invalid custom scan paths')
  return { mode: 'custom', paths: value.paths, source: 'manual' }
}

function settingsPatch(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings')
  if (Object.keys(value).some((key) => !SETTING_KEYS.includes(key))) throw new Error('Unknown setting')
  return value
}

function registerIpcHandlers() {
  ipcMain.handle('license:status', handler(() => licenseManager.getStatus()))
  ipcMain.handle('license:account', handler(() => licenseManager.getAccount()))
  ipcMain.handle('license:saveProfile', handler((profile) => licenseManager.saveProfile({ username: requireString(profile?.username, 'Username'), name: requireString(profile?.name, 'Name'), email: requireString(profile?.email, 'Email'), phone: requireString(profile?.phone, 'Phone') })))
  ipcMain.handle('license:login', handler((credentials) => licenseManager.saveProfile({ username: requireString(credentials?.username, 'Username'), email: requireString(credentials?.email, 'Email') })))
  ipcMain.handle('license:keyLogin', handler((credentials) => licenseManager.keyLogin(typeof credentials?.email === 'string' ? credentials.email.trim() : '', requireString(credentials?.licenseKey, 'Licence key'))))
  ipcMain.handle('license:signUp', handler((input) => licenseManager.signUp({ username: requireString(input?.username, 'Username'), name: requireString(input?.name, 'Name'), email: requireString(input?.email, 'Email'), phone: requireString(input?.phone, 'Phone') }, requireString(input?.licenseKey, 'Licence key'))))
  ipcMain.handle('license:updateProfile', handler((profile) => licenseManager.updateProfile({ name: requireString(profile?.name, 'Name'), phone: requireString(profile?.phone, 'Phone') })))
  ipcMain.handle('license:logout', handler(() => licenseManager.logout()))
  ipcMain.handle('license:activate', handler((licenseKey) => licenseManager.activate(requireString(licenseKey, 'License key'))))
  ipcMain.handle('license:validate', handler(() => licenseManager.validate({ force: true })))
  ipcMain.handle('license:deactivate', handler(() => licenseManager.deactivate()))
  ipcMain.handle('app:openLicenses', handler(async () => {
    // GPL-2.0 license of the bundled scanning engine, installed with the app.
    const folder = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(app.getAppPath(), 'vendor', 'engine', process.platform)
    const error = await shell.openPath(path.join(folder, 'COPYING.txt'))
    if (error) await shell.openPath(folder)
    return true
  }))
  ipcMain.handle('cleaner:status', handler(() => cleaner.getStatus()))
  ipcMain.handle('cleaner:analyze', handler(() => cleaner.analyze()))
  ipcMain.handle('cleaner:clean', handler(async (categoryIds) => {
    const result = await cleaner.clean(Array.isArray(categoryIds) ? categoryIds.map(String).slice(0, 10) : [])
    if (result.deleted) history.recordEvent('ok', `PC Cleaner removed ${result.deleted.toLocaleString('en-US')} junk file(s) and freed ${formatSize(result.freedBytes)}.`).catch(() => {})
    return result
  }))
  ipcMain.handle('cleaner:cancel', handler(() => cleaner.cancel()))
  ipcMain.handle('scanner:status', handler(() => scanner.getStatus()))
  ipcMain.handle('scanner:definitions', handler(() => ({ count: scanner.getDefinitionCount(), version: updates.getInstalled()?.version || null, updatedAt: engine.getInfo().updatedAt, engine: engine.isAvailable(), engineRunning: engine.isRunning() })))
  ipcMain.handle('scanner:start', handler((options) => scanner.start(scanOptions(options))))
  ipcMain.handle('scanner:pause', handler(() => scanner.pause()))
  ipcMain.handle('scanner:resume', handler(() => scanner.resume()))
  ipcMain.handle('scanner:cancel', handler(() => scanner.cancel()))
  ipcMain.handle('quarantine:list', handler(() => quarantine.list()))
  ipcMain.handle('quarantine:restore', handler((id) => quarantine.restore(requireString(id, 'Quarantine ID'))))
  ipcMain.handle('quarantine:delete', handler((id) => quarantine.delete(requireString(id, 'Quarantine ID'))))
  ipcMain.handle('quarantine:allowed', handler(() => quarantine.listAllowed()))
  ipcMain.handle('quarantine:removeAllowed', handler((sha256) => quarantine.removeAllowed(requireString(sha256, 'File hash'))))
  ipcMain.handle('realtime:status', handler(() => realtime.getStatus()))
  ipcMain.handle('realtime:start', handler(() => { requireLicense(); return realtime.start() }))
  ipcMain.handle('realtime:stop', handler(() => realtime.stop()))
  ipcMain.handle('settings:get', handler(() => settings.get()))
  ipcMain.handle('settings:update', handler(async (patch) => {
    const updated = await settings.update(settingsPatch(patch))
    await applyProtection()
    if (patch.updateChecks === true) syncDefinitions()
    if ('theme' in patch) applyTheme()
    if ('launchAtStartup' in patch) applyLoginItem()
    return updated
  }))
  ipcMain.handle('scheduler:status', handler(() => scheduler.getStatus()))
  ipcMain.handle('scheduler:update', handler(async (schedule) => {
    const next = validateSchedule({ ...NO_SCHEDULE, ...(schedule && typeof schedule === 'object' ? schedule : {}) })
    // Save the choice even when unlicensed; scans only run while licensed.
    await settings.update({ scheduledScans: next })
    await applyProtection()
    return savedSchedule()
  }))
  ipcMain.handle('scheduler:saved', handler(() => savedSchedule()))
  ipcMain.handle('usb:status', handler(() => usb.getStatus()))
  ipcMain.handle('usb:start', handler(() => { requireLicense(); return usb.start() }))
  ipcMain.handle('usb:stop', handler(() => usb.stop()))
  ipcMain.handle('updates:definitions:check', handler(() => updates.checkDefinitions()))
  ipcMain.handle('updates:definitions:install', handler((options) => updates.updateDefinitions({ force: options?.force === true })))
  ipcMain.handle('updates:application:check', handler(() => updates.checkApplication()))
  ipcMain.handle('updates:application:open', handler(() => updates.openApplicationDownload()))
  ipcMain.handle('updates:log', handler(() => history.getUpdateLog()))
  ipcMain.handle('history:summary', handler(() => history.getSummary()))
}

/* ---------------- Recorders ---------------- */

// Everything the dashboard reports is recorded here from real module activity.
function registerHistoryRecorders() {
  let lastScanState = null
  scanner.onStatus((status) => {
    if (status.state === lastScanState) return
    lastScanState = status.state
    if (['completed', 'cancelled', 'failed'].includes(status.state)) {
      history.recordScan(status)
      if (status.state !== 'cancelled') {
        notifyScanFinished(status)
        licenseManager.reportEvent(status.state === 'failed' ? 'SCAN_FAILED' : 'SCAN_COMPLETED', status.state === 'failed' ? 'medium' : status.threatsDetected > 0 ? 'high' : 'info', {
          mode: String(status.mode || 'quick'),
          source: String(status.source || 'manual'),
          filesScanned: Number(status.filesScanned) || 0,
          threatsDetected: Number(status.threatsDetected) || 0,
          quarantined: Number(status.quarantined) || 0,
          elapsedMs: Number(status.elapsedMs) || 0,
          ...(status.error ? { error: String(status.error).slice(0, 300) } : {}),
        })
      }
    }
  })

  const reportThreat = ({ filePath, threatName, severity, quarantined }, source) => {
    licenseManager.reportEvent('THREAT_DETECTED', 'high', {
      threatName: String(threatName || 'unknown').slice(0, 200),
      threatSeverity: String(severity || 'high').slice(0, 40),
      fileName: path.basename(String(filePath || '')).slice(0, 200),
      quarantined: Boolean(quarantined),
      source,
    })
  }

  // Manual, scheduled, startup and USB scans. Their threat totals are added
  // by recordScan, so only the quarantine count is recorded here.
  scanner.onDetection((detection) => {
    history.recordDetection(detection.filePath, detection.threatName, detection.quarantined, { countThreat: false })
    reportThreat(detection, String(detection.source || 'manual'))
    queueThreatNotification(detection)
  })

  realtime.onDetection((detection) => {
    history.recordDetection(detection.filePath, detection.threatName, detection.quarantined)
    reportThreat(detection, 'realtime')
    queueThreatNotification(detection)
  })

  usb.onInsert((drives) => {
    history.recordEvent('warn', `Removable drive ${drives.join(', ')} connected${settings.get().usbProtection ? ' and queued for scanning' : ''}.`)
  })

  updates.onInstalled((release, signatureCount) => {
    history.recordDefinitions(release, signatureCount)
  })

  updates.onEvent((event) => {
    broadcast('updates:update', event)
    history.recordUpdateEvent(event).catch(() => {})
    if (event.type === 'definitions-updated' && !windowInFocus()) {
      notify({ title: 'Threat definitions updated', body: `Version ${event.version}${Number.isFinite(event.signatureCount) ? ` · ${event.signatureCount.toLocaleString('en-US')} signatures` : ''}.` })
    }
  })
}

/* ---------------- Startup ---------------- */

async function safeInit(name, initialize) {
  try { await initialize() } catch (error) { console.error(`[aegis] ${name} failed to initialise:`, error) }
}

/** Licence check and definition sync touch the network, so they run after the window is up. */
async function startBackgroundServices() {
  let wasLicensed = false
  licenseManager.onChange((status) => {
    broadcast('license:update', status)
    if (!licenceReady) return
    const licensed = LICENSED_STATES.includes(status.state)
    if (licensed !== wasLicensed) {
      wasLicensed = licensed
      applyProtection().catch(() => {})
      if (licensed) syncDefinitions()
      history.recordEvent(licensed ? 'ok' : 'bad', licensed ? 'Licence activated. Protection is on.' : 'Licence is no longer active. Protection is off.').catch(() => {})
    }
  })

  await safeInit('licence', () => licenseManager.initialize())
  licenceReady = true
  wasLicensed = licenseManager.isLicensed()
  broadcast('license:update', licenseManager.getStatus())
  await applyProtection().catch(() => {})
  // Definitions first, so the startup scan uses the newest signatures. Every
  // request has a 15 s timeout, so this cannot hang.
  await syncDefinitions()
  scheduler.runStartup()

  // Re-validation is rate limited inside the licence manager to every 6 hours.
  setInterval(() => { licenseManager.validate().catch(() => {}) }, 30 * 60 * 1000)
  setInterval(() => { syncDefinitions() }, 6 * 60 * 60 * 1000)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.on('before-quit', () => { isQuitting = true; engine.stop() })

  app.on('window-all-closed', () => {
    // With "keep protecting" on the window hides instead of closing, so this
    // only runs when the user turned that off (or the tray is unavailable).
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })

  app.whenReady().then(async () => {
    registerIpcHandlers()
    scanner.setGate(() => licenseManager.isLicensed())
    cleaner.setGate(() => licenseManager.isLicensed())
    scanner.setPolicy({ exclusions: () => settings.get().scanExclusions, isAllowed: (sha256) => quarantine.isAllowed(sha256) })
    // Local state only: fast, and a failure in one store must not stop the window.
    await safeInit('history', () => history.initialize())
    await safeInit('settings', () => settings.initialize())
    await safeInit('engine', () => engine.initialize())
    await safeInit('scanner', () => scanner.initialize())
    await safeInit('quarantine', () => quarantine.initialize())
    await safeInit('updates', () => updates.initialize({ fallback: history.getSummary()?.definitions }))
    await safeInit('scheduler', () => scheduler.initialize())
    applyTheme()
    applyLoginItem()
    registerHistoryRecorders()
    createTray()

    const startHidden = process.argv.includes(BACKGROUND_ARG) && Boolean(tray) && settings.get().runInBackground
    createWindow({ hidden: startHidden })

    startBackgroundServices().catch((error) => console.error('[aegis] background start failed:', error))
  })
}
