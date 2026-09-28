import { app, shell } from 'electron'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'

const API_URL = process.env.LICENSE_API_URL || 'http://localhost:3001'
const PUBLIC_KEY = process.env.DEFINITION_SIGNING_PUBLIC_KEY || ''
const MAX_DEFINITION_BYTES = 256 * 1024 * 1024
const MIN_APP_VERSION = process.env.MIN_APP_VERSION || '0.0.0'
const REQUEST_TIMEOUT_MS = 15000

function decodePublicKey(value) { return Buffer.from(value, 'base64').toString('utf8') }
function verifyMetadata(payload, signature) {
  if (!PUBLIC_KEY || !payload || typeof signature !== 'string') return false
  try { return crypto.verify(null, Buffer.from(JSON.stringify(payload)), decodePublicKey(PUBLIC_KEY), Buffer.from(signature, 'base64url')) } catch { return false }
}

/** fetch with a hard timeout and a readable message when the server is unreachable. */
async function request(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`The update server did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`)
    throw new Error("Could not reach the Aegis update server. Check your internet connection and try again.")
  }
}

/** Parses a JSON body without ever surfacing a raw SyntaxError. */
async function readJson(response, what) {
  const text = await response.text().catch(() => '')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    if (!response.ok) throw new Error(`${what} unavailable (HTTP ${response.status}).`)
    throw new Error(`${what}: the server sent a response that is not valid JSON.`)
  }
}

/** Validates a downloaded definitions package before it replaces the installed one. */
export function parseDefinitions(buffer) {
  let parsed
  try { parsed = JSON.parse(buffer.toString('utf8')) } catch { throw new Error('The downloaded definitions are not valid JSON. The installed definitions were kept.') }
  if (!Array.isArray(parsed)) throw new Error('The downloaded definitions are not a list of signatures. The installed definitions were kept.')
  const bad = parsed.findIndex((item) => !item || typeof item !== 'object' || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256))
  if (bad !== -1) throw new Error(`Signature ${bad + 1} in the downloaded definitions has no valid sha256 hash. The installed definitions were kept.`)
  return parsed
}

export class UpdateManager {
  #scanner
  #definitionsPath
  #metaPath
  #listeners = new Set()
  #eventListeners = new Set()
  #meta = null
  #latestApplication = null
  #installing = null

  constructor(scanner) {
    this.#scanner = scanner
    this.#definitionsPath = path.join(app.getPath('userData'), 'definitions.json')
    this.#metaPath = path.join(app.getPath('userData'), 'definitions-meta.json')
  }

