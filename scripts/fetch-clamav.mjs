// Downloads the official ClamAV build for this platform and keeps only what
// Aegis ships: the scanning daemon (clamd -> aegis-engine), the signature
// updater (freshclam -> aegis-updater), their libraries, the CVD signing
// certificate and the license texts. The programs are renamed (and on Windows
// their displayed description changed) so the app shows no third-party brand;
// copyright and license notices are kept.
//
//   node scripts/fetch-clamav.mjs          # current platform -> vendor/engine/<platform>
//
// The archives are pinned by SHA-256, so a tampered download fails the build.
// macOS must run this on a Mac (it re-points library paths and re-signs).
// ClamAV is GPL-2.0: the release workflow publishes the matching source
// tarball next to the installers.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLAMAV_VERSION = '1.5.4'
const RELEASE = `https://github.com/Cisco-Talos/clamav/releases/download/clamav-${CLAMAV_VERSION}`
const ARTIFACTS = {
  win32: { file: `clamav-${CLAMAV_VERSION}.win.x64.zip`, sha256: '0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395' },
  darwin: { file: `clamav-${CLAMAV_VERSION}.macos.universal.pkg`, sha256: 'df7fa753e2f9f67f3bc99b2a40a3be7ef559088c68ad6bdf66b4b5764e965bd6' },
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platform = process.argv[2] || process.platform
const artifact = ARTIFACTS[platform]
if (!artifact) {
  console.error(`No ClamAV build is configured for ${platform}.`)
  process.exit(1)
}
const out = path.join(root, 'vendor', 'engine', platform)
const LAYOUT = 'aegis-names-2'
const stamp = path.join(out, '.version')
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === `${CLAMAV_VERSION} ${artifact.sha256} ${LAYOUT}`) {
  console.log(`ClamAV ${CLAMAV_VERSION} for ${platform} is already in ${path.relative(root, out)}`)
  process.exit(0)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-clamav-'))
const download = path.join(work, artifact.file)
console.log(`Downloading ${artifact.file}…`)
const response = await fetch(`${RELEASE}/${artifact.file}`)
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
fs.writeFileSync(download, Buffer.from(await response.arrayBuffer()))
const actual = createHash('sha256').update(fs.readFileSync(download)).digest('hex')
if (actual !== artifact.sha256) throw new Error(`Checksum mismatch for ${artifact.file}: expected ${artifact.sha256}, got ${actual}`)
console.log('Checksum verified.')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }

if (platform === 'win32') {
  const extract = path.join(work, 'x')
  fs.mkdirSync(extract)
  // tar.exe in Windows 10+ (bsdtar) reads zip files.
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', download, '-C', extract])
  const src = path.join(extract, fs.readdirSync(extract).find((name) => name.startsWith('clamav-')))
  for (const name of fs.readdirSync(src)) {
    if (/\.dll$/i.test(name) || name === 'COPYING.txt') copy(path.join(src, name), path.join(out, name))
  }
  copy(path.join(src, 'clamd.exe'), path.join(out, 'aegis-engine.exe'))
  copy(path.join(src, 'freshclam.exe'), path.join(out, 'aegis-updater.exe'))
  // Task Manager shows FileDescription; rcedit ships with electron-builder's toolchain.
  const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
  if (fs.existsSync(rcedit)) {
    for (const [file, description] of [['aegis-engine.exe', 'Aegis scanning engine'], ['aegis-updater.exe', 'Aegis signature updater']]) {
      execFileSync(rcedit, [path.join(out, file), '--set-version-string', 'FileDescription', description, '--set-version-string', 'ProductName', 'Aegis', '--set-version-string', 'OriginalFilename', file, '--set-version-string', 'InternalName', file.replace('.exe', '')])
    }
  } else {
    console.warn('rcedit not found: program descriptions keep their original text.')
  }
  copy(path.join(src, 'certs', 'clamav.crt'), path.join(out, 'certs', 'clamav.crt'))
  if (fs.statSync(path.join(src, 'COPYING')).isDirectory()) fs.cpSync(path.join(src, 'COPYING'), path.join(out, 'COPYING'), { recursive: true })
} else {
  if (process.platform !== 'darwin') throw new Error('The macOS ClamAV build can only be prepared on a Mac.')
  const expanded = path.join(work, 'pkg')
  execFileSync('pkgutil', ['--expand-full', download, expanded])
  const part = (name) => path.join(expanded, fs.readdirSync(expanded).find((entry) => entry.includes(`-${name}.pkg`)), 'Payload', 'usr', 'local', 'clamav')
  const programs = part('programs')
  const libraries = part('libraries')
  copy(path.join(programs, 'sbin', 'clamd'), path.join(out, 'bin', 'aegis-engine'))
  copy(path.join(programs, 'bin', 'freshclam'), path.join(out, 'bin', 'aegis-updater'))
  copy(path.join(programs, 'etc', 'certs', 'clamav.crt'), path.join(out, 'certs', 'clamav.crt'))
  // Keep each library under the versioned name the binaries ask for
  // (@rpath/libclamav.12.dylib), resolving the package's symlinks.
  for (const name of fs.readdirSync(path.join(libraries, 'lib'))) {
    // Only the name the binaries load (libclamav.12.dylib); the other names are
    // symlinks to the same file and would triple the size.
    if (!/^lib[a-z_]+\.\d+\.dylib$/.test(name)) continue
    const full = path.join(libraries, 'lib', name)
    copy(fs.realpathSync(full), path.join(out, 'lib', name))
  }
  for (const name of ['COPYING', 'COPYING.txt']) {
    for (const base of [programs, libraries, path.join(programs, 'share', 'doc', 'clamav')]) {
      const candidate = path.join(base, name)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { copy(candidate, path.join(out, 'COPYING.txt')); break }
    }
  }
  // The package looks for its libraries in /usr/local/clamav/lib; ours live in ../lib.
  for (const binary of ['aegis-engine', 'aegis-updater']) {
    const file = path.join(out, 'bin', binary)
    fs.chmodSync(file, 0o755)
    execFileSync('install_name_tool', ['-add_rpath', '@executable_path/../lib', file])
  }
  // Changing load commands invalidates the original signature; Apple silicon
  // refuses to run unsigned code, so sign everything again (ad-hoc).
  for (const dir of ['lib', 'bin']) {
    for (const name of fs.readdirSync(path.join(out, dir))) execFileSync('codesign', ['--force', '--sign', '-', path.join(out, dir, name)])
  }
}

fs.writeFileSync(stamp, `${CLAMAV_VERSION} ${artifact.sha256} ${LAYOUT}\n`)
fs.rmSync(work, { recursive: true, force: true })
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0)
console.log(`ClamAV ${CLAMAV_VERSION} ready in ${path.relative(root, out)} (${(size(out) / 1048576).toFixed(0)} MB)`)
