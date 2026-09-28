import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)

/** Windows: drive letters such as "E:". macOS: mounted volume folders such as "/Volumes/USB". */
async function listRemovableDrives() {
  if (process.platform === 'darwin') {
    const entries = await fs.readdir('/Volumes', { withFileTypes: true })
    // The startup disk appears as a link back to "/"; everything else is an attached volume.
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join('/Volumes', entry.name))
  }
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object -ExpandProperty DeviceID"], { windowsHide: true })
  return stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

const drivePath = (drive) => (process.platform === 'win32' ? `${drive}\\` : drive)

export class UsbMonitor {
  #timer = null
  #known = new Set()
  #seeded = false
  // Drives that appeared while another scan was running; scanned once it ends.
  #queued = new Set()
  #status = { supported: process.platform === 'win32' || process.platform === 'darwin', running: false, devices: [], queued: [], error: null }
  #settings
  #scanner
  #listeners = new Set()

  constructor(settings, scanner) {
    this.#settings = settings
    this.#scanner = scanner
    scanner.onStatus((status) => {
      if (['completed', 'cancelled', 'failed'].includes(status?.state) && this.#queued.size) setTimeout(() => this.#drain(), 0)
    })
  }

  getStatus() { return this.#status }

  /** Fires with the drive letters that just appeared. Returns an unsubscribe. */
  onInsert(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  start() {
    if (!this.#status.supported || this.#timer) return this.#status
    this.#status = { ...this.#status, running: true, error: null }
    // Drives already connected when monitoring starts are not "inserted": the
    // first poll only records them.
    this.#seeded = false
    this.#timer = setInterval(() => this.#poll(), 15000)
    this.#poll()
    this.#publish()
    return this.#status
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#queued.clear()
    this.#status = { ...this.#status, running: false, queued: [] }
    this.#publish()
    return this.#status
  }

  async #poll() {
    try {
      const devices = await listRemovableDrives()
      if (!this.#timer) return
      const inserted = this.#seeded ? devices.filter((device) => !this.#known.has(device)) : []
      this.#seeded = true
      this.#known = new Set(devices)
      // Forget queued drives that were removed before they could be scanned.
      for (const drive of [...this.#queued]) if (!this.#known.has(drive)) this.#queued.delete(drive)
      this.#status = { ...this.#status, devices, error: null }
      if (inserted.length) for (const listener of this.#listeners) { try { listener(inserted) } catch { /* ignore */ } }
      if (inserted.length && this.#settings.get().usbProtection) for (const drive of inserted) this.#queued.add(drive)
      await this.#drain()
    } catch {
      this.#status = { ...this.#status, error: 'Unable to query removable drives.' }
    }
    this.#publish()
  }

  async #drain() {
    if (!this.#queued.size || !this.#timer) { this.#status = { ...this.#status, queued: [...this.#queued] }; return }
    if (!this.#scanner.isBusy()) {
      const drives = [...this.#queued]
      try {
        await this.#scanner.start({ mode: 'custom', paths: drives.map(drivePath), trusted: true, source: 'usb' })
        for (const drive of drives) this.#queued.delete(drive)
      } catch (error) {
        // Busy (another scan won the race) keeps the queue; anything else drops it.
        if (!this.#scanner.isBusy()) {
          this.#queued.clear()
          this.#status = { ...this.#status, error: error instanceof Error ? error.message : 'Unable to scan the removable drive.' }
        }
      }
    }
    this.#status = { ...this.#status, queued: [...this.#queued] }
    this.#publish()
  }

  #publish() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('usb:update', this.#status) }
}
