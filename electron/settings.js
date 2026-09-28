import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

export const THEMES = ['system', 'light', 'dark']
// Only English ships today. Any other stored value is coerced back to 'en'.
export const LANGUAGES = ['en']
const BOOLEAN_KEYS = ['realTimeProtection', 'automaticScanning', 'usbProtection', 'notifications', 'dndMode', 'silentMode', 'updateChecks', 'launchAtStartup', 'runInBackground', 'firstScanCompleted']
const SCHEDULE_KEYS = ['daily', 'weekly', 'monthly', 'startup']

export const defaults = {
  realTimeProtection: true,
  automaticScanning: true,
  usbProtection: true,
  notifications: true,
  dndMode: false,
  silentMode: false,
  scanExclusions: [],
  scheduledScans: { daily: false, weekly: false, monthly: false, startup: false },
  updateChecks: true,
  language: 'en',
  theme: 'system',
  // Register Aegis to start with Windows. Applied only in packaged builds.
  launchAtStartup: true,
  // Closing the window hides it to the tray so protection keeps running.
  runInBackground: true,
  // Set by the renderer once the first-run scan has finished.
  firstScanCompleted: false,
}

export const SETTING_KEYS = Object.keys(defaults)

/** Repairs values loaded from disk so an old or damaged file cannot break the app. */
function sanitize(stored) {
  const next = { ...defaults }
  if (!stored || typeof stored !== 'object') return next
  for (const key of BOOLEAN_KEYS) if (typeof stored[key] === 'boolean') next[key] = stored[key]
  if (Array.isArray(stored.scanExclusions)) next.scanExclusions = stored.scanExclusions.filter((item) => typeof item === 'string' && path.isAbsolute(item))
  if (stored.scheduledScans && typeof stored.scheduledScans === 'object') {
    for (const key of SCHEDULE_KEYS) if (typeof stored.scheduledScans[key] === 'boolean') next.scheduledScans[key] = stored.scheduledScans[key]
  }
  if (THEMES.includes(stored.theme)) next.theme = stored.theme
  if (LANGUAGES.includes(stored.language)) next.language = stored.language
  return next
}

export class SettingsStore {
  #path = path.join(app.getPath('userData'), 'settings.bin')
  #settings = structuredClone(defaults)
  async initialize() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable')
    try { this.#settings = sanitize(JSON.parse(safeStorage.decryptString(await fs.readFile(this.#path)))) } catch { await this.#save() }
  }
  get() { return structuredClone(this.#settings) }
  async update(patch) {
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some((key) => !Object.hasOwn(defaults, key))) throw new Error('Unknown setting')
    for (const key of BOOLEAN_KEYS) if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`Invalid ${key}`)
    if ('scanExclusions' in patch && (!Array.isArray(patch.scanExclusions) || patch.scanExclusions.length > 500 || patch.scanExclusions.some((item) => typeof item !== 'string' || item.length > 1024 || !path.isAbsolute(item)))) throw new Error('Invalid scan exclusions. Each entry must be an absolute path.')
    if ('scheduledScans' in patch && (!patch.scheduledScans || typeof patch.scheduledScans !== 'object' || Object.keys(patch.scheduledScans).some((key) => !SCHEDULE_KEYS.includes(key)) || Object.values(patch.scheduledScans).some((value) => typeof value !== 'boolean'))) throw new Error('Invalid scheduled scans')
    if ('theme' in patch && !THEMES.includes(patch.theme)) throw new Error('Invalid theme')
    if ('language' in patch && !LANGUAGES.includes(patch.language)) throw new Error('Only English is available')
    this.#settings = { ...this.#settings, ...patch, scheduledScans: { ...this.#settings.scheduledScans, ...(patch.scheduledScans || {}) } }
    await this.#save()
    return this.get()
  }
  async #save() { await fs.mkdir(path.dirname(this.#path), { recursive: true }); await fs.writeFile(this.#path, safeStorage.encryptString(JSON.stringify(this.#settings)), { mode: 0o600 }) }
}
