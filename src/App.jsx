import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, ConfirmDialog, ToastStack, useToasts } from './components/ui'
import {
  DashboardIcon,
  LicenseIcon,
  ProtectionIcon,
  QuarantineIcon,
  ScanIcon,
  SettingsIcon,
  UpdatesIcon,
  UserIcon,
} from './components/icons'
import { useAegis } from './lib/useAegis'
import { isLicensed, licenseBadge } from './lib/licensing'
import * as api from './lib/bridge'
import Dashboard from './views/Dashboard'
import Scan from './views/Scan'
import Quarantine from './views/Quarantine'
import Protection from './views/Protection'
import Updates from './views/Updates'
import License from './views/License'
import Settings from './views/Settings'

const NAV = [
  ['dashboard', 'Dashboard', DashboardIcon, 'An overview of how this device is protected.'],
  ['scan', 'Scan', ScanIcon, 'Check files and folders against the signature set.'],
  ['quarantine', 'Quarantine', QuarantineIcon, 'Files that were isolated so they cannot run.'],
  ['protection', 'Protection', ProtectionIcon, 'Real-time watching, removable drives and schedules.'],
  ['updates', 'Updates', UpdatesIcon, 'Threat definitions and application builds.'],
  ['license', 'Licence', LicenseIcon, 'Your account and this device’s licence.'],
  ['settings', 'Settings', SettingsIcon, 'Preferences, exclusions and app information.'],
]

// Turned on for the first licensed run so the device ends up fully protected.
// Later re-activations keep whatever the user has chosen since.
const RECOMMENDED = { realTimeProtection: true, automaticScanning: true, usbProtection: true, updateChecks: true }

/** What the customer is told when their licence state changes on the server. */
const ADMIN_LICENCE_CHANGES = {
  suspended: ['fail', 'Licence suspended', 'Your licence was suspended, so protection is off. Contact support to reactivate it.'],
  revoked: ['fail', 'Licence revoked', 'Your licence was revoked, so protection is off. Contact support if you think this is a mistake.'],
  cancelled: ['fail', 'Licence cancelled', 'Your licence was cancelled, so protection is off.'],
  expired: ['fail', 'Licence expired', 'Your licence has expired, so protection is off. Renew it to protect this PC again.'],
  active: ['notify', 'Licence active again', 'Your licence was reactivated. Protection is back on.'],
}

