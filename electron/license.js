import { app, safeStorage } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID, verify } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The server is re-checked on every launch and then every 6 hours, so an admin
// suspending or revoking a licence reaches the device quickly. If the server is
// unreachable, the last signed licence keeps working for a 72 hour grace period.
const VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000
const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000
const API_URL = process.env.LICENSE_API_URL || 'http://localhost:3001'
const PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY || ''
const KEY_PATTERN = /^AVP-(?:[A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/i
/** Every request to the licence server gives up after this long instead of hanging. */
const REQUEST_TIMEOUT_MS = 15_000

/** Server error codes turned into sentences a customer can act on. */
const MESSAGES = {
  AUTH_REQUIRED: 'Enter your details on the Licence page first.',
  INVALID_INPUT: 'The request was rejected as invalid. Check the licence key and try again.',
  LICENSE_NOT_FOUND: 'This licence key does not exist. Check it for typos and try again.',
  LICENSE_IN_USE: 'This licence key is already registered to another account. A key can only be used by the account that activated it first.',
  LICENSE_EXPIRED: 'This licence has expired. Renew it to keep this device protected.',
  LICENSE_REVOKED: 'This licence has been revoked. Contact support if you think this is a mistake.',
  LICENSE_SUSPENDED: 'This licence is suspended. Contact support to reactivate it.',
  LICENSE_CANCELLED: 'This licence has been cancelled.',
  DEVICE_LIMIT_REACHED: 'This licence is already active on another PC. A licence works on one PC at a time: open Aegis on the other PC and choose "Deactivate this device" there, then activate it here.',
  DEVICE_NOT_ACTIVATED: 'This device was released from the licence on another device or by an administrator.',
}

function friendly(code, fallback) {
  if (typeof code !== 'string') return fallback
  // A 500 from the server: its generic message means nothing to a customer.
  if (code === 'Internal server error') return 'The Aegis server had a problem. Please try again in a few minutes, or contact support if it keeps happening.'
  return MESSAGES[code] || (/^[A-Z_]+$/.test(code) ? fallback : code)
}

function canonicalPayload(payload) {
  return JSON.stringify({
    expiresAt: payload.expiresAt,
    features: payload.features,
    issuedAt: payload.issuedAt,
    licenseId: payload.licenseId,
    maxDevices: payload.maxDevices,
    plan: payload.plan,
    status: payload.status,
  })
}

function decodePublicKey(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function isValidSignedLicense(signedLicense) {
  if (!signedLicense?.payload || typeof signedLicense.signature !== 'string' || !PUBLIC_KEY) return false
  const publicKey = decodePublicKey(PUBLIC_KEY)
  if (!publicKey || signedLicense.publicKey !== PUBLIC_KEY) return false
  try {
    return verify(null, Buffer.from(canonicalPayload(signedLicense.payload)), publicKey, Buffer.from(signedLicense.signature, 'base64url'))
  } catch {
    return false
  }
}

function isExpired(payload) {
  return Boolean(payload?.expiresAt && new Date(payload.expiresAt).getTime() <= Date.now())
}

/**
 * The id the first releases used. It was derived from the app-data folder, so
 * two PCs with the same Windows user name produced the same id and the server
 * saw them as one device. Kept only to move existing activations to machineId().
 */
function legacyDeviceId() {
  return createHash('sha256').update(`${process.platform}:${process.arch}:${app.getPath('userData')}`).digest('hex')
}

/** The operating system's own id for this installation of the OS, if it can be read. */
function osMachineGuid() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      return output.match(/MachineGuid\s+REG_\w+\s+([0-9a-f-]{16,})/i)?.[1] || null
    }
    if (process.platform === 'darwin') {
      const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 })
      return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || null
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { return readFileSync(file, 'utf8').trim() || null } catch { /* try the next one */ }
    }
  } catch { /* fall back to a stored random id */ }
  return null
}

let cachedMachineId

/**
 * Identifies this PC. Based on the OS machine GUID, so it is the same for every
 * Windows user and survives reinstalling Aegis, but differs between PCs. If the
 * GUID cannot be read, a random id is generated once and kept in app data.
 */
