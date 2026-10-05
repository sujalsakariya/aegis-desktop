import fs from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)
const DAY = 24 * 60 * 60 * 1000
// Enough for any real junk folder; stops a pathological tree from running forever.
const MAX_FILES_PER_CATEGORY = 250000

/**
 * PC Cleaner: finds and removes junk files in a fixed set of well-known
 * locations (temp folders, Recycle Bin / Trash, browser caches, crash reports,
 * thumbnail cache). It never takes paths from the user.
 *
 * Safety rules, enforced again at delete time:
 * - only files inside a category's own root folders are touched;
 * - symbolic links are removed as links (unlink), never followed;
 * - Aegis's own data (settings, quarantine, history) is never touched;
 * - temp files must be at least a day old, so running programs keep theirs;
 * - a browser that is running is skipped, its cache is cleaned once it is closed;
 * - files that are locked or not ours to delete are counted as skipped.
 */

/**
 * A folder to clean: everything inside `root` that passes the filters.
 * keep: file names at the root to leave alone; skip: subfolders of the root not to enter.
 */
function target(root, options = {}) {
  return { root, minAgeMs: 0, match: null, prune: false, keep: [], skip: [], ...options }
}


async function windowsSid() {
  try {
    const { stdout } = await execFileAsync('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 })
    return /"(S-1-[0-9-]+)"/.exec(stdout)?.[1] || null
  } catch { return null }
}

async function exists(candidate) {
  try { await fs.access(candidate); return true } catch { return false }
}

/** Names of running processes, lowercased, to skip browsers that are open. */
async function runningProcesses() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
      return new Set(stdout.split(/\r?\n/).map((line) => /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase()).filter(Boolean))
    }
    const { stdout } = await execFileAsync('ps', ['-axco', 'command'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
    return new Set(stdout.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean))
  } catch { return new Set() }
}

/** Chromium keeps a cache per profile ("Default", "Profile 1", …). */
/** Folder locations come from `env` (normally process.env), so tests can point them at a sandbox. */
function homeOf(env) { return env.USERPROFILE || env.HOME || os.homedir() }
function tempOf(env) { return (process.platform === 'win32' ? env.TEMP || env.TMP : env.TMPDIR) || os.tmpdir() }

async function chromiumCaches(userData) {
  const roots = []
  let entries = []
  try { entries = await fs.readdir(userData, { withFileTypes: true }) } catch { return roots }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+|Guest Profile)$/.test(entry.name)) continue
    for (const sub of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) {
      roots.push(target(path.join(userData, entry.name, sub)))
    }
  }
  return roots
}

async function firefoxCaches(profilesDir) {
  const roots = []
  let entries = []
  try { entries = await fs.readdir(profilesDir, { withFileTypes: true }) } catch { return roots }
  for (const entry of entries) if (entry.isDirectory()) roots.push(target(path.join(profilesDir, entry.name, 'cache2')))
  return roots
}

/** The browsers whose caches can be cleaned on this platform. */
async function browsers(env) {
  const home = homeOf(env)
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      { name: 'Google Chrome', processes: ['chrome.exe'], targets: await chromiumCaches(path.join(local, 'Google', 'Chrome', 'User Data')) },
      { name: 'Microsoft Edge', processes: ['msedge.exe'], targets: await chromiumCaches(path.join(local, 'Microsoft', 'Edge', 'User Data')) },
      { name: 'Brave', processes: ['brave.exe'], targets: await chromiumCaches(path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')) },
      { name: 'Firefox', processes: ['firefox.exe'], targets: await firefoxCaches(path.join(local, 'Mozilla', 'Firefox', 'Profiles')) },
    ]
  }
  if (process.platform === 'darwin') {
    const caches = path.join(home, 'Library', 'Caches')
    return [
      { name: 'Google Chrome', processes: ['google chrome'], targets: [target(path.join(caches, 'Google', 'Chrome'))] },
      { name: 'Microsoft Edge', processes: ['microsoft edge'], targets: [target(path.join(caches, 'Microsoft Edge'))] },
      { name: 'Brave', processes: ['brave browser'], targets: [target(path.join(caches, 'BraveSoftware', 'Brave-Browser'))] },
      { name: 'Firefox', processes: ['firefox'], targets: await firefoxCaches(path.join(caches, 'Firefox', 'Profiles')) },
      { name: 'Safari', processes: ['safari'], targets: [target(path.join(caches, 'com.apple.Safari'))] },
    ]
  }
  return []
}

