import { useState } from 'react'
import { Banner, Card, ConfirmDialog, KeyValue } from '../components/ui'
import { CheckCircleIcon, ClockIcon, LicenseIcon, LogoutIcon, UserIcon } from '../components/icons'
import * as api from '../lib/bridge'
import { daysLeft, isLicensed } from '../lib/licensing'
import { formatDate, timeAgo, titleCase } from '../lib/format'

const KEY_PATTERN = /^AVP-(?:[A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/i
// Same rule as the server: 3-24 characters, letters, numbers, dots and underscores.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._]{1,22})[a-z0-9]$/

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The 10 national digits of a US number (a leading 1 is dropped). */
function usDigits(value) {
  const digits = value.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.slice(0, 10)
}

/** Formats typing into the (212) 555-0123 shape. */
function formatPhone(value) {
  const d = usDigits(value)
  if (d.length < 4) return d
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

function nameProblem(value) {
  return value.trim().length < 2 ? 'Enter your full name.' : null
}

// Same rule as the server: a 10-digit US number whose area code and exchange do not start with 0 or 1.
function phoneProblem(value) {
  if (!value.trim()) return 'Enter your phone number.'
  const d = usDigits(value)
  if (d.length !== 10) return 'Enter a 10-digit US phone number, e.g. (212) 555-0123.'
  if (/^[01]/.test(d)) return `US area codes never start with ${d[0]}. Check the first 3 digits, e.g. (212) 555-0123.`
  if (/^[01]/.test(d.slice(3))) return `In a US number the 3 digits after the area code never start with ${d[3]} (you entered ${d.slice(3, 6)}). Check the number, e.g. (212) 555-0123.`
  return null
}

/** First problem with the details form, or null when it can be sent. */
function profileProblem(profile) {
  const username = profile.username.trim().toLowerCase()
  if (nameProblem(profile.name)) return nameProblem(profile.name)
  if (!username) return 'Choose a username.'
  if (!USERNAME_PATTERN.test(username)) return 'Use 3–24 letters, numbers, dots or underscores for the username, starting and ending with a letter or number.'
  if (!EMAIL_PATTERN.test(profile.email.trim())) return 'Enter a valid email address.'
  return phoneProblem(profile.phone) || keyProblem(profile.licenseKey)
}

const EMPTY_PROFILE = { name: '', username: '', email: '', phone: '', licenseKey: '' }

/** First problem with the returning-customer form (the licence key alone), or null. */
function loginProblem(profile) {
  return keyProblem(profile.licenseKey)
}

const STATE_COPY = {
  active: ['ok', 'This device is protected by an active licence.'],
  'offline-grace': ['warn', 'The licence server could not be reached, so the last verified licence is being used for up to 72 hours.'],
  'validation-required': ['bad', 'The licence could not be re-checked for too long. Protection is off until the server confirms it.'],
  expired: ['bad', 'This licence has expired. Protection is off.'],
  suspended: ['bad', 'This licence is suspended. Protection is off.'],
  revoked: ['bad', 'This licence has been revoked. Protection is off.'],
  cancelled: ['bad', 'This licence has been cancelled. Protection is off.'],
  unlicensed: ['warn', 'No licence is activated on this device. Protection is off.'],
  checking: ['', 'Checking this device’s licence with the server…'],
}

/** An admin-panel licence id (a cuid such as cmul3a4740002fcw07hotogft), which people paste by mistake. */
const LICENCE_ID_PATTERN = /^c[a-z0-9]{20,32}$/
const LICENCE_ID_MESSAGE = 'That is the licence ID from the admin panel, not the licence key. In the admin panel open Licences, click "Show key" and copy the key (AVP-XXXX-XXXX-XXXX-XXXX).'

/** Formats typing into the AVP-XXXX-XXXX-XXXX-XXXX shape. */
function formatKey(value) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^AVP/, '')
  const groups = cleaned.slice(0, 16).match(/.{1,4}/g) || []
  return groups.length ? `AVP-${groups.join('-')}` : value ? 'AVP-' : ''
}

function keyProblem(value) {
  const key = value.trim()
  if (!key) return 'Enter the licence key from your purchase email.'
  if (/[01IO]/.test(key.replace(/^AVP-/, ''))) {
    return `Licence keys never contain 0, 1, I or O. ${LICENCE_ID_MESSAGE}`
  }
  if (!KEY_PATTERN.test(key)) return 'A licence key looks like AVP-XXXX-XXXX-XXXX-XXXX.'
  return null
}

function License({ state, toasts, onActivated, onSignOut }) {
  const { licenseStatus, setLicenseStatus, account, setAccount } = state
  const [profile, setProfile] = useState(EMPTY_PROFILE)
  const [profileError, setProfileError] = useState(null)
  // Both forms need the licence key. 'new' creates the account with all four
  // details and activates the key in one step; 'returning' logs in with email + key.
  const [mode, setMode] = useState('new')
  const [editing, setEditing] = useState(null)
  const [licenseKey, setLicenseKey] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [confirmOff, setConfirmOff] = useState(false)

  const licensed = isLicensed(licenseStatus)
  const payload = licenseStatus?.license?.payload
  const days = daysLeft(licenseStatus)
  const [tone, baseMessage] = STATE_COPY[licenseStatus?.state] || ['warn', 'Licence state is unknown.']
  const detailsMissing = Boolean(licenseStatus?.sessionExpired && !account)
  const message = detailsMissing
    ? 'Your details are no longer saved on this PC, so the licence cannot be re-checked. Protection keeps running for now — enter your details below.'
    : baseMessage

  const setField = (key) => (event) => {
    if (key === 'licenseKey' && LICENCE_ID_PATTERN.test(event.target.value.trim())) {
      setProfile((current) => ({ ...current, licenseKey: '' }))
      setProfileError(LICENCE_ID_MESSAGE)
      return
    }
    const value = key === 'phone' ? formatPhone(event.target.value) : key === 'licenseKey' ? formatKey(event.target.value) : event.target.value
    setProfile((current) => ({ ...current, [key]: value }))
    setProfileError(null)
  }

  const saveProfile = async (event) => {
    event.preventDefault()
    const returning = mode === 'returning'
    const problem = returning ? loginProblem(profile) : profileProblem(profile)
    if (problem) {
      setProfileError(problem)
      return
    }
    setBusy('profile')
    const email = profile.email.trim().toLowerCase()
    const key = profile.licenseKey.trim()
    const result = returning
      ? await api.license.keyLogin('', key)
      : await api.license.signUp({ name: profile.name.trim(), username: profile.username.trim().toLowerCase(), email, phone: profile.phone.trim() }, key)
    setBusy('')
    if (result.ok) {
      const { restoredLicense, activationError, ...saved } = result.data || {}
      setAccount(saved)
      setProfile(EMPTY_PROFILE)
      if (restoredLicense) {
        await onActivated?.({ restored: returning })
      } else if (activationError) {
        toasts.warn('Logged in, but the licence is not active here', activationError)
      }
    } else {
      setProfileError(result.error)
    }
  }

  const updateProfile = async (event) => {
    event.preventDefault()
    const problem = nameProblem(editing.name) || phoneProblem(editing.phone)
    if (problem) {
      setProfileError(problem)
      return
    }
    setBusy('update')
    const result = await api.license.updateProfile({ name: editing.name.trim(), phone: editing.phone.trim() })
    setBusy('')
    if (result.ok) {
      setAccount(result.data)
      setEditing(null)
      toasts.notify('Details updated', 'Your name and phone number were saved.')
    } else {
      setProfileError(result.error)
    }
  }

  const activate = async (event) => {
    event.preventDefault()
    setError(null)
    const problem = keyProblem(licenseKey)
    if (problem) {
      setError(problem)
      return
    }
    setBusy('activate')
    const result = await api.license.activate(licenseKey.trim())
    setBusy('')
    if (result.ok) {
      setLicenseStatus(result.data)
      setLicenseKey('')
      await onActivated?.()
    } else {
      setError(result.error)
      // The server stopped accepting the saved details: show the details form again.
      if (/enter your details/i.test(result.error || '')) await state.refreshAccount()
    }
  }

  const validate = async () => {
    setBusy('validate')
    const result = await api.license.validate()
    setBusy('')
    if (result.ok) {
      setLicenseStatus(result.data)
      toasts.notify('Licence re-checked', STATE_COPY[result.data?.state]?.[1] || `State is now ${result.data?.state}.`)
    } else {
      toasts.fail('Could not validate the licence', result.error)
    }
  }

  const deactivate = async () => {
    setBusy('deactivate')
    const result = await api.license.deactivate()
    setBusy('')
    if (result.ok) {
      setLicenseStatus(result.data)
      toasts.notify('Device deactivated', 'The licence seat was released. You can activate it again with the same key.')
    } else {
      toasts.fail('Could not deactivate', result.error)
    }
  }

  const keyField = (
    <div className="field">
      <label htmlFor="profile-licence-key">Licence key</label>
      <input id="profile-licence-key" className="input mono" required value={profile.licenseKey} onChange={setField('licenseKey')} placeholder="AVP-XXXX-XXXX-XXXX-XXXX" spellCheck="false" autoComplete="off" />
    </div>
  )

  const accountCard = account ? (
    <Card
      title="Your details"
      subtitle={account.offline ? 'Can’t reach Aegis right now, showing the details saved on this PC' : 'Registered on this PC'}
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut} title="Log out: removes your details and the licence from this PC">
          <LogoutIcon size={14} /> Log out
        </button>
      }
    >
      {editing ? (
        <form className="stack" onSubmit={updateProfile} style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="profile-edit-name">Full name</label>
            <input id="profile-edit-name" className="input" autoComplete="name" value={editing.name} onChange={(event) => { setEditing({ ...editing, name: event.target.value }); setProfileError(null) }} />
          </div>
          <div className="field">
            <label htmlFor="profile-edit-phone">Phone</label>
            <input id="profile-edit-phone" className="input" type="tel" autoComplete="tel" value={editing.phone} onChange={(event) => { setEditing({ ...editing, phone: formatPhone(event.target.value) }); setProfileError(null) }} placeholder="(212) 555-0123" />
          </div>
          {profileError && <div className="form-error">{profileError}</div>}
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'update'}>{busy === 'update' ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'update'} onClick={() => { setEditing(null); setProfileError(null) }}>Cancel</button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>To change your email or username, contact support.</p>
        </form>
      ) : (
        <>
          <div className="row" style={{ alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <span className="account-chip" style={{ padding: 4 }}><span className="avatar"><UserIcon size={14} filled /></span></span>
            <div>
              <strong style={{ display: 'block' }}>{account.name || (account.username ? `@${account.username}` : account.email)}</strong>
              {account.username && <span className="muted" style={{ fontSize: 12.5 }}>@{account.username}</span>}
            </div>
          </div>
          <KeyValue label="Email">{account.email}</KeyValue>
          <KeyValue label="Phone">{account.phone || <span className="muted">Not set</span>}</KeyValue>
          {!account.offline && (
            <div className="row wrap" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing({ name: account.name || '', phone: formatPhone(account.phone || '') }); setProfileError(null) }}>
                Edit details
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  ) : (
    <Card title={mode === 'returning' ? 'Log in' : 'Create your account'} subtitle="No password needed">
      <div className="segmented" role="tablist" aria-label="Account">
        {[['new', 'New customer'], ['returning', 'I already have an account']].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={mode === key} className={mode === key ? 'active' : ''} onClick={() => { setMode(key); setProfileError(null) }}>
            {label}
          </button>
        ))}
      </div>
      <form className="stack" onSubmit={saveProfile} style={{ gap: 14, marginTop: 16 }}>
        {mode === 'new' && (
          <div className="field">
            <label htmlFor="profile-name">Full name</label>
            <input id="profile-name" className="input" autoComplete="name" required value={profile.name} onChange={setField('name')} placeholder="e.g. John Smith" />
          </div>
        )}
        {mode === 'new' && (
          <div className="field">
            <label htmlFor="profile-username">Username</label>
            <input id="profile-username" className="input" autoComplete="username" required value={profile.username} onChange={setField('username')} placeholder="e.g. john_pc" spellCheck="false" />
          </div>
        )}
        {mode === 'new' && (
          <div className="field">
            <label htmlFor="profile-email">Email</label>
            <input id="profile-email" className="input" type="email" autoComplete="email" required value={profile.email} onChange={setField('email')} placeholder="john@example.com" />
          </div>
        )}
        {mode === 'new' && (
          <div className="field">
            <label htmlFor="profile-phone">Phone (US)</label>
            <input id="profile-phone" className="input" type="tel" autoComplete="tel" required value={profile.phone} onChange={setField('phone')} placeholder="(212) 555-0123" />
          </div>
        )}
        {keyField}
        {profileError && <div className="form-error">{profileError}</div>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'profile'}>
          <LicenseIcon size={15} />{' '}
          {mode === 'returning'
            ? (busy === 'profile' ? 'Logging in…' : 'Log in and protect this PC')
            : (busy === 'profile' ? 'Activating and securing your PC…' : 'Activate and protect this PC')}
        </button>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          {mode === 'returning'
            ? 'Enter the licence key from your purchase email to log in.'
            : 'Your licence key is in your purchase email. Registered before, on this or another PC? Choose “I already have an account”.'}
        </p>
      </form>
    </Card>
  )

  return (
    <div className="view stack">
      <Banner tone={tone === 'ok' ? '' : tone}>
        <span className={`dot ${tone}`} />
        <p><strong>{titleCase(licenseStatus?.state || 'unlicensed')}.</strong> {message} {licenseStatus?.reason && licenseStatus.state !== 'active' && !detailsMissing ? licenseStatus.reason : ''}</p>
      </Banner>

      <div className="grid two">
        <Card title="Licence" subtitle={payload ? `${titleCase(payload.plan)} plan` : 'Nothing activated'}>
          {payload ? (
            <>
              <div className={`health-result ${licensed ? 'ok' : 'warn'}`} style={{ marginBottom: 12 }}>
                <span className="badge">{licensed ? <CheckCircleIcon size={26} filled /> : <ClockIcon size={26} filled />}</span>
                <div>
                  <h3>{days === null ? 'Never expires' : `${days} day${days === 1 ? '' : 's'} left`}</h3>
                  <p>{payload.expiresAt ? `Valid until ${formatDate(payload.expiresAt)}` : 'Lifetime licence'}</p>
                </div>
              </div>
              {account && <KeyValue label="Registered to">{account.name || (account.username ? `@${account.username}` : account.email)}</KeyValue>}
              <KeyValue label="Plan">{titleCase(payload.plan)}</KeyValue>
              <KeyValue label="Server status">{titleCase(payload.status)}</KeyValue>
              <KeyValue label="Devices allowed">1 PC at a time</KeyValue>
              <KeyValue label="Licence id"><span className="mono" style={{ fontSize: 11.5 }}>{payload.licenseId}</span></KeyValue>
              <KeyValue label="Last checked">{timeAgo(licenseStatus?.lastValidatedAt)}</KeyValue>
              <div className="row wrap" style={{ marginTop: 18 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={validate}>
                  {busy === 'validate' ? 'Checking…' : 'Re-check now'}
                </button>
                <button type="button" className="btn btn-danger btn-sm" disabled={Boolean(busy)} onClick={() => setConfirmOff(true)}>
                  Deactivate this device
                </button>
              </div>
            </>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
                Enter your details and the licence key from your purchase confirmation. Activating it turns on
                real-time protection and runs a first scan of your PC.
              </p>
              <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                A licence key belongs to the first customer that activates it and works on one PC at a time. To move it to a new
                PC, deactivate it here first, then log in on the new PC with your licence key.
              </p>
            </div>
          )}
        </Card>

        <div className="stack">
          {accountCard}

          {account && !licensed && (
            <Card title="Activate your licence" subtitle="Ties this device to a licence seat.">
              <form className="stack" onSubmit={activate} style={{ gap: 14 }}>
                <div className="field">
                  <label htmlFor="license-key">Licence key</label>
                  <input
                    id="license-key"
                    className="input mono"
                    value={licenseKey}
                    onChange={(event) => {
                      const raw = event.target.value.trim()
                      if (LICENCE_ID_PATTERN.test(raw)) {
                        setLicenseKey('')
                        setError(LICENCE_ID_MESSAGE)
                        return
                      }
                      setLicenseKey(formatKey(event.target.value))
                      setError(null)
                    }}
                    placeholder="AVP-XXXX-XXXX-XXXX-XXXX"
                    spellCheck="false"
                  />
                </div>
                {error && <div className="form-error">{error}</div>}
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'activate'}>
                  <LicenseIcon size={15} /> {busy === 'activate' ? 'Activating and securing your PC…' : 'Activate and protect this PC'}
                </button>
              </form>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOff}
        title="Deactivate this device?"
        body="The licence seat is released and protection turns off on this computer. You can then activate the same key on this PC, or on another PC by logging in there with your licence key. No other customer can use it."
        confirmLabel="Deactivate"
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => {
          setConfirmOff(false)
          deactivate()
        }}
      />
    </div>
  )
}

export default License
