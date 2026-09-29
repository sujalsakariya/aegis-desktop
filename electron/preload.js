import { contextBridge, ipcRenderer } from 'electron'

// Whitelisted, read-only info exposed to the renderer.
// No direct filesystem/OS access is exposed here — only what the
// renderer explicitly needs, added deliberately as features are built.
contextBridge.exposeInMainWorld('appInfo', {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
})

contextBridge.exposeInMainWorld('licenseAPI', {
  status: () => ipcRenderer.invoke('license:status'),
  account: () => ipcRenderer.invoke('license:account'),
  saveProfile: (profile) => ipcRenderer.invoke('license:saveProfile', profile),
  login: (credentials) => ipcRenderer.invoke('license:login', credentials),
  keyLogin: (credentials) => ipcRenderer.invoke('license:keyLogin', credentials),
  signUp: (input) => ipcRenderer.invoke('license:signUp', input),
  updateProfile: (profile) => ipcRenderer.invoke('license:updateProfile', profile),
  logout: () => ipcRenderer.invoke('license:logout'),
  onUpdate: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('license:update', handler)
    return () => ipcRenderer.removeListener('license:update', handler)
  },
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', licenseKey),
  validate: () => ipcRenderer.invoke('license:validate'),
  deactivate: () => ipcRenderer.invoke('license:deactivate'),
})

contextBridge.exposeInMainWorld('scannerAPI', {
  status: () => ipcRenderer.invoke('scanner:status'),
  definitions: () => ipcRenderer.invoke('scanner:definitions'),
  start: (options) => ipcRenderer.invoke('scanner:start', options),
  pause: () => ipcRenderer.invoke('scanner:pause'),
  resume: () => ipcRenderer.invoke('scanner:resume'),
  cancel: () => ipcRenderer.invoke('scanner:cancel'),
  onUpdate: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('scanner:update', handler)
    return () => ipcRenderer.removeListener('scanner:update', handler)
  },
})

contextBridge.exposeInMainWorld('quarantineAPI', {
  list: () => ipcRenderer.invoke('quarantine:list'),
  restore: (id) => ipcRenderer.invoke('quarantine:restore', id),
  delete: (id) => ipcRenderer.invoke('quarantine:delete', id),
  allowed: () => ipcRenderer.invoke('quarantine:allowed'),
  removeAllowed: (sha256) => ipcRenderer.invoke('quarantine:removeAllowed', sha256),
})

contextBridge.exposeInMainWorld('realtimeAPI', {
  status: () => ipcRenderer.invoke('realtime:status'),
  start: () => ipcRenderer.invoke('realtime:start'),
  stop: () => ipcRenderer.invoke('realtime:stop'),
  onUpdate: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('realtime:update', handler)
    return () => ipcRenderer.removeListener('realtime:update', handler)
  },
})

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
})

contextBridge.exposeInMainWorld('schedulerAPI', {
  status: () => ipcRenderer.invoke('scheduler:status'),
  update: (schedule) => ipcRenderer.invoke('scheduler:update', schedule),
  saved: () => ipcRenderer.invoke('scheduler:saved'),
})

contextBridge.exposeInMainWorld('usbAPI', {
  status: () => ipcRenderer.invoke('usb:status'),
  start: () => ipcRenderer.invoke('usb:start'),
  stop: () => ipcRenderer.invoke('usb:stop'),
  onUpdate: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('usb:update', handler)
    return () => ipcRenderer.removeListener('usb:update', handler)
  },
})

contextBridge.exposeInMainWorld('updatesAPI', {
  checkDefinitions: () => ipcRenderer.invoke('updates:definitions:check'),
  installDefinitions: (options) => ipcRenderer.invoke('updates:definitions:install', options),
  checkApplication: () => ipcRenderer.invoke('updates:application:check'),
  openApplicationDownload: () => ipcRenderer.invoke('updates:application:open'),
  log: () => ipcRenderer.invoke('updates:log'),
  onUpdate: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('updates:update', handler)
    return () => ipcRenderer.removeListener('updates:update', handler)
  },
})

contextBridge.exposeInMainWorld('historyAPI', {
  summary: () => ipcRenderer.invoke('history:summary'),
})