export function machineId() {
  if (cachedMachineId) return cachedMachineId
  let source = osMachineGuid()
  if (!source) {
    const file = path.join(app.getPath('userData'), 'device-id')
    try { source = readFileSync(file, 'utf8').trim() } catch { source = '' }
    if (!source) {
      source = randomUUID()
      try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, source) } catch { /* the id then lives for this session only */ }
    }
  }
  cachedMachineId = createHash('sha256').update(`aegis-device:${source}`).digest('hex')
  return cachedMachineId
}

function deviceDetails(id) {
  const name = (os.hostname() || `${process.platform} desktop`).slice(0, 200)
  return { deviceId: id, deviceName: name, platform: process.platform, architecture: process.arch, appVersion: app.getVersion() }
}

function pickAccount(user) {
  return { id: user.id, email: user.email, username: user.username || null, name: user.name || null, phone: user.phone || null, role: user.role }
}

export const LICENSED_STATES = ['active', 'offline-grace']

export class LicenseManager {
  #cachePath
  #cache = {}
  // 'checking' until initialize() has read the saved licence, so the window
  // (which now opens before the licence check) does not flash "no licence".
  #status = { state: 'checking', reason: 'Checking this device’s licence…' }
  #listeners = new Set()

  constructor() {
    this.#cachePath = path.join(app.getPath('userData'), 'license-cache.bin')
  }

