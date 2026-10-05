/**
 * Thin wrapper over the preload bridges.
 *
 * Every call resolves to { ok, data, error } so views never have to try/catch,
 * and a missing bridge (running the renderer in a plain browser during
 * `npm run dev` without Electron) degrades to ok:false instead of throwing.
 */

const BRIDGES = [
  'appInfo',
  'licenseAPI',
  'scannerAPI',
  'quarantineAPI',
  'realtimeAPI',
  'settingsAPI',
  'schedulerAPI',
  'usbAPI',
  'updatesAPI',
  'historyAPI',
  'cleanerAPI',
]

export function hasBridge(name) {
  return typeof window !== 'undefined' && Boolean(window[name])
}

/** True when running inside Electron with the preload script loaded. */
export const isDesktop = BRIDGES.every((name) => hasBridge(name))

/** Electron wraps IPC rejections; recover the message the main process threw. */
export function readableError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const match = /Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?([\s\S]*)$/.exec(raw)
  const message = (match ? match[1] : raw).trim()
  return message || 'Something went wrong.'
}

async function call(bridge, method, ...args) {
  const api = typeof window !== 'undefined' ? window[bridge] : undefined
  if (!api || typeof api[method] !== 'function') {
    return { ok: false, data: null, error: 'The desktop bridge is unavailable. Run the app through Electron.' }
  }
  try {
    return { ok: true, data: await api[method](...args), error: null }
  } catch (error) {
    return { ok: false, data: null, error: readableError(error) }
  }
}

/** Subscribes to a push channel; returns a no-op unsubscribe if unavailable. */
function subscribe(bridge, listener) {
  const api = typeof window !== 'undefined' ? window[bridge] : undefined
  if (!api || typeof api.onUpdate !== 'function') return () => {}
  const unsubscribe = api.onUpdate(listener)
  return typeof unsubscribe === 'function' ? unsubscribe : () => {}
}

export const license = {
  status: () => call('licenseAPI', 'status'),
  account: () => call('licenseAPI', 'account'),
  saveProfile: (profile) => call('licenseAPI', 'saveProfile', profile),
  login: (email, username) => call('licenseAPI', 'login', { email, username }),
  keyLogin: (email, licenseKey) => call('licenseAPI', 'keyLogin', { email, licenseKey }),
  signUp: (profile, licenseKey) => call('licenseAPI', 'signUp', { ...profile, licenseKey }),
  updateProfile: (profile) => call('licenseAPI', 'updateProfile', profile),
  logout: () => call('licenseAPI', 'logout'),
  onUpdate: (listener) => subscribe('licenseAPI', listener),
  activate: (key) => call('licenseAPI', 'activate', key),
  validate: () => call('licenseAPI', 'validate'),
  deactivate: () => call('licenseAPI', 'deactivate'),
}

export const scanner = {
  status: () => call('scannerAPI', 'status'),
  definitions: () => call('scannerAPI', 'definitions'),
  start: (options) => call('scannerAPI', 'start', options),
  pause: () => call('scannerAPI', 'pause'),
  resume: () => call('scannerAPI', 'resume'),
  cancel: () => call('scannerAPI', 'cancel'),
  onUpdate: (listener) => subscribe('scannerAPI', listener),
}

export const app = {
  openLicenses: () => call('appInfo', 'openLicenses'),
}

export const cleaner = {
  status: () => call('cleanerAPI', 'status'),
  analyze: () => call('cleanerAPI', 'analyze'),
  clean: (categoryIds) => call('cleanerAPI', 'clean', categoryIds),
  cancel: () => call('cleanerAPI', 'cancel'),
  onUpdate: (listener) => subscribe('cleanerAPI', listener),
}

export const quarantine = {
  list: () => call('quarantineAPI', 'list'),
  restore: (id) => call('quarantineAPI', 'restore', id),
  remove: (id) => call('quarantineAPI', 'delete', id),
  allowed: () => call('quarantineAPI', 'allowed'),
  removeAllowed: (sha256) => call('quarantineAPI', 'removeAllowed', sha256),
}

export const realtime = {
  status: () => call('realtimeAPI', 'status'),
  start: () => call('realtimeAPI', 'start'),
  stop: () => call('realtimeAPI', 'stop'),
  onUpdate: (listener) => subscribe('realtimeAPI', listener),
}

export const settings = {
  get: () => call('settingsAPI', 'get'),
  update: (patch) => call('settingsAPI', 'update', patch),
}

export const scheduler = {
  status: () => call('schedulerAPI', 'status'),
  update: (schedule) => call('schedulerAPI', 'update', schedule),
  saved: () => call('schedulerAPI', 'saved'),
}

export const usb = {
  status: () => call('usbAPI', 'status'),
  start: () => call('usbAPI', 'start'),
  stop: () => call('usbAPI', 'stop'),
  onUpdate: (listener) => subscribe('usbAPI', listener),
}

export const updates = {
  checkDefinitions: () => call('updatesAPI', 'checkDefinitions'),
  installDefinitions: (options) => call('updatesAPI', 'installDefinitions', options),
  checkApplication: () => call('updatesAPI', 'checkApplication'),
  openApplicationDownload: () => call('updatesAPI', 'openApplicationDownload'),
  log: () => call('updatesAPI', 'log'),
  onUpdate: (listener) => subscribe('updatesAPI', listener),
}

export const history = {
  summary: () => call('historyAPI', 'summary'),
}

export function appVersions() {
  return (typeof window !== 'undefined' && window.appInfo?.versions) || null
}

export const API_URL = typeof __API_URL__ === 'string' ? __API_URL__ : 'http://localhost:3001'
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0'
