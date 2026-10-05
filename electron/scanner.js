import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createExclusionMatcher } from './pathmatch.js'
import { hashFile, MAX_SCAN_BYTES, SCAN_PARALLELISM } from './engine.js'

const QUICK_NAMES = ['Downloads', 'Desktop', 'Documents']
// macOS keeps mail, messages, contacts and similar private data in these folders.
// Reading them only produces privacy prompts or permission errors, never threats.
const MAC_PRIVATE_LIBRARY = ['Mail', 'Messages', 'Safari', 'Calendars', 'Reminders', 'HomeKit', 'IdentityServices', 'Suggestions', 'Metadata', 'Biome', 'Containers', 'Group Containers', 'Application Support/AddressBook', 'Application Support/CallHistoryDB', 'Application Support/com.apple.TCC', 'Application Support/MobileSync']
const MAC_SKIPPED = process.platform === 'darwin'
  ? new Set(MAC_PRIVATE_LIBRARY.map((name) => path.join(os.homedir(), 'Library', name)).concat(path.join(os.homedir(), '.Trash')))
  : new Set()

/** Where programs register themselves to start at login, a common place for malware. */
function startupLocations(home) {
  if (process.platform === 'win32') return [path.join(process.env.APPDATA || home, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')]
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']
  return [path.join(home, '.config', 'autostart')]
}
const WINDOWS_BLOCKED_ROOTS = [/^[a-z]:\\windows(?:\\|$)/i, /^[a-z]:\\program files(?: \(x86\))?(?:\\|$)/i]
const SOURCES = ['manual', 'scheduled', 'startup', 'usb']
// The status is pushed to the window on every file, so keep the list bounded.
const MAX_LISTED_DETECTIONS = 200

// Real-time protection sends these to the full engine (the instant hash check
// covers everything else): programs, scripts, installers, archives, macro
// documents and other formats malware is usually delivered in.
const RISKY_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'com', 'pif', 'cpl', 'ocx', 'sys', 'msi', 'msix', 'msp', 'appx', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'jar', 'apk', 'sh', 'command', 'dmg', 'pkg', 'iso', 'img', 'vhd', 'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'cab', 'arj', 'ace', 'doc', 'docm', 'dot', 'dotm', 'xls', 'xlsm', 'xlsb', 'xlam', 'ppt', 'pptm', 'potm', 'rtf', 'pdf', 'one', 'chm', 'html', 'htm', 'svg', 'eml', 'msg'])

/** Executable or risky by extension, or by its first bytes (PE, Mach-O, ELF, script). */
async function isRisky(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (RISKY_EXTENSIONS.has(extension)) return true
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const head = Buffer.alloc(4)
      const { bytesRead } = await handle.read(head, 0, 4, 0)
      if (bytesRead < 2) return false
      const magic = head.readUInt32BE(0)
      return head.toString('latin1', 0, 2) === 'MZ' || head.toString('latin1', 0, 2) === '#!' || head.toString('latin1', 0, 4) === '\x7fELF'
        || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)
    } finally { await handle.close() }
  } catch { return false }
}

/** "PUA.Win.Packer…" are potentially unwanted programs, not malware. */
function severityOf(threatName) {
  if (/^PUA\./i.test(threatName)) return 'medium'
  if (/eicar|\.Test\./i.test(threatName)) return 'low'
  return 'high'
}

// Consecutive engine failures after which a scan stops instead of reporting
// unchecked files as clean.
const MAX_ENGINE_FAILURES = 25

function createInitialStatus() {
  return { state: 'idle', mode: null, source: null, filesScanned: 0, threatsDetected: 0, quarantined: 0, detections: [], currentFile: null, startedAt: null, elapsedMs: 0, scanSpeed: 0, error: null }
}

export class Scanner {
  #engine
  #downloadSignatures
  #inflight = new Set()
  #engineFailures = 0
  #status = createInitialStatus()
  #running = null
  #busy = false
  #paused = false
  #cancelled = false
  #visitedDirectories = new Set()
  #listeners = new Set()
  #detectionListeners = new Set()
  #quarantine
  #policy = { exclusions: () => [], isAllowed: () => false }
  #isExcluded = () => false

  constructor({ quarantine, engine, downloadSignatures = null } = {}) {
    this.#quarantine = quarantine || null
    this.#engine = engine
    // Goes through the update manager so the download is logged and recorded.
    this.#downloadSignatures = downloadSignatures || (() => this.#engine.update())
  }

  async initialize() {
    // The old hash-list definitions (a single test signature) are replaced by ClamAV.
    for (const name of ['definitions.json', 'definitions-meta.json']) await fs.rm(path.join(app.getPath('userData'), name), { force: true }).catch(() => {})
  }

