/**
 * The dashboard's protection meters. Each is 0-100 (or null when it cannot be
 * judged yet) and the overall score is their weighted average.
 */

const DAY = 24 * 60 * 60 * 1000
const GB = 1024 * 1024 * 1024

const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / DAY : Infinity)
const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)))

export function toneOf(score) {
  if (score === null) return 'off'
  return score >= 80 ? 'ok' : score >= 55 ? 'warn' : 'bad'
}

/**
 * input: { licensed, settings, realtimeRunning, usbSupported, signatures: { count, updatedAt },
 *          lastScanAt (completed device scan after activation, or null), cleaner: { analysis } }
 * Returns [{ id, label, weight, score, detail, action }], action being a key the view maps to a button.
 */
export function computeMeters({ licensed, settings = {}, realtimeRunning, usbSupported = true, signatures = {}, lastScanAt, cleaner = {} }) {
  if (!licensed) {
    return METERS.map((meter) => ({ ...meter, score: null, detail: 'Needs an active licence', action: 'license' }))
  }

  // Real-time protection: on or off.
  const realtime = realtimeRunning
    ? { score: 100, detail: 'Watching Downloads, Desktop and Documents', action: null }
    : { score: 0, detail: 'Off: new files are not checked as they arrive', action: 'realtime' }

  // Threat scanning: how recently this PC was fully checked, and whether scans run on their own.
  let scanning
  if (!lastScanAt) {
    scanning = { score: null, detail: 'Not scanned yet', action: 'scan' }
  } else {
    const days = ageDays(lastScanAt)
    let score = days <= 2 ? 100 : days <= 7 ? 85 : days <= 14 ? 65 : days <= 30 ? 40 : 20
    if (!settings.automaticScanning) score -= 15
    scanning = {
      score: clamp(score),
      detail: `${days < 1 ? 'Checked today' : `Last checked ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`}${settings.automaticScanning ? '' : ' · scheduled scans off'}`,
      action: days > 7 || !settings.automaticScanning ? 'scan' : null,
    }
  }

  // Threat signatures: present, fresh, and kept up to date automatically.
  let signatureMeter
  if (!signatures.count) {
    signatureMeter = { score: 0, detail: 'Not downloaded yet', action: 'updates' }
  } else {
    const days = ageDays(signatures.updatedAt)
    let score = days <= 1.5 ? 100 : days <= 3 ? 85 : days <= 7 ? 60 : 30
    if (!settings.updateChecks) score -= 20
    signatureMeter = {
      score: clamp(score),
      detail: `${(signatures.count / 1e6).toFixed(1)} million signatures · ${days < 1 ? 'updated today' : `updated ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`}${settings.updateChecks ? '' : ' · auto-update off'}`,
      action: days > 3 || !settings.updateChecks ? 'updates' : null,
    }
  }

  // Device security: the protections that work without you.
  const missing = []
  let device = 100
  if (usbSupported && !settings.usbProtection) { device -= 35; missing.push('USB scanning') }
  if (!settings.automaticScanning) { device -= 30; missing.push('scheduled scans') }
  if (!settings.launchAtStartup) { device -= 20; missing.push('start with computer') }
  if (!settings.runInBackground) { device -= 15; missing.push('run in background') }
  const deviceMeter = {
    score: clamp(device),
    detail: missing.length ? `Off: ${missing.join(', ')}` : 'USB, scheduled and startup protection on',
    action: missing.length ? 'protection' : null,
  }

  // PC cleanliness: junk found by the last PC Cleaner analysis.
  let clean
  const analysis = cleaner.analysis
  if (!analysis) {
    clean = { score: null, detail: 'Not checked yet', action: 'cleaner' }
  } else {
    const bytes = analysis.totalBytes || 0
    const score = bytes < 0.25 * GB ? 100 : bytes < GB ? 85 : bytes < 3 * GB ? 65 : bytes < 10 * GB ? 45 : 25
    clean = {
      score,
      detail: bytes ? `${formatSize(bytes)} of junk found` : 'No junk found',
      action: bytes >= 0.25 * GB || ageDays(analysis.at) > 14 ? 'cleaner' : null,
    }
  }

  const values = { realtime, scanning, signatures: signatureMeter, device: deviceMeter, cleanliness: clean }
  return METERS.map((meter) => ({ ...meter, ...values[meter.id] }))
}

const METERS = [
  { id: 'realtime', label: 'Real-time protection', weight: 30 },
  { id: 'scanning', label: 'Threat scanning', weight: 25 },
  { id: 'signatures', label: 'Threat signatures', weight: 20 },
  { id: 'device', label: 'Device security', weight: 15 },
  { id: 'cleanliness', label: 'PC cleanliness', weight: 10 },
]

/** Weighted average of the meters that have a score; null if none do. */
export function overallScore(meters) {
  const scored = meters.filter((meter) => meter.score !== null)
  if (!scored.length) return null
  const weight = scored.reduce((sum, meter) => sum + meter.weight, 0)
  return clamp(scored.reduce((sum, meter) => sum + meter.score * meter.weight, 0) / weight)
}

function formatSize(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`
}