  /** Loads the installed-definitions record kept next to definitions.json. */
  async initialize({ fallback = null } = {}) {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#metaPath, 'utf8'))
      this.#meta = parsed && typeof parsed === 'object' ? parsed : null
    } catch { this.#meta = null }
    // Installs from before this record existed: trust the history entry while
    // the definitions file itself is still present.
    if (!this.#meta && fallback?.version && this.#scanner.getDefinitionCount() > 0) this.#meta = { ...fallback }
  }

  /** Installed definitions (version, installedAt, sha256, signatureCount) or null. */
  getInstalled() { return this.#meta ? { ...this.#meta } : null }

  onInstalled(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  /** Every update result worth logging: installs, failures, application checks. */
  onEvent(listener) { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener) }

  #assertDownloadUrl(value) { const url = new URL(value); const configured = new URL(API_URL); if (url.protocol !== 'https:' && configured.protocol !== 'http:') throw new Error('Unsigned update transport'); if (url.origin !== configured.origin) throw new Error('Untrusted update origin'); return url }

  /**
   * The latest release on the server, compared with what is installed. When
   * nothing is published (404) the installed definitions are simply current:
   * { noRelease: true, upToDate: true }. Only a PC with no definitions at all
   * treats that as an error, since it then cannot detect anything.
   */
  async checkDefinitions() {
    const response = await request(`${API_URL}/api/definitions/latest`)
    const body = await readJson(response, 'Definition metadata')
    if (response.status === 404) {
      const installedVersion = this.#meta?.version || null
      if (!installedVersion || this.#scanner.getDefinitionCount() === 0) throw new Error('No threat definitions have been published on the update server yet, so none could be installed. Please contact support.')
      return { noRelease: true, version: installedVersion, installedVersion, upToDate: true }
    }
    if (!response.ok) throw new Error(body.error || `Definition metadata unavailable (HTTP ${response.status}).`)
    if (!body.release || typeof body.release !== 'object') throw new Error('The server returned no definition release.')
    if (!verifyMetadata({ version: body.release.version, downloadUrl: body.release.downloadUrl, sha256: body.release.sha256 }, body.release.signature)) throw new Error('Definition signature verification failed')
    const installedVersion = this.#meta?.version || null
    return { ...body.release, installedVersion, upToDate: Boolean(installedVersion && installedVersion === body.release.version && this.#scanner.getDefinitionCount() > 0) }
  }

  /**
   * Single-flight: concurrent callers share one download instead of racing on
   * the same file. Skips the download when the installed version already
   * matches the server, unless `force` is set.
   */
  updateDefinitions({ force = false, background = false } = {}) {
    if (!this.#installing) {
      this.#installing = this.#installDefinitions({ force, background })
        .catch((error) => {
          this.#emit({ type: 'definitions-failed', error: error instanceof Error ? error.message : String(error), background })
          throw error
        })
        .finally(() => { this.#installing = null })
    }
    return this.#installing
  }

  async #installDefinitions({ force, background }) {
    const release = await this.checkDefinitions()
    if (release.noRelease && force) throw new Error('The update server has no published release to reinstall. Your installed definitions were kept.')
    if (release.upToDate && !force) {
      this.#emit({ type: 'definitions-current', version: release.version, background })
      return { ...release, alreadyInstalled: true }
    }
    this.#assertDownloadUrl(release.downloadUrl)
    const response = await request(release.downloadUrl)
    if (!response.ok) throw new Error(`Definition download failed (HTTP ${response.status}).`)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_DEFINITION_BYTES) throw new Error('Definition package is too large')
    const data = Buffer.from(await response.arrayBuffer())
    if (data.byteLength > MAX_DEFINITION_BYTES) throw new Error('Definition package is too large')
    const checksum = crypto.createHash('sha256').update(data).digest('hex')
    if (checksum.toLowerCase() !== String(release.sha256).toLowerCase()) throw new Error('Definition checksum verification failed')
    // Validate before touching the installed file: a bad package keeps the old one.
    const definitions = parseDefinitions(data)
    const tempPath = `${this.#definitionsPath}.tmp`
    await fs.writeFile(tempPath, data, { mode: 0o600 })
    await fs.rename(tempPath, this.#definitionsPath)
    await this.#scanner.initialize()
    const signatureCount = this.#scanner.getDefinitionCount?.() ?? definitions.length
    this.#meta = { version: release.version, installedAt: new Date().toISOString(), publishedAt: release.publishedAt || null, sha256: release.sha256, signatureCount }
    try {
      const metaTemp = `${this.#metaPath}.tmp`
      await fs.writeFile(metaTemp, JSON.stringify(this.#meta), { mode: 0o600 })
      await fs.rename(metaTemp, this.#metaPath)
    } catch { /* The definitions are installed; only the version record failed. */ }
    for (const listener of this.#listeners) { try { listener(release, signatureCount) } catch { /* ignore */ } }
    this.#emit({ type: 'definitions-updated', version: release.version, signatureCount, background })
    return { ...release, installedVersion: release.version, upToDate: true, alreadyInstalled: false, signatureCount }
  }

  /**
   * Resolves to { updateAvailable, currentVersion, latestVersion, release }.
   * "Nothing newer" and "no release published" (404) are normal results.
   */
  async checkApplication(platform = process.platform, architecture = process.arch) {
    try {
      const result = await this.#checkApplication(platform, architecture)
      this.#emit({ type: 'application-checked', updateAvailable: result.updateAvailable, latestVersion: result.latestVersion, currentVersion: result.currentVersion })
      return result
    } catch (error) {
      this.#emit({ type: 'application-check-failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async #checkApplication(platform, architecture) {
    const currentVersion = MIN_APP_VERSION
    this.#latestApplication = null
    const response = await request(`${API_URL}/api/updates/latest?platform=${encodeURIComponent(platform)}&architecture=${encodeURIComponent(architecture)}`)
    if (response.status === 404) return { updateAvailable: false, currentVersion, latestVersion: null, release: null }
    const body = await readJson(response, 'Application update metadata')
    if (!response.ok) throw new Error(body.error || `Application update metadata unavailable (HTTP ${response.status}).`)
    const release = body.release
    if (!release || typeof release !== 'object' || typeof release.version !== 'string') return { updateAvailable: false, currentVersion, latestVersion: null, release: null }
    if (!this.#isNewerVersion(release.version, currentVersion)) return { updateAvailable: false, currentVersion, latestVersion: release.version, release: null }
    const payload = { version: release.version, platform: release.platform, architecture: release.architecture, downloadUrl: release.downloadUrl, sha256: release.sha256, releaseNotes: release.releaseNotes }
    if (!verifyMetadata(payload, release.signature)) throw new Error('Application update signature verification failed')
    this.#assertOpenableUrl(release.downloadUrl)
    this.#latestApplication = release
    return { updateAvailable: true, currentVersion, latestVersion: release.version, release }
  }

  /** Opens the verified release's download page in the default browser. */
  async openApplicationDownload() {
    if (!this.#latestApplication) throw new Error('Check for an application update first.')
    const url = this.#assertOpenableUrl(this.#latestApplication.downloadUrl)
    await shell.openExternal(url.toString())
    return { opened: true, url: url.toString() }
  }

  /** Only https: links, or links on the configured API origin, are opened. */
  #assertOpenableUrl(value) {
    let url
    try { url = new URL(value) } catch { throw new Error('The release has an invalid download link.') }
    if (url.protocol === 'https:' || url.origin === new URL(API_URL).origin) return url
    throw new Error('The release download link is not secure, so it was not opened.')
  }

  #emit(event) {
    const stamped = { ...event, at: new Date().toISOString() }
    for (const listener of this.#eventListeners) { try { listener(stamped) } catch { /* ignore */ } }
  }

  #isNewerVersion(candidate, current) { const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0); const next = parse(candidate); const installed = parse(current); for (let index = 0; index < Math.max(next.length, installed.length); index += 1) { if ((next[index] || 0) !== (installed[index] || 0)) return (next[index] || 0) > (installed[index] || 0) } return false }
}