/** The cleaning categories for this platform, with their root folders. */
async function categoryDefinitions(env) {
  const home = homeOf(env)
  const temp = tempOf(env)
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const windir = env.SystemRoot || 'C:\\Windows'
    const programData = env.ProgramData || 'C:\\ProgramData'
    const sid = await windowsSid()
    const recycleRoots = []
    if (sid) {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\$Recycle.Bin\\${sid}`
        if (await exists(root)) recycleRoots.push(target(root, { prune: true, keep: ['desktop.ini'] }))
      }
    }
    return [
      { id: 'temp', label: 'Temporary files', description: 'Files programs and Windows left in temp folders. Only files older than a day are removed.', defaultOn: true,
        targets: [...new Set([temp, path.join(windir, 'Temp')])].map((root) => target(root, { minAgeMs: DAY, prune: true })) },
      { id: 'recycle', label: 'Recycle Bin', description: 'Files you deleted earlier. Emptying it cannot be undone, so check it first.', defaultOn: false, targets: recycleRoots },
      { id: 'browser', label: 'Browser caches', description: 'Cached web pages and images. Passwords, cookies, history and bookmarks are never touched.', defaultOn: true, browsers: true },
      { id: 'crash', label: 'Crash reports and update leftovers', description: 'Crash dumps, Windows error reports and old Windows Update downloads.', defaultOn: true,
        targets: [
          target(path.join(local, 'CrashDumps')),
          target(path.join(local, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), { prune: true }),
          target(path.join(local, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), { prune: true }),
          target(path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), { prune: true }),
          target(path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), { prune: true }),
          // An update in progress uses this folder, so only old downloads go.
          target(path.join(windir, 'SoftwareDistribution', 'Download'), { minAgeMs: 10 * DAY, prune: true }),
        ] },
      { id: 'thumbnails', label: 'Thumbnail cache', description: 'Picture previews File Explorer saves. Windows rebuilds them when needed.', defaultOn: true,
        targets: [target(path.join(local, 'Microsoft', 'Windows', 'Explorer'), { match: (name) => /^thumbcache_.*\.db$/i.test(name) })] },
    ]
  }
  if (process.platform === 'darwin') {
    return [
      { id: 'temp', label: 'Temporary files', description: 'Files apps left in your temporary folder. Only files older than a day are removed.', defaultOn: true,
        targets: [target(temp, { minAgeMs: DAY, prune: true })] },
      { id: 'recycle', label: 'Trash', description: 'Files you moved to the Trash. Emptying it cannot be undone, so check it first.', defaultOn: false,
        targets: [target(path.join(home, '.Trash'), { prune: true, keep: ['.DS_Store'] })] },
      { id: 'browser', label: 'Browser caches', description: 'Cached web pages and images. Passwords, cookies, history and bookmarks are never touched.', defaultOn: true, browsers: true },
      { id: 'crash', label: 'Crash reports and old logs', description: 'App crash reports, and log files older than a week.', defaultOn: true,
        targets: [
          target(path.join(home, 'Library', 'Logs', 'DiagnosticReports'), { prune: true }),
          target(path.join(home, 'Library', 'Logs'), { minAgeMs: 7 * DAY, skip: ['DiagnosticReports'] }),
        ] },
    ]
  }
  return [
    { id: 'temp', label: 'Temporary files', description: 'Files programs left in your temporary folder. Only files older than a day are removed.', defaultOn: true,
      targets: [target(temp, { minAgeMs: DAY, prune: true })] },
  ]
}

/** "Close Google Chrome and Firefox to clean their caches." or null. */
function openBrowsersNote(names) {
  if (!names.length) return null
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `Close ${list} to clean ${names.length > 1 ? 'their caches' : 'its cache'}.`
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export class Cleaner {
  #gate = null
  #busy = false
  #cancelled = false
  #status = { state: 'idle', phase: null, current: null, analysis: null, lastClean: null }
  #protected
  #env

  #statePath

  constructor({ env = process.env } = {}) {
    this.#env = env
    // The last results survive a restart, so the dashboard can show how clean the PC is.
    this.#statePath = path.join(app.getPath('userData'), 'cleaner.json')
    try {
      const saved = JSON.parse(readFileSync(this.#statePath, 'utf8'))
      this.#status = { ...this.#status, analysis: saved.analysis || null, lastClean: saved.lastClean || null }
    } catch { /* first run */ }
    // Aegis's own data: settings, history, quarantine, licence cache.
    this.#protected = [app.getPath('userData'), path.dirname(app.getPath('exe'))].map((dir) => path.resolve(dir))
  }

  setGate(gate) { this.#gate = typeof gate === 'function' ? gate : null }
  getStatus() { return this.#status }
  isBusy() { return this.#busy }
  cancel() { if (this.#busy) this.#cancelled = true; return this.#status }

  #isProtected(candidate) {
    return this.#protected.some((dir) => candidate === dir || isInside(dir, candidate))
  }

  /** Every file under `t.root` that may be deleted, with its size. Missing or unreadable folders give nothing. */
  async #collect(t, limit) {
    const files = []
    const dirs = []
    const now = Date.now()
    const stack = [path.resolve(t.root)]
    while (stack.length && files.length < limit) {
      if (this.#cancelled) break
      const dir = stack.pop()
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (this.#isProtected(full)) continue
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (t.skip.includes(entry.name) && dir === path.resolve(t.root)) continue
          stack.push(full)
          // Age is read now: deleting the files inside later makes the folder look new.
          try { dirs.push({ path: full, mtimeMs: (await fs.lstat(full)).mtimeMs }) } catch { /* gone */ }
          continue
        }
        if (t.keep.includes(entry.name) && dir === path.resolve(t.root)) continue
        if (t.match && !t.match(entry.name)) continue
        let stats
        try { stats = await fs.lstat(full) } catch { continue }
        if (t.minAgeMs && now - stats.mtimeMs < t.minAgeMs) continue
        files.push({ path: full, size: stats.isSymbolicLink() ? 0 : stats.size })
        if (files.length >= limit) break
      }
    }
    return { files, dirs }
  }

  async #collectTargets(targets) {
    let bytes = 0
    let count = 0
    for (const t of targets) {
      const { files } = await this.#collect(t, MAX_FILES_PER_CATEGORY - count)
      for (const file of files) bytes += file.size
      count += files.length
      if (count >= MAX_FILES_PER_CATEGORY) break
    }
    return { bytes, files: count }
  }

  /** Measures each category without deleting anything. */
  async analyze() {
    this.#begin('analyzing')
    try {
      const running = await runningProcesses()
      const categories = []
      for (const definition of await categoryDefinitions(this.#env)) {
        if (this.#cancelled) break
        this.#progress(definition.label)
        if (definition.browsers) {
          const parts = []
          for (const browser of await browsers(this.#env)) {
            if (!browser.targets.length) continue
            const measured = await this.#collectTargets(browser.targets)
            if (!measured.files) continue
            parts.push({ name: browser.name, ...measured, running: browser.processes.some((name) => running.has(name)) })
          }
          const ready = parts.filter((part) => !part.running)
          categories.push({
            id: definition.id, label: definition.label, description: definition.description, defaultOn: definition.defaultOn,
            bytes: ready.reduce((sum, part) => sum + part.bytes, 0),
            files: ready.reduce((sum, part) => sum + part.files, 0),
            parts,
            note: openBrowsersNote(parts.filter((part) => part.running).map((part) => part.name)),
          })
          continue
        }
        const measured = await this.#collectTargets(definition.targets)
        categories.push({ id: definition.id, label: definition.label, description: definition.description, defaultOn: definition.defaultOn, ...measured, note: null })
      }
      const analysis = { at: new Date().toISOString(), categories, totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0), cancelled: this.#cancelled }
      this.#finish({ analysis })
      return analysis
    } catch (error) {
      this.#finish({})
      throw error
    }
  }

  /**
   * Deletes the junk in the chosen categories. Everything is found again here,
   * so nothing from an old analysis is trusted.
   */
  async clean(categoryIds) {
    const wanted = new Set(Array.isArray(categoryIds) ? categoryIds.filter((id) => typeof id === 'string') : [])
    if (!wanted.size) throw new Error('Choose at least one category to clean.')
    this.#begin('cleaning')
    const result = { at: new Date().toISOString(), freedBytes: 0, deleted: 0, skipped: 0, skippedBrowsers: [], categories: {} }
    try {
      const running = await runningProcesses()
      for (const definition of await categoryDefinitions(this.#env)) {
        if (this.#cancelled || !wanted.has(definition.id)) continue
        this.#progress(definition.label)
        let targets = definition.targets || []
        if (definition.browsers) {
          targets = []
          for (const browser of await browsers(this.#env)) {
            if (browser.processes.some((name) => running.has(name))) { if (browser.targets.length) result.skippedBrowsers.push(browser.name); continue }
            targets.push(...browser.targets)
          }
        }
        const summary = { freedBytes: 0, deleted: 0, skipped: 0 }
        for (const t of targets) {
          if (this.#cancelled) break
          await this.#cleanTarget(t, summary)
        }
        result.categories[definition.id] = summary
        result.freedBytes += summary.freedBytes
        result.deleted += summary.deleted
        result.skipped += summary.skipped
      }
      result.cancelled = this.#cancelled
      // Measure again, so the page shows what is left.
      this.#finish({ lastClean: result, analysis: null })
      return result
    } catch (error) {
      this.#finish({})
      throw error
    }
  }

  async #cleanTarget(t, summary) {
    const root = path.resolve(t.root)
    const { files, dirs } = await this.#collect(t, MAX_FILES_PER_CATEGORY)
    for (const file of files) {
      if (this.#cancelled) return
      // Re-check right before deleting: still inside the root, not Aegis's own data.
      if (!isInside(root, file.path) || this.#isProtected(file.path)) { summary.skipped += 1; continue }
      try {
        const stats = await fs.lstat(file.path)
        if (stats.isDirectory()) { summary.skipped += 1; continue }
        await fs.unlink(file.path)
        summary.freedBytes += stats.isSymbolicLink() ? 0 : stats.size
        summary.deleted += 1
      } catch {
        // In use, read-only or not ours (for example another user's temp file).
        summary.skipped += 1
      }
      if ((summary.deleted + summary.skipped) % 200 === 0) this.#progress(null, summary)
    }
    if (!t.prune) return
    // Remove folders left empty, deepest first; rmdir refuses anything not empty.
    const now = Date.now()
    for (const dir of dirs.sort((a, b) => b.path.length - a.path.length)) {
      if (!isInside(root, dir.path) || this.#isProtected(dir.path)) continue
      // A folder a program created recently may be about to be used, even if empty.
      if (t.minAgeMs && now - dir.mtimeMs < t.minAgeMs) continue
      try { await fs.rmdir(dir.path) } catch { /* not empty, in use or not ours */ }
    }
  }

  #begin(state) {
    if (this.#gate && !this.#gate()) throw new Error('PC Cleaner needs an active licence. Activate a licence on the Licence page.')
    if (this.#busy) throw new Error('PC Cleaner is already working. Wait for it to finish.')
    this.#busy = true
    this.#cancelled = false
    this.#status = { ...this.#status, state, current: null, progress: null }
    this.#publish()
  }

  #progress(current, progress = null) {
    this.#status = { ...this.#status, ...(current ? { current } : {}), progress }
    this.#publish()
  }

  #finish(patch) {
    this.#busy = false
    this.#status = { ...this.#status, ...patch, state: 'idle', current: null, progress: null }
    try { writeFileSync(this.#statePath, JSON.stringify({ analysis: this.#status.analysis, lastClean: this.#status.lastClean })) } catch { /* not critical */ }
    this.#publish()
  }

  #publish() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('cleaner:update', this.#status) }
}
