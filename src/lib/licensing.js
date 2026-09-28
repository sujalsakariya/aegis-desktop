/** Licence helpers shared by the header, dashboard and licence page. */

export const LICENSED_STATES = ['active', 'offline-grace']

export function isLicensed(status) {
  return LICENSED_STATES.includes(status?.state)
}

/** Whole days left, rounded up, or null for a licence that never expires. */
export function daysLeft(status) {
  const expiresAt = status?.license?.payload?.expiresAt
  if (!expiresAt) return null
  const ms = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

/** Label and tone for the header licence chip. */
export function licenseBadge(status) {
  const state = status?.state
  const plan = status?.license?.payload?.plan
  const planLabel = plan === 'THREE_YEAR' ? '3 Years' : plan ? plan.charAt(0) + plan.slice(1).toLowerCase() : ''
  if (isLicensed(status)) {
    const days = daysLeft(status)
    if (days === null) return { tone: 'ok', label: `${planLabel || 'Licensed'} · Lifetime` }
    const tone = days <= 3 ? 'bad' : days <= 7 ? 'warn' : state === 'offline-grace' ? 'warn' : 'ok'
    return { tone, label: `${planLabel} · ${days} day${days === 1 ? '' : 's'} left` }
  }
  if (state === 'checking') return { tone: '', label: 'Checking licence…' }
  if (state === 'expired') return { tone: 'bad', label: 'Licence expired' }
  if (state === 'suspended') return { tone: 'bad', label: 'Licence suspended' }
  if (state === 'revoked') return { tone: 'bad', label: 'Licence revoked' }
  if (state === 'cancelled') return { tone: 'bad', label: 'Licence cancelled' }
  if (state === 'validation-required') return { tone: 'bad', label: 'Licence check needed' }
  return { tone: 'warn', label: 'No licence' }
}
