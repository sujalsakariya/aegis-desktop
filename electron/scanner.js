import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createExclusionMatcher } from './pathmatch.js'

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

function createInitialStatus() {
  return { state: 'idle', mode: null, source: null, filesScanned: 0, threatsDetected: 0, quarantined: 0, detections: [], currentFile: null, startedAt: null, elapsedMs: 0, scanSpeed: 0, error: null }
}

export class Scanner {
  #definitionsPath
  #definitions = new Map()
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

  constructor({ quarantine } = {}) {
    this.#definitionsPath = path.join(app.getPath('userData'), 'definitions.json')
    this.#quarantine = quarantine || null
  }

  async initialize() {
    try {
      const contents = await fs.readFile(this.#definitionsPath, 'utf8')
      const definitions = JSON.parse(contents)
      if (!Array.isArray(definitions)) throw new Error('Definitions must be an array')
      this.#definitions = new Map(definitions.filter((item) => typeof item?.sha256 === 'string').map((item) => [item.sha256.toLowerCase(), item]))
      if (this.#status.error === 'Unable to load local definitions.') this.#status = { ...this.#status, error: null }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#status.error = 'Unable to load local definitions.'
    }
  }

  getStatus() { return this.#status }

  /** True while a scan is starting, running or paused. */
  isBusy() { return this.#busy }

  /** Notifies the main process of every status change. Returns an unsubscribe. */
  onStatus(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  /** Fires for every detection made by a scan (not by inspectFile). */
  onDetection(listener) { this.#detectionListeners.add(listener); return () => this.#detectionListeners.delete(listener) }

  getDefinitionCount() { return this.#definitions.size }

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

  async inspectFile(filePath) {
    try {
      const stats = await fs.lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink()) return { detected: false, filePath }
      const sha256 = await this.#hashFile(filePath)
      const definition = this.#definitions.get(sha256) || null
      if (definition && this.#allowed(sha256)) return { detected: false, allowed: true, definition: null, sha256, filePath }
      return { detected: Boolean(definition), definition, sha256, filePath }
    } catch { return { detected: false, filePath } }
  }

  #gate = null

  /** Every scan (manual, scheduled, USB) is refused while the gate returns false. */
  setGate(gate) { this.#gate = typeof gate === 'function' ? gate : null }

  async start({ mode = 'quick', paths = [], trusted = false, source = 'manual' } = {}) {
    if (this.#gate && !this.#gate()) throw new Error('An active licence is required to scan. Activate a licence on the Licence page.')
    if (this.#busy) throw new Error('A scan is already running')
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
    this.#isExcluded = this.exclusionMatcher()
    this.#status = { ...createInitialStatus(), state: 'running', mode, source: SOURCES.includes(source) ? source : 'manual', startedAt: Date.now() }
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
      for (const scanPath of paths) {
        if (this.#cancelled) break
        await this.#walk(scanPath)
      }
      this.#status = { ...this.#status, state: this.#cancelled ? 'cancelled' : 'completed', currentFile: null, elapsedMs: Date.now() - this.#status.startedAt }
    } catch (error) {
      this.#status = { ...this.#status, state: 'failed', currentFile: null, error: error instanceof Error ? error.message : 'Scan failed', elapsedMs: Date.now() - this.#status.startedAt }
    }
  }

  async #walk(entryPath) {
    if (this.#isExcluded(entryPath)) return
    let stats
    try { stats = await fs.lstat(entryPath) } catch { return }
    if (this.#cancelled || stats.isSymbolicLink()) return
    if (stats.isFile()) { await this.#scanFile(entryPath, stats.size); return }
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

  async #scanFile(filePath) {
    if (this.#cancelled) return
    this.#status = { ...this.#status, currentFile: filePath, filesScanned: this.#status.filesScanned + 1, elapsedMs: Date.now() - this.#status.startedAt }
    let hash = null
    try { hash = await this.#hashFile(filePath) } catch { /* Files can disappear or become unreadable while scanning. */ }
    const definition = hash ? this.#definitions.get(hash) : null
    if (definition && !this.#allowed(hash)) await this.#handleDetection(filePath, definition)
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

  #hashFile(filePath) { return new Promise((resolve, reject) => { const hash = crypto.createHash('sha256'); const stream = createReadStream(filePath); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex'))) }) }
  #publish() {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('scanner:update', this.#status)
    for (const listener of this.#listeners) { try { listener(this.#status) } catch { /* A listener must never break a scan. */ } }
  }
}