function App() {
  const toasts = useToasts()
  const notifyError = useCallback((title, body) => toasts.fail(title, body), []) // eslint-disable-line react-hooks/exhaustive-deps
  const state = useAegis(notifyError)
  const [view, setView] = useState('dashboard')
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  // 'idle' | 'preparing' (downloading definitions) | 'running' (first scan started)
  const [firstScan, setFirstScan] = useState('idle')
  const firstScanClaimed = useRef(false)

  const current = NAV.find(([key]) => key === view) || NAV[0]
  const realtimeOn = Boolean(state.realtimeStatus?.running)
  const scanning = ['running', 'paused'].includes(state.scannerStatus?.state)
  const quarantineCount = state.quarantineItems.length
  const licensed = isLicensed(state.licenseStatus)
  const badge = licenseBadge(state.licenseStatus)
  const account = state.account
  const hasSignatures = Boolean(state.definitionInfo?.count)
  const protectedNow = licensed && realtimeOn && hasSignatures

  const quickScan = async () => {
    if (!licensed) {
      setView('license')
      toasts.warn('Licence required', 'Activate a licence to scan this device.')
      return
    }
    const result = await api.scanner.start({ mode: 'quick' })
    if (result.ok) {
      state.setScannerStatus(result.data)
      setView('scan')
      toasts.notify('Quick scan started', 'Checking Downloads, Desktop, Documents and startup items.')
    } else {
      toasts.fail('Could not start the scan', result.error)
    }
  }

  const toggleRealtime = async () => {
    if (!licensed) {
      setView('license')
      toasts.warn('Licence required', 'Activate a licence to turn on real-time protection.')
      return
    }
    const next = !realtimeOn
    const result = await state.updateSettings({ realTimeProtection: next })
    if (result.ok) toasts.notify(next ? 'Real-time protection on' : 'Real-time protection off')
  }

  /**
   * The first time a licensed user reaches the dashboard: switch every
   * protection module on, make sure signatures are installed, and run a quick
   * scan. Runs once per install (settings.firstScanCompleted), not on every
   * re-activation.
   */
  const runFirstScan = useCallback(async () => {
    if (firstScanClaimed.current) return
    firstScanClaimed.current = true
    setView('dashboard')
    await state.updateSettings(RECOMMENDED)
    // A scan without signatures cannot detect anything, so get them first.
    let signatures = state.definitionInfo?.count || 0
    if (!signatures) {
      setFirstScan('preparing')
      const installed = await api.updates.installDefinitions()
      const info = await state.refreshDefinitions()
      await state.refreshHistory()
      signatures = info?.ok ? info.data?.count || 0 : 0
      if (!installed.ok || !signatures) {
        setFirstScan('idle')
        // Leave firstScanCompleted unset so it is tried again on the next launch.
        toasts.warn('First scan postponed', `Threat definitions could not be installed, so a scan would not detect anything yet. ${installed.error || ''} Open Updates to retry.`)
        return
      }
    }
    const result = await api.scanner.start({ mode: 'quick' })
    if (result.ok) {
      state.setScannerStatus(result.data)
      setFirstScan('running')
      await state.updateSettings({ firstScanCompleted: true })
      toasts.notify('Your PC is now protected', 'Real-time protection is on. Running your first quick scan.')
    } else {
      setFirstScan('idle')
      firstScanClaimed.current = false
      toasts.fail('Protection is on, but the first scan did not start', result.error)
    }
  }, [state, toasts])

  // Existing installs that were licensed before this flow existed get their
  // first scan the next time the app opens.
  useEffect(() => {
    if (!state.ready || !licensed || !state.settings || state.settings.firstScanCompleted) return
    if (state.scannerStatus?.state === 'running' || state.scannerStatus?.state === 'paused') return
    void runFirstScan()
  }, [state.ready, licensed, state.settings, state.scannerStatus?.state, runFirstScan])

  useEffect(() => {
    if (firstScan === 'running' && !['running', 'paused'].includes(state.scannerStatus?.state)) setFirstScan('idle')
  }, [firstScan, state.scannerStatus?.state])

  // Tell the customer when an administrator changes their licence (noticed at
  // the next licence check: on launch, then every 6 hours). Only changes of the same licence are announced:
  // activating, logging in or out has its own messages.
  const lastLicence = useRef(null)
  useEffect(() => {
    const status = state.licenseStatus
    const payload = status?.license?.payload
    if (!status || status.state === 'checking') return
    const now = { state: status.state, licenseId: payload?.licenseId || null, expiresAt: payload?.expiresAt || null }
    const before = lastLicence.current
    lastLicence.current = now
    if (!before || !now.licenseId || before.licenseId !== now.licenseId) return
    const message = ADMIN_LICENCE_CHANGES[now.state]
    // "Active again" only after an admin-side stop, not when a PC simply comes back online.
    const reactivated = now.state !== 'active' || ['suspended', 'revoked', 'cancelled', 'expired'].includes(before.state)
    if (before.state !== now.state && message && reactivated) {
      const [kind, title, body] = message
      toasts[kind](title, body)
      return
    }
    if (now.state === 'active' && before.expiresAt && now.expiresAt && Date.parse(now.expiresAt) > Date.parse(before.expiresAt)) {
      toasts.notify('Licence extended', `Your licence now runs until ${new Date(now.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`)
    }
  }, [state.licenseStatus, toasts])

  /** After a licence is activated, or restored for a returning customer who entered their details. */
  const onActivated = async ({ restored = false } = {}) => {
    if (restored) toasts.notify('Welcome back', 'Your licence is active again on this PC. No key needed.')
    if (!state.settings?.firstScanCompleted) {
      await runFirstScan()
      return
    }
    setView('dashboard')
    if (!restored) toasts.notify('Licence activated', 'This PC is protected again with your saved protection settings.')
  }

  const signOut = async () => {
    setConfirmSignOut(false)
    const result = await state.signOut()
    if (result.ok) {
      setView('license')
      toasts.notify('Logged out', 'This device’s licence seat was released. Enter your details to use Aegis again.')
    } else {
      toasts.fail('Could not log out', result.error)
    }
  }

  const go = (key) => setView(key)

  const views = {
    dashboard: <Dashboard state={state} onQuickScan={quickScan} onToggleRealtime={toggleRealtime} onNavigate={go} firstScan={firstScan} />,
    scan: <Scan state={state} toasts={toasts} onNavigate={go} />,
    quarantine: <Quarantine state={state} toasts={toasts} />,
    protection: <Protection state={state} toasts={toasts} onNavigate={go} />,
    updates: <Updates state={state} toasts={toasts} />,
    license: <License state={state} toasts={toasts} onActivated={onActivated} onSignOut={() => setConfirmSignOut(true)} />,
    settings: <Settings state={state} toasts={toasts} />,
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="mark" aria-hidden="true"><span /></span>
          <strong>Aegis<em>.</em></strong>
        </div>

        <nav className="nav" aria-label="Sections">
          {NAV.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              className={`nav-item ${view === key ? 'active' : ''}`.trim()}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => setView(key)}
            >
              <span className="ico" aria-hidden="true"><Icon size={18} /></span>
              <span>{label}</span>
              {key === 'quarantine' && quarantineCount > 0 && <span className="count">{quarantineCount}</span>}
              {key === 'license' && !licensed && <span className="count warn">!</span>}
            </button>
          ))}
        </nav>

        <div className={`side-status ${protectedNow ? 'ok' : 'bad'}`}>
          <div className="label">Protection</div>
          <strong>
            <span className={`dot ${protectedNow ? 'ok' : licensed ? 'warn' : 'bad'}`} />
            {protectedNow ? 'Protected' : licensed ? 'Partially protected' : 'Not protected'}
          </strong>
          <p>
            {!licensed
              ? 'Activate a licence to turn protection on'
              : !hasSignatures
                ? 'Threat definitions are not installed'
                : realtimeOn
                  ? 'Watching for new files'
                  : 'Real-time checks are off'}
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{current[1]}</h1>
            <div className="sub">{current[3]}</div>
          </div>
          <div className="spacer" />
          {scanning && <span className="chip warn"><span className="dot warn" /> Scanning</span>}
          <button type="button" className={`chip chip-button ${badge.tone}`} onClick={() => setView('license')} title="Open licence details">
            <LicenseIcon size={14} />
            {badge.label}
          </button>
          {account ? (
            <button type="button" className="account-chip chip-button" onClick={() => setView('license')} title={account.offline ? 'Server unreachable. Showing the details saved on this device.' : 'Your details'}>
              <span className="avatar"><UserIcon size={14} /></span>
              <span className="email" title={account.email}>{account.name || (account.username ? `@${account.username}` : account.email)}</span>
              {account.offline && <span className="dot warn" />}
            </button>
          ) : (
            <button type="button" className="chip chip-button" onClick={() => setView('license')}>
              <UserIcon size={14} />
              Enter your details
            </button>
          )}
        </header>

        <main className="content">
          <div className="content-inner">
            {state.licenseStatus?.sessionExpired && !account && view !== 'license' && (
              <Banner tone="warn">
                <span className="dot warn" />
                <p><strong>Please enter your details again.</strong> They are no longer saved on this PC, so its licence cannot be re-checked. Protection keeps running for now.</p>
                <span className="spacer" />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setView('license')}>Enter details</button>
              </Banner>
            )}
            {state.bridgeError && (
              <Banner tone="warn">
                <span className="dot warn" />
                <p><strong>Limited mode.</strong> {state.bridgeError}</p>
              </Banner>
            )}
            {state.ready ? views[view] : (
              <div className="empty"><strong>Loading your device state…</strong></div>
            )}
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={confirmSignOut}
        title="Log out of Aegis?"
        body="Logging out removes your details from this PC and releases its licence seat, so scanning and real-time protection turn off until you enter your details and activate your licence again."
        confirmLabel="Log out"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={signOut}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  )
}

export default App
