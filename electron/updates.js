import { shell } from 'electron'
import crypto from 'node:crypto'

const API_URL = process.env.LICENSE_API_URL || 'http://localhost:3001'
const PUBLIC_KEY = process.env.DEFINITION_SIGNING_PUBLIC_KEY || ''
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

/** Signature set version as shown to the user ("28143"). */
function label(version) { return Number.isFinite(version) ? String(version) : null }

/**
 * Threat signatures come from the engine's official signature mirrors (via the
 * bundled updater); application builds come from the Aegis server.
 * Event types stay the same as before: definitions-updated / -current / -failed.
 */
export class UpdateManager {
  #engine
  #listeners = new Set()
  #eventListeners = new Set()
  #latestApplication = null
  #installing = null

  constructor(engine) {
    this.#engine = engine
  }

  async initialize() {}

  /** Installed signatures (version, installedAt, signatureCount) or null. */
  getInstalled() {
    const info = this.#engine.getInfo()
    return info.ready ? { version: label(info.version), installedAt: info.updatedAt, publishedAt: info.buildTime, signatureCount: info.signatures } : null
  }

  onInstalled(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  /** Every update result worth logging: installs, failures, application checks. */
  onEvent(listener) { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener) }

  /** The newest published signature version compared with what is installed. */
  async checkDefinitions() {
    const info = this.#engine.getInfo()
    const latest = await this.#engine.latestVersion()
    const installedVersion = info.ready ? label(info.version) : null
    return {
      version: latest ? label(latest.daily) : installedVersion,
      publishedAt: latest?.publishedAt || null,
      installedVersion,
      signatureCount: info.signatures,
      upToDate: Boolean(info.ready && (!latest || latest.daily <= info.version)),
      unknownLatest: !latest,
    }
  }

  /** Single-flight signature update; `force` is accepted for compatibility (freshclam decides). */
  updateDefinitions({ background = false } = {}) {
    if (!this.#installing) {
      this.#installing = this.#installDefinitions({ background })
        .catch((error) => {
          this.#emit({ type: 'definitions-failed', error: error instanceof Error ? error.message : String(error), background })
          throw error
        })
        .finally(() => { this.#installing = null })
    }
    return this.#installing
  }

  async #installDefinitions({ background }) {
    const { updated, info } = await this.#engine.update()
    const release = { version: label(info.version), publishedAt: info.buildTime }
    if (!updated) {
      this.#emit({ type: 'definitions-current', version: release.version, background })
      return { ...release, installedVersion: release.version, upToDate: true, alreadyInstalled: true, signatureCount: info.signatures }
    }
    for (const listener of this.#listeners) { try { listener(release, info.signatures) } catch { /* ignore */ } }
    this.#emit({ type: 'definitions-updated', version: release.version, signatureCount: info.signatures, background })
    return { ...release, installedVersion: release.version, upToDate: true, alreadyInstalled: false, signatureCount: info.signatures }
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
