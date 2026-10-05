// CI check of the bundled ClamAV inside a built app: downloads the real
// signatures, starts the engine and makes sure it detects a test threat.
//
//   node scripts/engine-smoke.mjs <path to the app's resources/clamav>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClamEngine } from '../electron/engine.js'

const resourcesDir = process.argv[2]
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-smoke-'))
const fail = (message) => { console.error(`FAIL: ${message}`); process.exitCode = 1 }
const engine = new ClamEngine({ resourcesDir, userData })
try {
  await engine.initialize()
  if (!engine.isAvailable()) throw new Error(`no engine in ${resourcesDir}`)
  let t = Date.now()
  await engine.update()
  const info = engine.getInfo()
  console.log(`signatures: ClamAV daily ${info.version}, ${info.signatures.toLocaleString('en-US')} signatures (${((Date.now() - t) / 1000).toFixed(0)}s)`)
  if (!info.ready || info.signatures < 1000000) throw new Error('signatures missing')
  t = Date.now()
  await engine.ensureRunning()
  console.log(`engine started in ${((Date.now() - t) / 1000).toFixed(0)}s`)
  // EICAR inside an email attachment, so only a real engine (not a hash list) finds it.
  const eicar = 'X5O!P%@AP[4' + String.fromCharCode(92) + 'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
  const eml = path.join(userData, 'test.eml')
  fs.writeFileSync(eml, ['Subject: t', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: application/octet-stream; name="t.com"', 'Content-Transfer-Encoding: base64', '', Buffer.from(eicar).toString('base64'), '--B--', ''].join('\r\n'))
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (fs.existsSync(eml)) {
    const result = await engine.scanFile(eml)
    console.log(`test threat: ${JSON.stringify(result)}`)
    if (!result.infected || !/eicar/i.test(result.name)) fail('the engine did not detect the test threat')
  } else {
    console.log('(the system antivirus removed the test file first; skipping detection check)')
  }
  const clean = await engine.scanFile(path.join(resourcesDir, process.platform === 'win32' ? 'COPYING.txt' : 'certs/clamav.crt'))
  if (clean.infected) fail('a clean file was flagged')
  // Wait for the background hash index and check it knows EICAR.
  for (let i = 0; i < 300 && !engine.isIndexReady(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  if (engine.lookupHashes({ md5: '44d88612fea8a8f36de82e1278abb02f', size: 68 }) !== 'Eicar-Test-Signature') fail('hash index does not know EICAR')
  else console.log('hash index: ok')
} catch (error) {
  if (error.output) console.error(`freshclam output:
${error.output}`)
  fail(error.message)
} finally {
  engine.stop()
  setTimeout(() => fs.rmSync(userData, { recursive: true, force: true }), 1500)
}
if (!process.exitCode) console.log('engine smoke test passed')
