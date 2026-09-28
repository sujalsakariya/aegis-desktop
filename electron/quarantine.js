import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

export class QuarantineManager {
  #directory = path.join(app.getPath('userData'), 'quarantine')
  #keyPath = path.join(app.getPath('userData'), 'quarantine.key')
  #indexPath = path.join(app.getPath('userData'), 'quarantine.index')
  #allowedPath = path.join(app.getPath('userData'), 'allowed.bin')
  #key = null
  #items = []
  // Hashes the user restored from quarantine. Scans and real-time protection
  // skip them, so a restored file is not immediately quarantined again.
  #allowed = []
  #mutation = Promise.resolve()

  async initialize() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable')
    await fs.mkdir(this.#directory, { recursive: true })
    try {
      const encryptedKey = await fs.readFile(this.#keyPath)
      this.#key = safeStorage.decryptString(encryptedKey)
    } catch {
      this.#key = crypto.randomBytes(32).toString('base64')
      await fs.writeFile(this.#keyPath, safeStorage.encryptString(this.#key), { mode: 0o600 })
    }
    try {
      this.#items = JSON.parse(safeStorage.decryptString(await fs.readFile(this.#indexPath)))
      if (!Array.isArray(this.#items)) this.#items = []
    } catch { this.#items = [] }
    try {
      const allowed = JSON.parse(safeStorage.decryptString(await fs.readFile(this.#allowedPath)))
      this.#allowed = Array.isArray(allowed) ? allowed.filter((entry) => typeof entry?.sha256 === 'string') : []
    } catch { this.#allowed = [] }
  }

  list() { return this.#items.map(({ encryptedPath, ...item }) => item) } // eslint-disable-line no-unused-vars

  isAllowed(sha256) {
    if (typeof sha256 !== 'string') return false
    const value = sha256.toLowerCase()
    return this.#allowed.some((entry) => entry.sha256 === value)
  }

  listAllowed() { return this.#allowed.map((entry) => ({ ...entry })) }

  removeAllowed(sha256) {
    return this.#withMutation(async () => {
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('Invalid file hash')
      const value = sha256.toLowerCase()
      this.#allowed = this.#allowed.filter((entry) => entry.sha256 !== value)
      await this.#saveAllowed()
      return this.listAllowed()
    })
  }

  quarantine(filePath, threatName = 'Unknown threat') { return this.#withMutation(() => this.#quarantine(filePath, threatName)) }

  async #quarantine(filePath, threatName = 'Unknown threat') {
    if (!this.#key) throw new Error('Quarantine is unavailable because OS secure storage could not be opened')
    const source = path.resolve(filePath)
    if (!path.isAbsolute(source) || source.includes(`${path.sep}quarantine${path.sep}`)) throw new Error('Invalid quarantine source')
    const stat = await fs.stat(source)
    if (!stat.isFile()) throw new Error('Only files can be quarantined')
    const originalHash = await this.#hash(source)
    const id = crypto.randomUUID()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.#key, 'base64'), iv)
    const encrypted = Buffer.concat([cipher.update(await fs.readFile(source)), cipher.final()])
    const beforeDelete = await this.#hash(source)
    if (beforeDelete !== originalHash) throw new Error('File changed during quarantine')
    const encryptedPath = path.join(this.#directory, `${id}.qtn`)
    await fs.writeFile(encryptedPath, encrypted, { mode: 0o600 })
    const item = { id, encryptedPath, originalPath: source, originalHash, threatName, size: stat.size, quarantinedAt: new Date().toISOString(), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
    this.#items.push(item)
    await fs.unlink(source)
    await this.#saveIndex()
    return { ...item, encryptedPath: undefined }
  }

  restore(id) { return this.#withMutation(() => this.#restore(id)) }

  async #restore(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid quarantine ID')
    const item = this.#items.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Quarantine item not found')
    const destination = path.resolve(item.originalPath)
    if (destination !== item.originalPath || destination.includes(`${path.sep}.config${path.sep}`) || destination.includes(`${path.sep}quarantine${path.sep}`)) throw new Error('Unsafe restore destination')
    try { await fs.access(destination); throw new Error('Original path already exists') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    const encrypted = await fs.readFile(item.encryptedPath)
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.#key, 'base64'), Buffer.from(item.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(item.tag, 'base64'))
    const restored = Buffer.concat([decipher.update(encrypted), decipher.final()])
    // Allow the hash before the file reappears, otherwise the real-time watcher
    // would quarantine it again the moment it is written back.
    const sha256 = crypto.createHash('sha256').update(restored).digest('hex')
    if (!this.isAllowed(sha256)) {
      this.#allowed.push({ sha256, path: destination, threatName: item.threatName, allowedAt: new Date().toISOString() })
      await this.#saveAllowed()
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, restored, { mode: 0o600, flag: 'wx' })
    await fs.unlink(item.encryptedPath)
    this.#items = this.#items.filter((candidate) => candidate.id !== id)
    await this.#saveIndex()
    return { restoredPath: destination, allowed: true, sha256 }
  }

  delete(id) { return this.#withMutation(() => this.#delete(id)) }

  async #delete(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid quarantine ID')
    const item = this.#items.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Quarantine item not found')
    await fs.rm(item.encryptedPath, { force: true })
    this.#items = this.#items.filter((candidate) => candidate.id !== id)
    await this.#saveIndex()
  }

  async #withMutation(operation) { const next = this.#mutation.then(operation); this.#mutation = next.catch(() => {}); return next }
  async #saveIndex() { const temporary = `${this.#indexPath}.tmp`; await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(this.#items)), { mode: 0o600 }); await fs.rename(temporary, this.#indexPath) }
  async #saveAllowed() { const temporary = `${this.#allowedPath}.tmp`; await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(this.#allowed)), { mode: 0o600 }); await fs.rename(temporary, this.#allowedPath) }
  #hash(filePath) { return new Promise((resolve, reject) => { const hash = crypto.createHash('sha256'); const stream = createReadStream(filePath); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex'))) }) }
}
