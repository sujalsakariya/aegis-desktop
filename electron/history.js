import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_EVENTS = 200
const MAX_UPDATE_LOG = 50
const RETAINED_DAYS = 60

function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function titleCase(value) {
  const text = String(value || '')
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

function emptyData() {
  return {
    totals: { filesScanned: 0, threatsDetected: 0, scansRun: 0, quarantined: 0 },
    daily: {},
    events: [],
    lastScan: null,
    /** When a full device scan (not a removable-drive scan) last finished without being cancelled or failing. */
    lastCompletedScanAt: null,
    definitions: null,
    updateLog: [],
  }
}

/**
 * Records what this device has actually done: scan results, detections,
 * definition installs and removable-drive activity. Written as plain JSON in
 * userData because none of it is secret, and so a missing OS keyring cannot
 * stop the app from starting.
 */
export class HistoryStore {
  #path = path.join(app.getPath('userData'), 'history.json')
  #data = emptyData()
  #writing = Promise.resolve()

  async initialize() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#path, 'utf8'))
      this.#data = {
        ...emptyData(),
        ...parsed,
        totals: { ...emptyData().totals, ...(parsed.totals || {}) },
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
        events: Array.isArray(parsed.events) ? parsed.events : [],
        updateLog: Array.isArray(parsed.updateLog) ? parsed.updateLog.slice(0, MAX_UPDATE_LOG) : [],
      }
      this.#prune()
    } catch {
      this.#data = emptyData()
    }
  }

  /** Renderer-shaped summary. `days` columns, oldest first, gaps filled. */
  getSummary(days = 14) {
    const daily = []
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const timestamp = Date.now() - offset * 86400000
      const key = dayKey(timestamp)
      const entry = this.#data.daily[key]
      daily.push({
        date: new Date(timestamp).toISOString(),
        filesScanned: entry?.filesScanned || 0,
        threats: entry?.threats || 0,
      })
    }

    return {
      totals: { ...this.#data.totals },
      lastScan: this.#data.lastScan,
      // History saved by older versions has no lastCompletedScanAt; its last scan still counts if it completed.
      lastCompletedScanAt: this.#data.lastCompletedScanAt
        || (this.#data.lastScan?.state === 'completed' && this.#data.lastScan.source !== 'usb' ? this.#data.lastScan.finishedAt : null),
      definitions: this.#data.definitions,
      daily,
      events: this.#data.events.slice(0, 25),
      hasHistory: this.#data.totals.scansRun > 0 || this.#data.events.length > 0,
    }
  }

  /** Called once a scan reaches a terminal state. */
  async recordScan(status) {
    if (!status || !['completed', 'cancelled', 'failed'].includes(status.state)) return
    const files = Number(status.filesScanned) || 0
    const threats = Number(status.threatsDetected) || 0

    this.#data.totals.scansRun += 1
    this.#data.totals.filesScanned += files
    this.#data.totals.threatsDetected += threats

    const key = dayKey()
    const day = this.#data.daily[key] || { filesScanned: 0, threats: 0 }
    day.filesScanned += files
    day.threats += threats
    this.#data.daily[key] = day

    const quarantined = Number(status.quarantined) || 0
    if (status.state === 'completed' && status.source !== 'usb') this.#data.lastCompletedScanAt = new Date().toISOString()
    this.#data.lastScan = {
      mode: status.mode,
      source: status.source || null,
      quarantined,
      state: status.state,
      filesScanned: files,
      threatsDetected: threats,
      elapsedMs: Number(status.elapsedMs) || 0,
      finishedAt: new Date().toISOString(),
      error: status.error || null,
    }

    const label = status.source === 'scheduled' ? `Scheduled ${status.mode || 'quick'}` : status.source === 'startup' ? `Startup ${status.mode || 'quick'}` : status.source === 'usb' ? 'Removable drive' : status.mode || 'Scan'
    const summary =
      status.state === 'failed'
        ? `${titleCase(label)} scan failed. ${status.error || 'No further detail.'}`
        : status.state === 'cancelled'
          ? `${titleCase(label)} scan cancelled after ${files.toLocaleString('en-US')} items.`
          : `${titleCase(label)} scan completed. ${files.toLocaleString('en-US')} items checked, ${threats} threat(s) found${threats ? `, ${quarantined} quarantined` : ''}.`

    this.#push(status.state === 'failed' ? 'bad' : threats > 0 ? 'warn' : 'ok', summary)
    await this.#save()
  }

  /**
   * `countThreat: false` is used for scan detections, whose threat totals are
   * added by recordScan when the scan ends.
   */
  async recordDetection(filePath, threatName, quarantined, { countThreat = true } = {}) {
    if (quarantined) this.#data.totals.quarantined += 1
    if (countThreat) {
      this.#data.totals.threatsDetected += 1
      const key = dayKey()
      const day = this.#data.daily[key] || { filesScanned: 0, threats: 0 }
      day.threats += 1
      this.#data.daily[key] = day
    }
    this.#push('bad', `${threatName || 'Threat'} ${quarantined ? 'quarantined from' : 'detected in'} ${path.basename(filePath || '')}.`)
    await this.#save()
  }

  async recordDefinitions(release, signatureCount) {
    this.#data.definitions = {
      version: release?.version || null,
      installedAt: new Date().toISOString(),
      publishedAt: release?.publishedAt || null,
      sha256: release?.sha256 || null,
      signatureCount: Number.isFinite(signatureCount) ? signatureCount : null,
    }
    this.#push('ok', `Threat signatures updated to version ${release?.version || 'a new release'}.`)
    await this.#save()
  }

  getUpdateLog() { return this.#data.updateLog.map((entry) => ({ ...entry })) }

  /** Keeps the last few update events so the Updates log survives a restart. */
  async recordUpdateEvent(event) {
    if (!event || typeof event !== 'object') return
    this.#data.updateLog.unshift({ ...event, at: event.at || new Date().toISOString() })
    if (this.#data.updateLog.length > MAX_UPDATE_LOG) this.#data.updateLog.length = MAX_UPDATE_LOG
    await this.#save()
  }

  async recordEvent(tone, text) {
    this.#push(tone, text)
    await this.#save()
  }

  #push(tone, text) {
    this.#data.events.unshift({ tone, text, at: new Date().toISOString() })
    if (this.#data.events.length > MAX_EVENTS) this.#data.events.length = MAX_EVENTS
  }

  #prune() {
    const cutoff = dayKey(Date.now() - RETAINED_DAYS * 86400000)
    for (const key of Object.keys(this.#data.daily)) {
      if (key < cutoff) delete this.#data.daily[key]
    }
  }

  #save() {
    this.#writing = this.#writing.then(async () => {
      try {
        const temporary = `${this.#path}.tmp`
        await fs.writeFile(temporary, JSON.stringify(this.#data), { mode: 0o600 })
        await fs.rename(temporary, this.#path)
      } catch {
        /* History is best-effort; never let a write failure break a scan. */
      }
    })
    return this.#writing
  }
}