  getStatus() { return this.#status }

  /** True while a scan is starting, running or paused. */
  isBusy() { return this.#busy }

  /** Notifies the main process of every status change. Returns an unsubscribe. */
  onStatus(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  /** Fires for every detection made by a scan (not by inspectFile). */
  onDetection(listener) { this.#detectionListeners.add(listener); return () => this.#detectionListeners.delete(listener) }

  getDefinitionCount() { return this.#engine.getInfo().signatures }

  /**
   * `exclusions()` returns the user's excluded paths; `isAllowed(sha256)` says
   * whether a file hash was restored by the user and must not be flagged again.
   */
  setPolicy({ exclusions, isAllowed } = {}) {
    this.#policy = {
      exclusions: typeof exclusions === 'function' ? exclusions : () => [],
      isAllowed: typeof isAllowed === 'function' ? isAllowed : () => false,
    }
  }

  /** Current exclusion matcher, built from the latest settings. */
  exclusionMatcher() {
    let list = []
    try { list = this.#policy.exclusions() || [] } catch { list = [] }
    return createExclusionMatcher(list)
  }

  #allowed(sha256) { try { return Boolean(this.#policy.isAllowed(sha256)) } catch { return false } }

  /**
   * Real-time check of one file: ClamAV's whole-file hash signatures first
   * (instant, no engine needed), then the full engine for risky file types.
   */
  async inspectFile(filePath) {
    try {
      const stats = await fs.lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink()) return { detected: false, filePath }
      const hashes = await hashFile(filePath)
      let threatName = this.#engine.lookupHashes(hashes)
      if (!threatName && stats.size <= MAX_SCAN_BYTES && await isRisky(filePath)) {
        const result = await this.#engine.scanFile(filePath)
        if (result.infected) threatName = result.name
      }
      if (threatName && this.#allowed(hashes.sha256)) return { detected: false, allowed: true, definition: null, sha256: hashes.sha256, filePath }
      return { detected: Boolean(threatName), definition: threatName ? { threatName, severity: severityOf(threatName) } : null, sha256: hashes.sha256, filePath }
    } catch { return { detected: false, filePath } }
  }

  #gate = null

  /** Every scan (manual, scheduled, USB) is refused while the gate returns false. */
  setGate(gate) { this.#gate = typeof gate === 'function' ? gate : null }

  async start({ mode = 'quick', paths = [], trusted = false, source = 'manual' } = {}) {
    if (this.#gate && !this.#gate()) throw new Error('An active licence is required to scan. Activate a licence on the Licence page.')
    if (this.#busy) throw new Error('A scan is already running')
    if (!this.#engine.isAvailable()) throw new Error('The scanning engine is missing from this installation. Reinstall Aegis.')
    // Without signatures yet (first run), the scan waits for the download and then starts by itself.
    const waitingForSignatures = !this.#engine.getInfo().ready
    this.#busy = true
    let scanPaths
    try {
      scanPaths = await this.#resolvePaths(mode, paths, trusted)
      if (!scanPaths.length) throw new Error('No accessible scan locations were found')
    } catch (error) {
      this.#busy = false
      throw error
    }
    this.#cancelled = false
    this.#paused = false
    this.#visitedDirectories.clear()
    this.#engineFailures = 0
    this.#isExcluded = this.exclusionMatcher()
    this.#status = { ...createInitialStatus(), state: 'running', mode, source: SOURCES.includes(source) ? source : 'manual', startedAt: Date.now(), preparing: waitingForSignatures || !this.#engine.isRunning(), waitingForSignatures }
    this.#running = this.#run(scanPaths).finally(() => { this.#running = null; this.#busy = false; this.#publish() })
    this.#publish()
    return this.#status
  }

  pause() { if (this.#running) this.#paused = true; this.#status = { ...this.#status, state: this.#running ? 'paused' : this.#status.state }; this.#publish(); return this.#status }
  resume() { if (this.#running) this.#paused = false; this.#status = { ...this.#status, state: this.#running ? 'running' : this.#status.state }; this.#publish(); return this.#status }
  cancel() { if (this.#running) { this.#cancelled = true; this.#paused = false } return this.#status }

  async #resolvePaths(mode, paths, trusted) {
    if (mode === 'custom') return this.#accessiblePaths(paths, trusted)
    if (mode === 'full') return this.#accessiblePaths([os.homedir()])
    const home = os.homedir()
    // Fixed locations chosen here, so the ones outside the home folder are allowed.
    return this.#accessiblePaths(QUICK_NAMES.map((name) => path.join(home, name)).concat(startupLocations(home)), true)
  }

  async #accessiblePaths(paths, trusted = false) {
    const accessible = []
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue
      const normalized = path.resolve(candidate)
      if (!trusted && !this.#isInsideHome(normalized)) continue
      if (process.platform === 'win32' && WINDOWS_BLOCKED_ROOTS.some((pattern) => pattern.test(normalized))) continue
      try {
        const stats = await fs.lstat(normalized)
        if (stats.isSymbolicLink()) continue
        await fs.access(normalized)
        accessible.push(normalized)
      } catch { /* Permission or missing path: skip it. */ }
    }
    return accessible
  }

  #isInsideHome(candidate) { const home = path.resolve(os.homedir()); return candidate === home || candidate.startsWith(`${home}${path.sep}`) }

  async #run(paths) {
    try {
      if (this.#status.waitingForSignatures) {
        // Joins a download already in progress, or starts one.
        await this.#downloadSignatures()
        if (!this.#engine.getInfo().ready) throw new Error('The threat signatures could not be downloaded. Check your internet connection and try again.')
        this.#status = { ...this.#status, waitingForSignatures: false }
        this.#publish()
      }
      // Loading 3.6 million signatures takes a few seconds the first time.
      if (!this.#cancelled) await this.#engine.ensureRunning()
      this.#status = { ...this.#status, preparing: false, startedAt: Date.now() }
      this.#publish()
      for (const scanPath of paths) {
        if (this.#cancelled) break
        await this.#walk(scanPath)
      }
      await Promise.all(this.#inflight)
      this.#status = { ...this.#status, state: this.#cancelled ? 'cancelled' : 'completed', currentFile: null, elapsedMs: Date.now() - this.#status.startedAt }
    } catch (error) {
      this.#cancelled = true
      await Promise.allSettled(this.#inflight)
      this.#status = { ...this.#status, state: 'failed', preparing: false, waitingForSignatures: false, currentFile: null, error: error instanceof Error ? error.message : 'Scan failed', elapsedMs: Date.now() - this.#status.startedAt }
    }
  }

  async #walk(entryPath) {
    if (this.#isExcluded(entryPath)) return
    let stats
    try { stats = await fs.lstat(entryPath) } catch { return }
    if (this.#cancelled || stats.isSymbolicLink()) return
    if (stats.isFile()) { await this.#enqueue(entryPath); return }
    if (!stats.isDirectory()) return
    if (MAC_SKIPPED.has(entryPath)) return
    let directoryIdentity
    try { directoryIdentity = `${stats.dev}:${stats.ino}` } catch { directoryIdentity = entryPath.toLowerCase() }
    if (this.#visitedDirectories.has(directoryIdentity)) return
    this.#visitedDirectories.add(directoryIdentity)
    let directory
    try { directory = await fs.opendir(entryPath) } catch { return }
    for await (const entry of directory) {
      if (this.#cancelled) break
      while (this.#paused && !this.#cancelled) await new Promise((resolve) => setTimeout(resolve, 100))
      await this.#walk(path.join(entryPath, entry.name))
    }
  }

  /** Keeps SCAN_PARALLELISM files with the engine at once. */
  async #enqueue(filePath) {
    while (this.#inflight.size >= SCAN_PARALLELISM) await Promise.race(this.#inflight)
    if (this.#engineFailures >= MAX_ENGINE_FAILURES) throw new Error('The scanning engine stopped responding, so the scan was stopped. Start it again.')
    const job = this.#scanFile(filePath).finally(() => this.#inflight.delete(job))
    this.#inflight.add(job)
  }

  async #scanFile(filePath) {
    if (this.#cancelled) return
    this.#status = { ...this.#status, currentFile: filePath, filesScanned: this.#status.filesScanned + 1, elapsedMs: Date.now() - this.#status.startedAt }
    let result = null
    try {
      result = await this.#engine.scanFile(filePath)
      this.#engineFailures = 0
    } catch {
      // A file that vanished is normal; an engine that stopped answering is not.
      if (!this.#engine.isRunning()) this.#engineFailures += 1
    }
    if (result?.infected) {
      let sha256 = null
      try { sha256 = (await hashFile(filePath)).sha256 } catch { /* gone */ }
      if (!sha256 || !this.#allowed(sha256)) await this.#handleDetection(filePath, { threatName: result.name, severity: severityOf(result.name) })
    }
    const elapsed = Math.max(1, Date.now() - this.#status.startedAt)
    this.#status = { ...this.#status, elapsedMs: elapsed, scanSpeed: Math.round(this.#status.filesScanned / (elapsed / 1000)) }
    this.#publish()
  }

  /** Every scan source quarantines what it finds, the same way real-time protection does. */
  async #handleDetection(filePath, definition) {
    const threatName = String(definition?.threatName || 'Detected threat')
    const severity = String(definition?.severity || 'high')
    let quarantined = false
    let error = null
    if (this.#quarantine) {
      try { await this.#quarantine.quarantine(filePath, threatName); quarantined = true } catch (caught) { error = caught instanceof Error ? caught.message : 'Unable to quarantine detected file.' }
    } else {
      error = 'Quarantine is unavailable.'
    }
    const detection = { filePath, threatName, severity, quarantined, error, at: new Date().toISOString() }
    const detections = this.#status.detections.length < MAX_LISTED_DETECTIONS ? [...this.#status.detections, detection] : this.#status.detections
    this.#status = { ...this.#status, threatsDetected: this.#status.threatsDetected + 1, quarantined: this.#status.quarantined + (quarantined ? 1 : 0), detections }
    for (const listener of this.#detectionListeners) { try { listener({ ...detection, source: this.#status.source, mode: this.#status.mode }) } catch { /* A listener must never break a scan. */ } }
  }

  #publish() {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('scanner:update', this.#status)
    for (const listener of this.#listeners) { try { listener(this.#status) } catch { /* A listener must never break a scan. */ } }
  }
}
