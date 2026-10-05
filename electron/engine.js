import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import dns from 'node:dns/promises'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'

const gunzip = promisify(zlib.gunzip)
const execFileAsync = promisify(execFile)

// The engine holds ~1 GB of signatures in memory, so it only runs while it is
// needed and stops after this long without work.
const IDLE_STOP_MS = 10 * 60 * 1000
const START_TIMEOUT_MS = 180 * 1000
// Larger files are not sent to the engine (its own default limit as well).
export const MAX_SCAN_BYTES = 100 * 1024 * 1024
const ANY_SIZE = 0xffffffff
// Engine threads, and how many files the scanner sends at once.
export const SCAN_PARALLELISM = Math.max(2, Math.min(8, os.cpus().length))

/**
 * ClamAV, bundled with Aegis: clamd scans files, freshclam keeps the official
 * signatures current, and a compact index of ClamAV's whole-file hash
 * signatures gives real-time protection an instant first check without
 * keeping the 1 GB engine in memory.
 */
export class ClamEngine {
  #root
  #data
  #db
  #process = null
  #port = 0
  #starting = null
  #idleTimer = null
  #active = 0
  #updating = null
  #info = { ready: false, version: null, mainVersion: null, signatures: 0, updatedAt: null, buildTime: null }
  #index = null
  #indexBuilding = null
  #listeners = new Set()

  /** resourcesDir: the bundled ClamAV files; userData: where signatures and config live. */
  constructor({ resourcesDir, userData }) {
    this.#root = resourcesDir
    this.#data = path.join(userData, 'clamav')
    this.#db = path.join(this.#data, 'db')
  }

