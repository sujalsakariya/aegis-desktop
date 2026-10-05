import { useEffect, useRef, useState } from 'react'
import { LockIcon } from './icons'

export function Card({ title, subtitle, actions, children, bodyClass = '', className = '' }) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <div>
              <h3>{title}</h3>
              {subtitle && <div className="sub">{subtitle}</div>}
            </div>
          )}
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`card-body ${bodyClass}`.trim()}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, note }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`value ${String(value).length > 9 ? 'sm' : ''}`.trim()}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'on' : ''}`.trim()}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function SettingRow({ title, description, children }) {
  return (
    <div className="setting-row">
      <div className="text">
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      {children}
    </div>
  )
}

export function Empty({ glyph = '✓', title, children }) {
  return (
    <div className="empty">
      <div className="glyph" aria-hidden="true">{glyph}</div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}

/** Shown in place of a feature that needs an active licence. */
export function LicenseLock({ title = 'An active licence is required', children, onActivate }) {
  return (
    <div className="lock-panel">
      <span className="lock-badge"><LockIcon size={26} filled /></span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {onActivate && (
        <button type="button" className="btn btn-primary btn-sm" onClick={onActivate}>Activate a licence</button>
      )}
    </div>
  )
}

export function Banner({ tone = '', children }) {
  return <div className={`banner ${tone}`.trim()}>{children}</div>
}

export function KeyValue({ label, children }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  )
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * A number that glides to each new value (ease-out), starting from `from` on
 * first render. Used so scores and counters count up instead of jumping.
 */
export function useCountUp(target, { duration = 1100, from = 0 } = {}) {
  const [value, setValue] = useState(reducedMotion() ? target : from)
  const shown = useRef(reducedMotion() ? target : from)

  useEffect(() => {
    const start = shown.current
    if (reducedMotion() || start === target) {
      shown.current = target
      setValue(target)
      return undefined
    }
    let frame = 0
    const began = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - began) / duration)
      const eased = 1 - (1 - t) ** 3
      shown.current = start + (target - start) * eased
      setValue(shown.current)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])

  return value
}

/** A count that animates up to `value`; `format` turns it into text. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString() }) {
  const shown = useCountUp(Number(value) || 0)
  return <>{format(shown)}</>
}

const RING_COLOURS = { ok: 'var(--sys-green)', warn: 'var(--sys-orange)', bad: 'var(--sys-red)', scan: 'var(--sys-blue)' }

/**
 * The score ring (Apple activity-ring style). The ring and the number count up
 * from 0 to `score`. With `pending` set there is no score yet and the ring shows
 * that label instead ("Not scanned"). `tone="scan"` colours it for a scan in
 * progress, and `caption` replaces the label under the number.
 */
export function Shield({ score, tone = 'ok', pending = null, busy = false, label = 'Score', caption = null, size = '' }) {
  const radius = 56
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Number(score) || 0))
  const shown = useCountUp(pending ? 0 : clamped, { duration: tone === 'scan' ? 700 : 1300 })
  const stroke = RING_COLOURS[tone] || RING_COLOURS.ok

  if (pending) {
    return (
      <div className={`shield shield-pending${busy ? ' is-busy' : ''}${size ? ` shield-${size}` : ''}`} role="img" aria-label={pending}>
        <svg viewBox="0 0 132 132" aria-hidden="true">
          <circle className="track" cx="66" cy="66" r={radius} />
          {busy && <circle className="arc" cx="66" cy="66" r={radius} style={{ stroke: RING_COLOURS.scan }} strokeDasharray={`${circumference * 0.25} ${circumference}`} />}
        </svg>
        <div className="inner">
          <strong>{busy ? '…' : '—'}</strong>
          <span>{pending}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`shield${size ? ` shield-${size}` : ''}${tone === 'scan' ? ' is-scanning' : ''}`} style={{ '--ring': stroke }} role="img" aria-label={`${label}: ${clamped} out of 100`}>
      <svg viewBox="0 0 132 132" aria-hidden="true">
        <circle className="track" cx="66" cy="66" r={radius} />
        {shown > 0.2 && (
          <circle
            className="arc"
            cx="66"
            cy="66"
            r={radius}
            style={{ stroke }}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - shown / 100)}
          />
        )}
      </svg>
      <div className="inner">
        <strong>{Math.round(shown)}</strong>
        <span>{caption || label}</span>
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', tone = 'danger', onConfirm, onCancel }) {
  const confirmRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    confirmRef.current?.focus()
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} type="button" className={`btn btn-sm ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`.trim()}>
          <div>
            <strong>{toast.title}</strong>
            {toast.body && <p>{toast.body}</p>}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

/** Toast queue with auto-expiry. */
export function useToasts() {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = (id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }

  const push = (title, body = '', tone = '') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    // The same message again (say, a button clicked repeatedly) replaces the
    // one on screen instead of stacking copies.
    setToasts((current) => {
      const others = current.filter((toast) => {
        const same = toast.title === title && toast.body === body && toast.tone === tone
        if (same) { clearTimeout(timers.current.get(toast.id)); timers.current.delete(toast.id) }
        return !same
      })
      return [...others.slice(-3), { id, title, body, tone }]
    })
    timers.current.set(id, setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 5000))
  }

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  return {
    toasts,
    dismiss,
    notify: (title, body) => push(title, body, ''),
    warn: (title, body) => push(title, body, 'warn'),
    fail: (title, body) => push(title, body, 'error'),
  }
}
