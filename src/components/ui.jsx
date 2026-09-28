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
      <span className="lock-badge"><LockIcon size={26} /></span>
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

/** Circular protection score. */
/**
 * The protection score ring. With `pending` set there is no score yet: the ring
 * shows that label instead ("Not scanned"), and `busy` makes it spin while the
 * first scan runs.
 */
export function Shield({ score, tone = 'ok', pending = null, busy = false }) {
  const radius = 56
  const circumference = 2 * Math.PI * radius
  if (pending) {
    return (
      <div className={`shield shield-pending${busy ? ' is-busy' : ''}`} role="img" aria-label={pending}>
        <svg viewBox="0 0 132 132" aria-hidden="true">
          <circle className="track" cx="66" cy="66" r={radius} />
          {busy && <circle className="arc" cx="66" cy="66" r={radius} style={{ stroke: 'var(--brand-a)' }} strokeDasharray={`${circumference * 0.25} ${circumference}`} />}
        </svg>
        <div className="inner">
          <strong>{busy ? '…' : '—'}</strong>
          <span>{pending}</span>
        </div>
      </div>
    )
  }
  const clamped = Math.max(0, Math.min(100, Number(score) || 0))
  // Theme-aware colours from index.css.
  const stroke = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn-dot)' : 'var(--brand-a)'

  return (
    <div className="shield">
      <svg viewBox="0 0 132 132" aria-hidden="true">
        <circle className="track" cx="66" cy="66" r={radius} />
        <circle
          className="arc"
          cx="66"
          cy="66"
          r={radius}
          style={{ stroke }}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      </svg>
      <div className="inner">
        <strong>{clamped}</strong>
        <span>Score</span>
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
    setToasts((current) => [...current.slice(-3), { id, title, body, tone }])
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
