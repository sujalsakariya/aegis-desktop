export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '—'
}

export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '0s'
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const STEPS = [
  [60_000, 1000, 'second'],
  [3_600_000, 60_000, 'minute'],
  [86_400_000, 3_600_000, 'hour'],
  [604_800_000, 86_400_000, 'day'],
  [2_629_800_000, 604_800_000, 'week'],
  [31_557_600_000, 2_629_800_000, 'month'],
  [Number.POSITIVE_INFINITY, 31_557_600_000, 'year'],
]

export function timeAgo(input) {
  if (!input) return 'Never'
  const time = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(time)) return 'Never'
  const delta = time - Date.now()
  const absolute = Math.abs(delta)
  if (absolute < 45_000) return 'Just now'
  for (const [limit, divisor, unit] of STEPS) {
    if (absolute < limit) return RELATIVE.format(Math.round(delta / divisor), unit)
  }
  return 'Never'
}

export function formatDate(input) {
  if (!input) return '—'
  const time = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(time)) return '—'
  return new Date(time).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(input) {
  if (!input) return '—'
  const time = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(time)) return '—'
  return new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Shortens a long path for display without losing the file name. */
export function shortPath(value, max = 58) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  const separator = text.includes('\\') ? '\\' : '/'
  const parts = text.split(separator)
  const name = parts.pop() || ''
  return `${parts[0] || ''}${separator}…${separator}${name}`.slice(-max)
}

export function titleCase(value) {
  const text = String(value ?? '').replace(/[-_]/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : '—'
}
