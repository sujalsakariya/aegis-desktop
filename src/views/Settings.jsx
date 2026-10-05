import { useState } from 'react'
import { Banner, Card, Empty, KeyValue, SettingRow, Toggle } from '../components/ui'
import * as api from '../lib/bridge'
import { APP_VERSION } from '../lib/bridge'
import { licenseBadge } from '../lib/licensing'
import { Select } from '../components/Select'

const THEMES = [{ value: 'system', label: 'Match the system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]
const LANGUAGES = [{ value: 'en', label: 'English' }]

const PROTECTION_SWITCHES = [
  ['realTimeProtection', 'Real-time protection', 'Check files as they are created or changed in Downloads, Desktop and Documents, and quarantine matches.'],
  ['automaticScanning', 'Automatic scanning', 'Allow the schedules configured under Protection to run.'],
  ['usbProtection', 'Removable drive scanning', 'Scan USB drives automatically when they are connected.'],
  ['updateChecks', 'Automatic definition updates', 'Check for and install new threat definitions at startup and every 6 hours.'],
]

const NOTIFICATION_SWITCHES = [
  ['notifications', 'Notifications', 'Show a Windows notification when a threat is found or quarantined, when a scan finishes, and when definitions are updated.'],
  ['dndMode', 'Do not disturb', 'Only threat notifications are shown. Scan-finished and definition-update notifications are held back.'],
  ['silentMode', 'Silent mode', 'No notifications at all, including threats, and Aegis never brings its window forward on its own. Protection and scheduled scans keep running.'],
]

const APP_SWITCHES = [
  ['launchAtStartup', 'Launch Aegis when Windows starts', 'Starts Aegis in the system tray when you sign in, so protection is on from the start. Applies to the installed app only.'],
  ['runInBackground', 'Keep protecting when the window is closed', 'Closing the window keeps Aegis running in the system tray, so real-time, removable drive and scheduled protection continue. Use Quit in the tray menu to exit.'],
]

function Settings({ state, toasts }) {
  const { settings, updateSettings, isDesktop, definitionInfo, licenseStatus } = state
  const [exclusion, setExclusion] = useState('')
  const [busy, setBusy] = useState(false)

  const change = async (patch, label) => {
    setBusy(true)
    const result = await updateSettings(patch)
    setBusy(false)
    if (result.ok && label) toasts.notify(label)
  }

  const addExclusion = async () => {
    const value = exclusion.trim()
    if (!value) return
    const current = settings?.scanExclusions || []
    if (current.includes(value)) {
      setExclusion('')
      return
    }
    const result = await updateSettings({ scanExclusions: [...current, value] })
    if (result.ok) {
      setExclusion('')
      toasts.notify('Exclusion added')
    }
  }

  const removeExclusion = async (value) => {
    const current = settings?.scanExclusions || []
    const result = await updateSettings({ scanExclusions: current.filter((item) => item !== value) })
    if (result.ok) toasts.notify('Exclusion removed')
  }

  return (
    <div className="view stack">
      {!settings ? (
        <Card title="Protection settings">
          <Empty glyph="⚙" title="Settings unavailable">
            {isDesktop
              ? 'The settings store could not be read. Secure storage may be unavailable on this system.'
              : 'Settings are only available in the installed Aegis app.'}
          </Empty>
        </Card>
      ) : (
        <>
          {[
            ['Protection settings', 'These apply immediately.', PROTECTION_SWITCHES],
            ['Notifications', settings.silentMode ? 'Silent mode is on, so no notifications are shown.' : 'Windows notifications from Aegis.', NOTIFICATION_SWITCHES],
            ['Startup and background', 'How Aegis runs alongside Windows.', APP_SWITCHES],
          ].map(([cardTitle, subtitle, switches]) => (
            <Card key={cardTitle} title={cardTitle} subtitle={subtitle} bodyClass="tight">
              {switches.map(([key, title, description]) => (
                <SettingRow key={key} title={title} description={description}>
                  <Toggle
                    checked={Boolean(settings[key])}
                    disabled={busy || (key === 'dndMode' && !settings.notifications)}
                    onChange={(next) => change({ [key]: next }, `${title} ${next ? 'on' : 'off'}`)}
                    label={title}
                  />
                </SettingRow>
              ))}
            </Card>
          ))}

          <Card title="Scan exclusions" subtitle="Files and folders every scan and real-time protection skip, including everything inside an excluded folder.">
            <div className="row" style={{ marginBottom: 14 }}>
              <input
                className="input mono"
                style={{ textTransform: 'none' }}
                placeholder="C:\Users\you\Projects\build"
                value={exclusion}
                onChange={(event) => setExclusion(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), addExclusion())}
              />
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={addExclusion}>Add</button>
            </div>
            {settings.scanExclusions?.length ? (
              <div className="list" style={{ borderTop: '1px solid var(--line)' }}>
                {settings.scanExclusions.map((item) => (
                  <div className="list-row" key={item} style={{ paddingInline: 0 }}>
                    <div className="main-cell"><span className="path">{item}</span></div>
                    <button type="button" className="btn-link" disabled={busy} onClick={() => removeExclusion(item)}>Remove</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>No exclusions. Every accessible file in scope is checked. Paths must be absolute; matching ignores letter case on Windows.</p>
            )}
          </Card>

          <Card title="Appearance and language">
            <div className="grid two">
              <div className="field">
                <label htmlFor="setting-theme">Theme</label>
                <Select
                  id="setting-theme"
                  className="input"
                  value={settings.theme}
                  disabled={busy}
                  onChange={(theme) => change({ theme }, 'Theme updated')}
                  options={THEMES}
                />
              </div>
              <div className="field">
                <label htmlFor="setting-language">Language</label>
                <Select id="setting-language" className="input" value="en" disabled aria-describedby="setting-language-note" onChange={() => {}} options={LANGUAGES} />
              </div>
            </div>
            <p id="setting-language-note" className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
              Match the system follows your Windows light or dark mode as it changes. Aegis is available in English only for now.
            </p>
          </Card>
        </>
      )}

      <Card title="About Aegis">
        <KeyValue label="Version">{APP_VERSION}</KeyValue>
        <KeyValue label="Threat signatures">
          {definitionInfo?.count
            ? `${definitionInfo.version ? `${definitionInfo.version} · ` : ''}${definitionInfo.count.toLocaleString('en-US')} signatures`
            : 'Not downloaded yet'}
        </KeyValue>
        <KeyValue label="Licence">{licenseBadge(licenseStatus).label}</KeyValue>
        <p className="muted" style={{ fontSize: 12.5, margin: '14px 0 0' }}>
          © {new Date().getFullYear()} Aegis. Updates for the app and threat signatures are on the Updates page.
        </p>
        <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Aegis includes open-source software.{' '}
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 6px', fontSize: 12 }} onClick={() => api.app.openLicenses()}>
            View open-source licenses
          </button>
        </p>
      </Card>

      <Banner>
        <span className="dot ok" />
        <p>
          Settings, the licence cache and the quarantine key are encrypted with the operating system&rsquo;s secure storage and never
          leave this device.
        </p>
      </Banner>
    </div>
  )
}

export default Settings