  get #bin() {
    return process.platform === 'win32'
      ? { clamd: path.join(this.#root, 'clamd.exe'), freshclam: path.join(this.#root, 'freshclam.exe') }
      : { clamd: path.join(this.#root, 'bin', 'clamd'), freshclam: path.join(this.#root, 'bin', 'freshclam') }
  }

  /**
   * Environment for freshclam and clamd. Some of their code (the database test
   * process, the RAR module loader) ignores the config file and reads these.
   */
  get #childEnv() {
    return {
      ...process.env,
      CVD_CERTS_DIR: path.join(this.#root, 'certs'),
      ...(process.platform === 'win32' ? {} : { LD_LIBRARY_PATH: path.join(this.#root, 'lib') }),
    }
  }

  /** True when this build ships the engine for this platform. */
  isAvailable() { return existsSync(this.#bin.clamd) && existsSync(this.#bin.freshclam) }

  /** { ready, version (daily), mainVersion, signatures, updatedAt, buildTime }. */
  getInfo() { return { ...this.#info } }

  /** Fires on engine state changes: { type: 'starting' | 'running' | 'stopped' | 'info' }. */
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  #emit(event) { for (const listener of this.#listeners) { try { listener(event) } catch { /* ignore */ } } }

  async initialize() {
    await fs.mkdir(this.#db, { recursive: true })
    await this.#killOrphan()
    await this.#readInfo()
    if (this.#info.ready) this.#loadIndex().catch((error) => console.warn('[engine] hash index:', error.message))
  }

  // ---------------------------------------------------------------- signatures

  /** The signature databases present, newest form first (.cld after an incremental update). */
  async #databases() {
    const found = {}
    let names = []
    try { names = await fs.readdir(this.#db) } catch { return found }
    for (const base of ['main', 'daily', 'bytecode']) {
      const file = ['cld', 'cvd'].map((ext) => `${base}.${ext}`).find((name) => names.includes(name))
      if (file) found[base] = path.join(this.#db, file)
    }
    return found
  }

  /** CVD/CLD header: "ClamAV-VDB:time:version:signatures:flevel:md5:dsig:builder:stime". */
  async #header(file) {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(512)
      await handle.read(buffer, 0, 512, 0)
      const parts = buffer.toString('latin1').split(':')
      if (parts[0] !== 'ClamAV-VDB') return null
      return { built: parts[1], version: Number(parts[2]), signatures: Number(parts[3]) }
    } finally { await handle.close() }
  }

  async #readInfo() {
    const dbs = await this.#databases()
    if (!dbs.main || !dbs.daily) {
      this.#info = { ready: false, version: null, mainVersion: null, signatures: 0, updatedAt: null, buildTime: null }
      return this.#info
    }
    let signatures = 0
    const headers = {}
    for (const [base, file] of Object.entries(dbs)) {
      try { headers[base] = await this.#header(file); signatures += headers[base]?.signatures || 0 } catch { /* unreadable */ }
    }
    const stats = await fs.stat(dbs.daily).catch(() => null)
    this.#info = {
      ready: Boolean(headers.main && headers.daily),
      version: headers.daily?.version ?? null,
      mainVersion: headers.main?.version ?? null,
      signatures,
      updatedAt: stats ? stats.mtime.toISOString() : null,
      buildTime: headers.daily?.built || null,
    }
    return this.#info
  }

  /** The newest daily signature version ClamAV has published (DNS TXT record), or null. */
  async latestVersion() {
    try {
      const records = await dns.resolveTxt('current.cvd.clamav.net')
      // "1.5.4:63:28143:1759581322:1:90:49192:339" -> engine:main:daily:time:…:bytecode
      const fields = records.flat().join('').split(':')
      const daily = Number(fields[2])
      return Number.isFinite(daily) ? { daily, main: Number(fields[1]), publishedAt: Number(fields[3]) ? new Date(Number(fields[3]) * 1000).toISOString() : null } : null
    } catch { return null }
  }

  async #writeConfig() {
    await fs.mkdir(this.#db, { recursive: true })
    const quote = (value) => `"${value}"`
    const certs = path.join(this.#root, 'certs')
    await fs.writeFile(path.join(this.#data, 'freshclam.conf'), [
      `DatabaseDirectory ${quote(this.#db)}`,
      `CVDCertsDirectory ${quote(certs)}`,
      'DatabaseMirror database.clamav.net',
      'DNSDatabaseInfo current.cvd.clamav.net',
      'ConnectTimeout 30',
      'ReceiveTimeout 120',
      'Bytecode yes',
      '',
    ].join('\n'))
    await fs.writeFile(path.join(this.#data, 'clamd.conf'), [
      `DatabaseDirectory ${quote(this.#db)}`,
      `CVDCertsDirectory ${quote(certs)}`,
      `TCPSocket ${this.#port}`,
      'TCPAddr 127.0.0.1',
      'Foreground yes',
      `PidFile ${quote(path.join(this.#data, 'clamd.pid'))}`,
      `MaxThreads ${SCAN_PARALLELISM}`,
      // A reload would otherwise briefly hold two copies of the signatures.
      'ConcurrentDatabaseReload no',
      `StreamMaxLength ${MAX_SCAN_BYTES / 1024 / 1024}M`,
      `MaxFileSize ${MAX_SCAN_BYTES / 1024 / 1024}M`,
      'MaxScanSize 400M',
      'LogFileMaxSize 0',
      '',
    ].join('\n'))
  }

  /**
   * Downloads new signatures from ClamAV's official mirrors with freshclam.
   * Single-flight. Resolves { updated, info }.
   */
  update() {
    if (!this.#updating) {
      this.#updating = this.#runFreshclam().finally(() => { this.#updating = null })
    }
    return this.#updating
  }

  async #runFreshclam() {
    if (!this.isAvailable()) throw new Error('The scanning engine is missing from this installation. Reinstall Aegis.')
    const before = this.#info.version
    await this.#writeConfig()
    let output = ''
    try {
      const result = await execFileAsync(this.#bin.freshclam, ['--config-file', path.join(this.#data, 'freshclam.conf'), '--stdout', '--no-warnings'], { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: this.#childEnv })
      output = `${result.stdout}${result.stderr}`
    } catch (error) {
      output = `${error.stdout || ''}${error.stderr || ''}`
      // freshclam exits non-zero for "already up to date" in some versions; only fail without databases.
      await this.#readInfo()
      if (!this.#info.ready) {
        const failure = new Error(freshclamError(output) || 'Could not download the threat signatures. Check your internet connection and try again.')
        failure.output = output
        throw failure
      }
    }
    const info = await this.#readInfo()
    const updated = info.version !== before
    if (updated) {
      this.#index = null
      this.#loadIndex().catch((error) => console.warn('[engine] hash index:', error.message))
      if (this.#process) await this.#command('zRELOAD\0').catch(() => {})
    }
    this.#emit({ type: 'info', info })
    return { updated, info, output }
  }

  // ---------------------------------------------------------------- daemon

  async #killOrphan() {
    // An earlier Aegis that crashed can leave its engine running; stop it.
    let pid
    try { pid = Number((await fs.readFile(path.join(this.#data, 'clamd.pid'), 'utf8')).trim()) } catch { return }
    if (!Number.isInteger(pid) || pid <= 0) return
    try {
      const { stdout } = process.platform === 'win32'
        ? await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
        : await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='])
      if (/clamd/i.test(stdout)) process.kill(pid)
    } catch { /* not running */ }
    await fs.rm(path.join(this.#data, 'clamd.pid'), { force: true })
  }

  /** Starts clamd if needed and resolves once it answers. Throws if signatures are missing. */
  ensureRunning() {
    if (this.#process && !this.#starting) return Promise.resolve()
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => { this.#starting = null })
    }
    return this.#starting
  }

  isRunning() { return Boolean(this.#process) && !this.#starting }

  async #start() {
    if (!this.isAvailable()) throw new Error('The scanning engine is missing from this installation. Reinstall Aegis.')
    if (!this.#info.ready) await this.#readInfo()
    if (!this.#info.ready) throw new Error('The threat signatures are still downloading. Try again in a minute.')
    this.#port = await freePort()
    await this.#writeConfig()
    this.#emit({ type: 'starting' })
    const child = spawn(this.#bin.clamd, ['--config-file', path.join(this.#data, 'clamd.conf')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: this.#childEnv })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    this.#process = child
    child.on('exit', () => {
      if (this.#process === child) this.#process = null
      this.#emit({ type: 'stopped' })
    })
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.#process !== child) throw new Error(`The scanning engine stopped while starting. ${stderr.trim().split('\n').pop() || ''}`.trim())
      try {
        if ((await this.#command('zPING\0', 2000)) === 'PONG') {
          this.#emit({ type: 'running' })
          this.#touch()
          return
        }
      } catch { /* still loading signatures */ }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    this.stop()
    throw new Error('The scanning engine took too long to start.')
  }

  /** Stops the engine and frees its memory. */
  stop() {
    clearTimeout(this.#idleTimer)
    const child = this.#process
    this.#process = null
    if (child) { try { child.kill() } catch { /* already gone */ } }
  }

  /** Keeps the engine while work arrives; stops it after IDLE_STOP_MS without any. */
  #touch() {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => { if (this.#active === 0) this.stop(); else this.#touch() }, IDLE_STOP_MS)
    this.#idleTimer.unref?.()
  }

  #command(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.#port, '127.0.0.1')
      let out = ''
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')))
      socket.on('connect', () => socket.end(payload))
      socket.on('data', (data) => { out += data })
      socket.on('end', () => resolve(out.replace(/\0$/, '').trim()))
      socket.on('error', reject)
    })
  }

  /** Streams a file to clamd (INSTREAM). Resolves { infected, name } or throws. */
  #instream(filePath) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.#port, '127.0.0.1')
      let out = ''
      let settled = false
      const fail = (error) => { if (!settled) { settled = true; socket.destroy(); reject(error) } }
      socket.setTimeout(120000, () => fail(new Error('The scanning engine did not answer in time.')))
      socket.on('error', fail)
      socket.on('data', (data) => { out += data })
      socket.on('end', () => {
        if (settled) return
        settled = true
        const reply = out.replace(/\0$/, '').trim()
        const found = /^stream: (.+) FOUND$/.exec(reply)
        if (found) resolve({ infected: true, name: found[1] })
        else if (/^stream: OK$/.test(reply)) resolve({ infected: false, name: null })
        else reject(new Error(reply || 'empty reply'))
      })
      socket.on('connect', () => {
        socket.write('zINSTREAM\0')
        const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })
        stream.on('data', (chunk) => {
          const size = Buffer.alloc(4)
          size.writeUInt32BE(chunk.length)
          if (!socket.write(Buffer.concat([size, chunk]))) { stream.pause(); socket.once('drain', () => stream.resume()) }
        })
        stream.on('error', fail)
        stream.on('end', () => socket.end(Buffer.alloc(4)))
      })
    })
  }

  /**
   * Scans one file with the full engine, starting it if needed.
   * Resolves { infected, name, skipped? }. Transient socket hiccups are retried.
   */
  async scanFile(filePath) {
    await this.ensureRunning()
    this.#active += 1
    try {
      const stats = await fs.stat(filePath)
      if (!stats.isFile()) return { infected: false, name: null, skipped: 'not a file' }
      if (stats.size > MAX_SCAN_BYTES) return { infected: false, name: null, skipped: 'too large' }
      // Fast path: the engine opens the file itself. Paths it cannot open
      // (unusual characters, permissions) are streamed to it instead.
      try {
        const reply = await this.#command(`zSCAN ${filePath}\0`, 120000)
        const found = /: (.+) FOUND$/.exec(reply)
        if (found) return { infected: true, name: found[1] }
        if (/: OK$/.test(reply)) return { infected: false, name: null }
      } catch { /* fall back to streaming */ }
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.#instream(filePath)
        } catch (error) {
          if (attempt >= 3 || !this.#process) throw error
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
        }
      }
    } finally {
      this.#active -= 1
      this.#touch()
    }
  }

  // ---------------------------------------------------------------- hash index

  /**
   * ClamAV's whole-file hash signatures (.hdb / .hsb), kept as sorted binary
   * tables so a lookup costs a few microseconds and ~25 MB of memory in total.
   */
  #loadIndex() {
    if (!this.#indexBuilding) {
      this.#indexBuilding = this.#buildIndex().then((index) => { this.#index = index }).finally(() => { this.#indexBuilding = null })
    }
    return this.#indexBuilding
  }

  async #buildIndex() {
    const dbs = await this.#databases()
    const tables = []
    const ignoredNames = new Set()
    const allowedHashes = new Set()
    for (const base of ['main', 'daily']) {
      if (!dbs[base]) continue
      const header = await this.#header(dbs[base])
      const cache = path.join(this.#data, `hashes-${base}-${header?.version}.bin`)
      let table = await readTable(cache)
      const files = !table || base === 'daily' ? await readDatabaseFiles(dbs[base], /\.(hdb|hsb|ign2?|fp|sfp)$/) : {}
      if (!table) {
        table = buildTable(Object.entries(files).filter(([name]) => /\.(hdb|hsb)$/.test(name)).map(([, text]) => text))
        await writeTable(cache, table)
        // Keep only the cache for the current version.
        for (const old of await fs.readdir(this.#data)) {
          if (old.startsWith(`hashes-${base}-`) && path.join(this.#data, old) !== cache) await fs.rm(path.join(this.#data, old), { force: true })
        }
      }
      tables.push(table)
      for (const [name, text] of Object.entries(files)) {
        for (const line of text.split('\n')) {
          const fields = line.trim().split(':')
          if (!fields[0]) continue
          // Signatures ClamAV withdrew: .ign2 is "Name[:md5]", the older .ign is "db:line:Name".
          if (/\.ign2$/.test(name)) ignoredNames.add(fields[0])
          else if (/\.ign$/.test(name) && fields[2]) ignoredNames.add(fields[2])
          // Known-clean files (false positives): "hash:size:name".
          else if (/\.s?fp$/.test(name)) allowedHashes.add(fields[0].toLowerCase())
        }
      }
    }
    return { tables, ignoredNames, allowedHashes }
  }

  isIndexReady() { return Boolean(this.#index) }

  /** Signature name for a file's hashes, or null. Pass lowercase hex. */
  lookupHashes({ md5, sha1, sha256, size }) {
    const index = this.#index
    if (!index) return null
    if ([md5, sha1, sha256].some((hash) => hash && index.allowedHashes.has(hash))) return null
    for (const table of index.tables) {
      const name = lookupTable(table, md5, size) || table.wide.get(sha256)?.(size) || table.wide.get(sha1)?.(size)
      if (name && !index.ignoredNames.has(name)) return name
    }
    return null
  }
}

function freshclamError(output) {
  const line = output.split(/\r?\n/).reverse().find((text) => /ERROR|WARNING/.test(text))
  if (!line) return null
  if (/cool-?down|429/i.test(output)) return 'ClamAV asked us to wait before downloading again. Aegis will try again later.'
  return `Signature update failed: ${line.replace(/^.*?(ERROR|WARNING):\s*/, '')}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

/** Reads the files inside a .cvd/.cld whose names match `pattern`. */
async function readDatabaseFiles(file, pattern) {
  const raw = await fs.readFile(file)
  let body = raw.subarray(512)
  if (body[0] === 0x1f && body[1] === 0x8b) body = await gunzip(body)
  const files = {}
  for (let offset = 0; offset + 512 <= body.length;) {
    const name = body.toString('latin1', offset, offset + 100).replace(/\0.*$/s, '')
    if (!name) break
    const size = parseInt(body.toString('latin1', offset + 124, offset + 136).replace(/\0.*$/s, '').trim() || '0', 8)
    const start = offset + 512
    if (pattern.test(name)) files[name] = body.toString('utf8', start, start + size)
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

/**
 * MD5 signatures go into a sorted table of 24-byte records:
 * md5 (16) | size (4, ANY_SIZE = any) | name offset (4). SHA-1/256 ones are
 * rare, so they live in a small map of hash -> (size) => name.
 */
function buildTable(texts) {
  const md5 = []
  const wide = new Map()
  const names = []
  let namesLength = 0
  const nameOffsets = new Map()
  const nameOffset = (name) => {
    if (!nameOffsets.has(name)) { nameOffsets.set(name, namesLength); names.push(name); namesLength += Buffer.byteLength(name) + 1 }
    return nameOffsets.get(name)
  }
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const [hash, sizeText, name] = line.trim().split(':')
      if (!hash || !name) continue
      const size = sizeText === '*' ? ANY_SIZE : Number(sizeText)
      if (!Number.isFinite(size)) continue
      const lower = hash.toLowerCase()
      if (lower.length === 32 && /^[0-9a-f]+$/.test(lower)) md5.push([lower, size, nameOffset(name)])
      else if ((lower.length === 40 || lower.length === 64) && /^[0-9a-f]+$/.test(lower)) wide.set(lower, [size, name])
    }
  }
  md5.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const records = Buffer.alloc(md5.length * 24)
  md5.forEach(([hash, size, offset], i) => {
    records.write(hash, i * 24, 16, 'hex')
    records.writeUInt32BE(size, i * 24 + 16)
    records.writeUInt32BE(offset, i * 24 + 20)
  })
  const namesBuffer = Buffer.from(names.map((name) => `${name}\0`).join(''), 'utf8')
  return finishTable({ records, names: namesBuffer, wideEntries: [...wide] })
}

function finishTable(table) {
  table.wide = new Map(table.wideEntries.map(([hash, [size, name]]) => [hash, (fileSize) => (size === ANY_SIZE || size === fileSize ? name : null)]))
  return table
}

function lookupTable(table, md5, size) {
  if (!md5) return null
  const key = Buffer.from(md5, 'hex')
  const { records, names } = table
  let low = 0
  let high = records.length / 24 - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const cmp = key.compare(records, mid * 24, mid * 24 + 16)
    if (cmp === 0) {
      // Several signatures can share an MD5 with different sizes: check neighbours.
      let first = mid
      while (first > 0 && key.compare(records, (first - 1) * 24, (first - 1) * 24 + 16) === 0) first -= 1
      for (let i = first; i * 24 < records.length && key.compare(records, i * 24, i * 24 + 16) === 0; i += 1) {
        const recordSize = records.readUInt32BE(i * 24 + 16)
        if (recordSize === ANY_SIZE || recordSize === size) {
          const offset = records.readUInt32BE(i * 24 + 20)
          return names.toString('utf8', offset, names.indexOf(0, offset))
        }
      }
      return null
    }
    if (cmp < 0) high = mid - 1
    else low = mid + 1
  }
  return null
}

/** Cache file: "AEGISHX1" | records length | names length | wide JSON length | records | names | wide JSON. */
async function writeTable(file, table) {
  const wide = Buffer.from(JSON.stringify(table.wideEntries))
  const header = Buffer.alloc(20)
  header.write('AEGISHX1', 0, 'latin1')
  header.writeUInt32BE(table.records.length, 8)
  header.writeUInt32BE(table.names.length, 12)
  header.writeUInt32BE(wide.length, 16)
  await fs.writeFile(`${file}.tmp`, Buffer.concat([header, table.records, table.names, wide]))
  await fs.rename(`${file}.tmp`, file)
}

async function readTable(file) {
  try {
    const data = await fs.readFile(file)
    if (data.toString('latin1', 0, 8) !== 'AEGISHX1') return null
    const recordsLength = data.readUInt32BE(8)
    const namesLength = data.readUInt32BE(12)
    const wideLength = data.readUInt32BE(16)
    let offset = 20
    const records = Buffer.from(data.subarray(offset, offset += recordsLength))
    const names = Buffer.from(data.subarray(offset, offset += namesLength))
    const wideEntries = JSON.parse(data.toString('utf8', offset, offset + wideLength))
    return finishTable({ records, names, wideEntries })
  } catch { return null }
}

/** md5, sha1 and sha256 of a file in one read. */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5')
    const sha1 = crypto.createHash('sha1')
    const sha256 = crypto.createHash('sha256')
    let size = 0
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => { size += chunk.length; md5.update(chunk); sha1.update(chunk); sha256.update(chunk) })
    stream.on('error', reject)
    stream.on('end', () => resolve({ md5: md5.digest('hex'), sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), size }))
  })
}