  onChange(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  isLicensed() {
    return LICENSED_STATES.includes(this.#status.state)
  }

  get apiUrl() {
    return API_URL
  }

  get cookie() {
    return this.#cache.cookie || null
  }

  /**
   * The device id this licence seat was activated with. New activations use
   * machineId(); an install activated by an older release keeps its old id
   * until #migrateDeviceId() has moved the seat.
   */
  get #deviceId() {
    if (this.#cache.deviceId) return this.#cache.deviceId
    return this.#cache.licenseKey ? legacyDeviceId() : machineId()
  }

  async initialize() {
    await this.#loadCache()
    if (!PUBLIC_KEY) {
      this.#setStatus({ state: 'unlicensed', reason: 'This build has no licence public key, so licences cannot be verified. Rebuild the app with LICENSE_PUBLIC_KEY set.' })
      return this.#status
    }
    const signed = this.#cache.signedLicense
    if (!signed || !isValidSignedLicense(signed)) {
      // Keep the session and account: only the licence part is unusable.
      await this.#clearLicense()
      // A logged-in customer who owns a licence (for example one who logged in
      // before licences were restored at login) gets it back without the key.
      if (this.#cache.account && (await this.#restoreLicense()).restoredLicense) return this.#status
      this.#setStatus({ state: 'unlicensed', reason: 'No licence is activated on this device.' })
      return this.#status
    }
    this.#setStatus(isExpired(signed.payload)
      ? { state: 'expired', license: signed, lastValidatedAt: this.#cache.lastValidatedAt }
      : { state: 'active', license: signed, lastValidatedAt: this.#cache.lastValidatedAt })
    await this.#migrateDeviceId()
    await this.validate({ force: true })
    return this.#status
  }

  /**
   * Moves a seat taken with the old, collision-prone device id onto this PC's
   * machine id: release the old seat, then activate again with the same key.
   * Best effort; if the server is unreachable it is retried on the next launch.
   */
  async #migrateDeviceId() {
    const current = machineId()
    if (!this.#cache.licenseKey || !this.#cache.account || this.#cache.deviceId === current) return
    const oldId = this.#deviceId
    try {
      const released = await this.#request('/api/license/deactivate', { method: 'POST', body: { licenseKey: this.#cache.licenseKey, deviceId: oldId } })
      if (!released.ok && released.status !== 404) return
      const response = await this.#request('/api/license/activate', { method: 'POST', body: { licenseKey: this.#cache.licenseKey, ...deviceDetails(current) } })
      if (response.ok && isValidSignedLicense(response.body.license)) {
        this.#cache = { ...this.#cache, deviceId: current, signedLicense: response.body.license, lastValidatedAt: Date.now(), nextValidationAt: Date.now() + VALIDATION_INTERVAL_MS }
      } else {
        // The old seat is released either way; validate() with the new id then
        // reports the real state (for example "already active on another PC").
        this.#cache = { ...this.#cache, deviceId: current }
      }
      await this.#saveCache()
    } catch { /* offline: try again next launch */ }
  }

  getStatus() {
    return this.#status
  }

  /** The customer profile saved on this PC, re-confirmed with the server when it is reachable. */
  async getAccount() {
    if (!this.#cache.account) return null
    try {
      const response = await this.#request('/api/auth/me', { method: 'GET' })
      if (response.ok && response.body.user) {
        this.#cache.account = pickAccount(response.body.user)
        await this.#saveCache()
        return { ...this.#cache.account, offline: false }
      }
    } catch {
      // Server unreachable: fall back to the profile saved on this PC.
    }
    return this.#cache.account ? { ...this.#cache.account, offline: true } : null
  }

  /**
   * Opens this PC's customer, no password. With name and phone it registers a
   * new customer (or updates one whose email + username match); with only email
   * + username it logs a returning customer in and leaves their details as saved.
   */
  async saveProfile(profile) {
    const previous = this.#cache.account
    const account = await this.#openSession(profile)
    // A different customer on this PC must not inherit the previous one's licence.
    // The new session cannot release the old customer's seat, so it is only cleared here.
    if (previous && previous.id !== account.id && this.#cache.licenseKey) {
      await this.#clearLicense()
      this.#setStatus({ state: 'unlicensed', reason: 'The customer details changed. Activate a licence for this customer.' })
    }
    this.#cache = { ...this.#cache, account }
    await this.#saveCache()
    if (this.#cache.licenseKey && (!this.isLicensed() || this.#status.sessionExpired)) this.validate({ force: true }).catch(() => {})
    // A returning customer (after logging out, or a reinstall) gets their licence back without retyping the key.
    const restore = this.#cache.licenseKey ? {} : await this.#restoreLicense()
    return { ...account, offline: false, ...restore }
  }

  /**
   * Asks the server for a licence this customer already owns and activates it
   * on this PC. Best effort: any failure leaves the licence form for the key.
   */
  async #restoreLicense() {
    if (!PUBLIC_KEY) return {}
    try {
      const id = machineId()
      const response = await this.#request('/api/license/restore', { method: 'POST', body: deviceDetails(id) })
      if (response.status === 409 && response.body.error === 'DEVICE_LIMIT_REACHED') return { restoreNote: MESSAGES.DEVICE_LIMIT_REACHED }
      // Their licence was last used on another PC: only the key proves it is theirs here.
      if (response.status === 409 && response.body.error === 'KEY_REQUIRED') return { keyRequired: true }
      if (!response.ok) {
        // NO_LICENSE is the normal answer for a customer who has not bought one yet.
        if (response.body.error !== 'NO_LICENSE') console.warn(`[licence] restore failed: HTTP ${response.status} ${response.body.error || ''}`)
        return {}
      }
      if (!KEY_PATTERN.test(response.body.licenseKey || '') || !isValidSignedLicense(response.body.license)) {
        console.warn('[licence] restore returned a licence this app cannot verify (app and server keys differ?)')
        return {}
      }
      this.#cache = { ...this.#cache, licenseKey: response.body.licenseKey.toUpperCase(), deviceId: id, signedLicense: response.body.license, activatedAt: Date.now(), lastValidatedAt: Date.now(), nextValidationAt: Date.now() + VALIDATION_INTERVAL_MS }
      await this.#saveCache()
      this.#setStatus({ state: 'active', license: response.body.license, lastValidatedAt: this.#cache.lastValidatedAt })
      return { restoredLicense: true }
    } catch (error) {
      console.warn(`[licence] restore failed: ${error?.message || error}`)
      return {}
    }
  }

  /** Updates the name and phone of the saved customer. */
  async updateProfile({ name, phone }) {
    if (!this.#cache.account) throw new Error(MESSAGES.AUTH_REQUIRED)
    const response = await this.#request('/api/auth/me', { method: 'PATCH', body: { name, phone } })
    if (!response.ok || !response.body.user) throw new Error(friendly(response.body.error, 'Could not save your details.'))
    this.#cache.account = pickAccount(response.body.user)
    await this.#saveCache()
    return { ...this.#cache.account, offline: false }
  }

  /** Releases this device's seat (best effort) and forgets the customer, so someone else can register. */
  async logout() {
    if (this.#cache.licenseKey) {
      try { await this.deactivate() } catch { /* the server may be offline; the local licence is still cleared */ }
    }
    try { await this.#send('/api/auth/logout', { method: 'POST', body: {} }) } catch { /* ignore */ }
    await this.#clearLicense()
    await this.#forgetSession()
    this.#setStatus({ state: 'unlicensed', reason: 'Customer details removed. Enter your details and activate a licence to protect this device.' })
    return this.#status
  }

  /** Registers (name + phone given) or logs in (email + username only), and keeps the session cookie. */
  async #openSession({ username, name, email, phone }) {
    const [endpoint, payload] = name ? ['/api/auth/profile', { username, name, email, phone }] : ['/api/auth/customer-login', { username, email }]
    const body = await this.#postForSession(endpoint, payload, 'Could not save your details.')
    return pickAccount(body.user)
  }

  /** POSTs to a login endpoint, keeps the session cookie it sets, and returns the response body. */
  async #postForSession(endpoint, payload, fallbackError) {
    const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new Error('Cannot reach the Aegis server. Check your internet connection and try again.') })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.user) throw new Error(friendly(body.error, fallbackError))
    const cookie = (response.headers.getSetCookie?.() || []).map((value) => value.split(';', 1)[0]).join('; ')
    if (!cookie) throw new Error('The server did not start a session.')
    this.#cache.cookie = cookie
    return body
  }

  /**
   * Returning customer on a new PC: email + licence key prove who they are.
   * Logs in and activates the licence here in one step. If the licence cannot
   * be activated (suspended, expired, on another PC) they are still logged in
   * and `activationError` says why.
   */
  async keyLogin(email, licenseKey) {
    return this.#keySession('/api/auth/key-login', { email }, licenseKey, 'Could not log in.')
  }

  /**
   * New customer, one step: their details and the licence key they bought. The
   * server checks the key before creating the account, then activates it here.
   */
  async signUp({ username, name, email, phone }, licenseKey) {
    return this.#keySession('/api/auth/signup', { username, name, email, phone }, licenseKey, 'Could not create your account.')
  }

  /** Opens a session with a licence key as proof and installs the licence it returns. */
  async #keySession(endpoint, details, licenseKey, fallbackError) {
    const key = typeof licenseKey === 'string' ? licenseKey.trim().toUpperCase() : ''
    if (!KEY_PATTERN.test(key)) throw new Error('A licence key looks like AVP-XXXX-XXXX-XXXX-XXXX.')
    if (!PUBLIC_KEY) throw new Error('This build cannot verify licences because it has no licence public key.')
    const previous = this.#cache.account
    const id = machineId()
    const body = await this.#postForSession(endpoint, { ...details, licenseKey: key, ...deviceDetails(id) }, fallbackError)
    const account = pickAccount(body.user)
    // Whatever licence this PC held belongs to the previous login; this one replaces it.
    if (this.#cache.licenseKey && (previous?.id !== account.id || this.#cache.licenseKey !== key)) await this.#clearLicense()
    this.#cache = { ...this.#cache, account }
    if (body.activationError || !isValidSignedLicense(body.license)) {
      await this.#saveCache()
      const reason = body.activationError ? friendly(body.activationError, 'The licence could not be activated.') : 'The licence server returned a licence this app could not verify. The app and server keys do not match.'
      this.#setStatus({ state: 'unlicensed', reason })
      return { ...account, offline: false, activationError: reason }
    }
    this.#cache = { ...this.#cache, licenseKey: key, deviceId: id, signedLicense: body.license, activatedAt: Date.now(), lastValidatedAt: Date.now(), nextValidationAt: Date.now() + VALIDATION_INTERVAL_MS }
    await this.#saveCache()
    this.#setStatus({ state: 'active', license: body.license, lastValidatedAt: this.#cache.lastValidatedAt })
    return { ...account, offline: false, restoredLicense: true }
  }

  /**
   * There is no password to ask for, so an expired session is renewed from the
   * saved profile. Returns false if the server no longer accepts that profile
   * (for example an admin changed the email or username).
   */
  async #renewSession() {
    const account = this.#cache.account
    if (!account?.username || !account.email) return false
    try {
      // Log in, not register: renewing must never overwrite the saved name or phone.
      this.#cache.account = await this.#openSession({ email: account.email, username: account.username })
      await this.#saveCache()
      return true
    } catch {
      return false
    }
  }

  async activate(licenseKey) {
    const key = typeof licenseKey === 'string' ? licenseKey.trim().toUpperCase() : ''
    if (!KEY_PATTERN.test(key)) throw new Error('A licence key looks like AVP-XXXX-XXXX-XXXX-XXXX.')
    if (!this.#cache.account) throw new Error('Enter your details before activating a licence.')
    if (!PUBLIC_KEY) throw new Error('This build cannot verify licences because it has no licence public key.')
    // One licence per device: release the old seat before taking a new one.
    if (this.#cache.licenseKey && this.#cache.licenseKey !== key) {
      try { await this.deactivate() } catch { await this.#clearLicense() }
    }
    const id = machineId()
    const response = await this.#request('/api/license/activate', { method: 'POST', body: { licenseKey: key, ...deviceDetails(id) } })
    if (response.status === 401) throw new Error(MESSAGES.AUTH_REQUIRED)
    if (!response.ok) throw new Error(friendly(response.body.error, 'Licence activation failed.'))
    if (!isValidSignedLicense(response.body.license)) throw new Error('The licence server returned a licence this app could not verify. The app and server keys do not match.')
    this.#cache = { ...this.#cache, licenseKey: key, deviceId: id, signedLicense: response.body.license, activatedAt: Date.now(), lastValidatedAt: Date.now(), nextValidationAt: Date.now() + VALIDATION_INTERVAL_MS }
    await this.#saveCache()
    this.#setStatus({ state: 'active', license: response.body.license, lastValidatedAt: this.#cache.lastValidatedAt })
    return this.#status
  }

  async validate({ force = false } = {}) {
    if (!this.#cache.licenseKey || !this.#cache.signedLicense) return this.#status
    if (!force && this.#cache.nextValidationAt && this.#cache.nextValidationAt > Date.now()) return this.#status
    try {
      if (!this.#cache.account) throw Object.assign(new Error(MESSAGES.AUTH_REQUIRED), { sessionExpired: true })
      const response = await this.#request('/api/license/validate', { method: 'POST', body: { licenseKey: this.#cache.licenseKey, deviceId: this.#deviceId, appVersion: app.getVersion() } })
      if (response.status === 401) throw Object.assign(new Error(MESSAGES.AUTH_REQUIRED), { sessionExpired: true })
      if (response.status === 404 || response.status === 409) {
        // The server no longer recognises this key for this account.
        const reason = friendly(response.body.error, 'This licence is no longer valid for this account.')
        await this.#clearLicense()
        this.#setStatus({ state: 'unlicensed', reason })
        return this.#status
      }
      if (!response.ok || !isValidSignedLicense(response.body.license)) throw new Error(friendly(response.body.error, 'The licence server could not validate this licence.'))

      if (response.body.deviceActive === false) {
        await this.#clearLicense()
        this.#setStatus({ state: 'unlicensed', reason: MESSAGES.DEVICE_NOT_ACTIVATED })
        return this.#status
      }
      this.#cache.signedLicense = response.body.license
      this.#cache.lastValidatedAt = Date.now()
      this.#cache.nextValidationAt = Date.now() + VALIDATION_INTERVAL_MS
      await this.#saveCache()
      const serverState = String(response.body.license.payload.status || 'cancelled').toLowerCase()
      this.#setStatus(response.body.valid
        ? { state: 'active', license: response.body.license, lastValidatedAt: this.#cache.lastValidatedAt }
        : { state: serverState, license: response.body.license, lastValidatedAt: this.#cache.lastValidatedAt, reason: friendly(response.body.reason, 'The licence is not active.') })
    } catch (error) {
      const lastValidatedAt = this.#cache.lastValidatedAt || 0
      const signed = this.#cache.signedLicense
      const reason = error instanceof Error ? error.message : 'The licence server could not be reached.'
      // Missing customer details get the same grace period as being offline (so
      // protection does not stop mid-day), but the UI asks for the details.
      const sessionExpired = Boolean(error?.sessionExpired)
      if (isExpired(signed.payload)) this.#setStatus({ state: 'expired', license: signed, lastValidatedAt })
      else if (Date.now() - lastValidatedAt <= OFFLINE_GRACE_MS) this.#setStatus({ state: 'offline-grace', license: signed, lastValidatedAt, reason, sessionExpired })
      else this.#setStatus({ state: 'validation-required', license: signed, lastValidatedAt, reason, sessionExpired })
    }
    return this.#status
  }

  async deactivate() {
    if (!this.#cache.licenseKey) {
      this.#setStatus({ state: 'unlicensed', reason: 'No licence is activated on this device.' })
      return this.#status
    }
    const response = await this.#request('/api/license/deactivate', { method: 'POST', body: { licenseKey: this.#cache.licenseKey, deviceId: this.#deviceId } })
    // ACTIVATION_NOT_FOUND means the seat is already free, which is the goal.
    if (!response.ok && response.status !== 404) throw new Error(friendly(response.body.error, 'Could not deactivate this device.'))
    await this.#clearLicense()
    this.#setStatus({ state: 'unlicensed', reason: 'This device is no longer activated.' })
    return this.#status
  }

  /** Best-effort report of scan results and detections to the admin panel. */
  async reportEvent(type, severity, metadata = {}) {
    if (!this.#cache.account || !this.isLicensed()) return
    try {
      await this.#request('/api/devices/events', { method: 'POST', body: { deviceId: this.#deviceId, type, severity, metadata } })
    } catch { /* offline: events are informational only */ }
  }

  #setStatus(status) {
    // When the licence went on this PC: the dashboard only shows a protection
    // score for scans that finished after it. Null for installs activated
    // before this was recorded, which keep their score.
    this.#status = { ...status, activatedAt: status.license && this.#cache.activatedAt ? new Date(this.#cache.activatedAt).toISOString() : null }
    for (const listener of this.#listeners) {
      try { listener(this.#status) } catch { /* ignore listener errors */ }
    }
  }

  /** Calls the server with the session cookie, renewing an expired session once from the saved profile. */
  async #request(endpoint, options, retried = false) {
    const result = await this.#send(endpoint, options)
    if (result.status === 401 && !retried) {
      if (await this.#renewSession()) return this.#request(endpoint, options, true)
      await this.#forgetSession()
    }
    return result
  }

  async #send(endpoint, options) {
    const headers = { 'content-type': 'application/json', ...(this.#cache.cookie ? { cookie: this.#cache.cookie } : {}) }
    const init = { method: options.method, headers, ...(options.body !== undefined && options.method !== 'GET' ? { body: JSON.stringify(options.body) } : {}) }
    const response = await fetch(`${API_URL}${endpoint}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) }
  }

  async #clearLicense() {
    const { licenseKey, deviceId, signedLicense, activatedAt, lastValidatedAt, nextValidationAt, ...rest } = this.#cache // eslint-disable-line no-unused-vars
    this.#cache = rest
    await this.#saveCache()
  }

  async #forgetSession() {
    const { cookie, account, ...rest } = this.#cache // eslint-disable-line no-unused-vars
    this.#cache = rest
    await this.#saveCache()
  }

  async #loadCache() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return
      const encrypted = await fs.readFile(this.#cachePath)
      this.#cache = JSON.parse(safeStorage.decryptString(encrypted)) || {}
    } catch {
      this.#cache = {}
    }
  }

  async #saveCache() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable')
    await fs.mkdir(path.dirname(this.#cachePath), { recursive: true })
    await fs.writeFile(this.#cachePath, safeStorage.encryptString(JSON.stringify(this.#cache)), { mode: 0o600 })
  }
}
