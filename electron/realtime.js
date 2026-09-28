import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class RealtimeProtection {
  #scanner
  #quarantine
  #watchers = []
  #status = { running: false, lastEvent: null, detections: 0, error: null }
  #pending = new Map()
  #active = new Set()
  #listeners = new Set()

  constructor(scanner, quarantine) { this.#scanner = scanner; this.#quarantine = quarantine }
  getStatus() { return this.#status }

  /** Fires when a watched file matched a signature. Returns an unsubscribe. */
  onDetection(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  start() {
    if (this.#status.running) return this.#status
    // A fresh start clears any error left over from a previous run.
    let error = null
    const paths = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents')]
    for (const watchedPath of paths) {
      try {
        const watcher = fs.watch(watchedPath, { recursive: true }, (_eventType, filename) => { if (filename) this.#queue(path.join(watchedPath, filename)) })
        watcher.on('error', () => {})
        this.#watchers.push(watcher)
      } catch (caught) { error = caught instanceof Error ? caught.message : 'Unable to start realtime protection.' }
    }
    this.#status = { ...this.#status, running: this.#watchers.length > 0, error }
    this.#publish()
    return this.#status
  }

  stop() { for (const watcher of this.#watchers) watcher.close(); for (const timer of this.#pending.values()) clearTimeout(timer); this.#pending.clear(); this.#watchers = []; this.#status = { ...this.#status, running: false }; this.#publish(); return this.#status }

  #queue(filePath) {
    if (this.#pending.has(filePath)) clearTimeout(this.#pending.get(filePath))
    this.#pending.set(filePath, setTimeout(() => { this.#pending.delete(filePath); this.#inspect(filePath) }, 500))
  }

  async #inspect(filePath) {
    if (this.#active.has(filePath)) return
    // User exclusions apply to real-time protection as well as scans.
    if (this.#scanner.exclusionMatcher()(filePath)) return
    this.#active.add(filePath)
    try {
      const result = await this.#scanner.inspectFile(filePath)
      this.#status = { ...this.#status, lastEvent: { filePath, detected: result.detected, at: new Date().toISOString() }, detections: this.#status.detections + (result.detected ? 1 : 0) }
      if (result.detected) {
        const threatName = result.definition?.threatName || 'Detected threat'
        const severity = String(result.definition?.severity || 'high')
        let quarantined = false
        try { await this.#quarantine.quarantine(filePath, threatName); quarantined = true } catch (error) { this.#status = { ...this.#status, error: error instanceof Error ? error.message : 'Unable to quarantine detected file.' } }
        for (const listener of this.#listeners) { try { listener({ filePath, threatName, severity, quarantined }) } catch { /* A listener must never break protection. */ } }
      }
      this.#publish()
    } finally { this.#active.delete(filePath) }
  }

  #publish() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('realtime:update', this.#status) }
}
