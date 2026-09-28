import { useState } from 'react'
import { Banner, Card, Empty, LicenseLock, SettingRow, Toggle } from '../components/ui'
import * as api from '../lib/bridge'
import { isLicensed } from '../lib/licensing'
import { formatCount, formatDateTime, shortPath, timeAgo } from '../lib/format'

const SCHEDULES = [
  ['startup', 'On startup', 'Runs a quick scan once each time Aegis launches.'],
  ['daily', 'Daily', 'Runs a quick scan 24 hours after the last one.'],
  ['weekly', 'Weekly', 'Runs a quick scan 7 days after the last one.'],
  ['monthly', 'Monthly', 'Runs a quick scan 30 days after the last one.'],
]
const SCHEDULE_KEYS = ['daily', 'weekly', 'monthly', 'startup']

/** Real timing from the scheduler, e.g. "Next run Sep 28, 9:14 AM · last ran 3 days ago". */
function scheduleTiming(key, enabled, info) {
  if (!enabled || key === 'startup' || !info) return null
  const parts = []
  if (!info.active) parts.push('Paused')
  else if (info.nextRuns?.[key]) parts.push(Date.parse(info.nextRuns[key]) <= Date.now() ? 'Due now, runs when no other scan is active' : `Next run ${formatDateTime(info.nextRuns[key])}`)
  if (info.lastRuns?.[key]) parts.push(`last ran ${timeAgo(info.lastRuns[key])}`)
  return parts.join(' · ') || null
}

function Protection({ state, toasts, onNavigate }) {
  const { settings, realtimeStatus, usbStatus, schedulerStatus, scheduleInfo, updateSettings, setRealtimeStatus, setUsbStatus, refreshScheduler, licenseStatus } = state
  const [busy, setBusy] = useState(false)
  const licensed = isLicensed(licenseStatus)

  const realtimeOn = Boolean(realtimeStatus?.running)
  const usbSupported = usbStatus?.supported !== false

  const toggleRealtime = async (next) => {
    setBusy(true)
    const result = next ? await api.realtime.start() : await api.realtime.stop()
    if (result.ok) {
      setRealtimeStatus(result.data)
      await updateSettings({ realTimeProtection: next })
      toasts.notify(next ? 'Real-time protection on' : 'Real-time protection off', next ? 'New files are checked as they arrive.' : 'New files will not be checked automatically.')
    } else {
      toasts.fail('Could not change real-time protection', result.error)
    }
    setBusy(false)
  }

  const toggleUsb = async (next) => {
    setBusy(true)
    const result = next ? await api.usb.start() : await api.usb.stop()
    if (result.ok) {
      setUsbStatus(result.data)
      await updateSettings({ usbProtection: next })
      toasts.notify(next ? 'Removable drive scanning on' : 'Removable drive scanning off')
    } else {
      toasts.fail('Could not change removable drive scanning', result.error)
    }
    setBusy(false)
  }

  const toggleSchedule = async (key, next) => {
    setBusy(true)
    const schedule = Object.fromEntries(SCHEDULE_KEYS.map((name) => [name, Boolean(schedulerStatus?.[name])]))
    schedule[key] = next
    const result = await api.scheduler.update(schedule)
    if (result.ok) {
      await refreshScheduler()
      toasts.notify('Schedule updated')
    } else {
      toasts.fail('Could not update the schedule', result.error)
    }
    setBusy(false)
  }

  if (!licensed) {
    return (
      <div className="view stack">
        <Card title="Protection is off">
          <LicenseLock title="This computer is not protected" onActivate={() => onNavigate?.('license')}>
            Real-time protection, removable drive scanning and scheduled scans only run while a licence is active.
            Your saved preferences are kept and switch back on as soon as you activate.
          </LicenseLock>
        </Card>
      </div>
    )
  }

  return (
    <div className="view stack">
      {realtimeStatus?.error && (
        <Banner tone="warn">
          <span className="dot warn" />
          <p><strong>Real-time protection reported a problem.</strong> {realtimeStatus.error}</p>
        </Banner>
      )}

      <Card title="Real-time protection" subtitle="Watches Downloads, Desktop and Documents for new or changed files.">
        <SettingRow
          title={realtimeOn ? 'Currently watching' : 'Currently off'}
          description={
            realtimeOn
              ? 'Files that match a known signature are encrypted and moved to quarantine automatically.'
              : 'Nothing is being checked as it arrives. You can still run manual scans.'
          }
        >
          <Toggle checked={realtimeOn} disabled={busy} onChange={toggleRealtime} label="Real-time protection" />
        </SettingRow>
        <div style={{ paddingTop: 4 }}>
          <div className="kv"><span>Detections this session</span><strong>{formatCount(realtimeStatus?.detections || 0)}</strong></div>
          <div className="kv">
            <span>Last file seen</span>
            <strong className="mono">{realtimeStatus?.lastEvent ? shortPath(realtimeStatus.lastEvent.filePath, 40) : 'None yet'}</strong>
          </div>
          <div className="kv"><span>Last event</span><strong>{realtimeStatus?.lastEvent ? timeAgo(realtimeStatus.lastEvent.at) : 'None yet'}</strong></div>
        </div>
      </Card>

      <Card title="Removable drives" subtitle="Scans USB drives automatically when they are connected.">
        {usbSupported ? (
          <>
            <SettingRow
              title={usbStatus?.running ? 'Monitoring connected drives' : 'Not monitoring'}
              description="When a removable drive is connected, Aegis scans it and quarantines anything that matches a signature. If another scan is running, the drive is scanned right after it. Drives already connected when monitoring starts are not scanned automatically."
            >
              <Toggle checked={Boolean(usbStatus?.running)} disabled={busy} onChange={toggleUsb} label="Removable drive scanning" />
            </SettingRow>
            <div style={{ paddingTop: 4 }}>
              <div className="kv"><span>Drives currently seen</span><strong>{usbStatus?.devices?.length ? usbStatus.devices.join(', ') : 'None'}</strong></div>
              {usbStatus?.queued?.length > 0 && <div className="kv"><span>Waiting to be scanned</span><strong>{usbStatus.queued.join(', ')}</strong></div>}
              {usbStatus?.error && <div className="kv"><span>Last error</span><strong>{usbStatus.error}</strong></div>}
            </div>
          </>
        ) : (
          <Empty glyph="⌑" title="Not available on this platform">
            Removable drive monitoring currently works on Windows only.
          </Empty>
        )}
      </Card>

      <Card title="Scheduled scans" subtitle="Quick scans that run while Aegis is open or in the tray. A scan missed while the PC was off runs soon after Aegis starts." bodyClass="tight">
        {!settings?.automaticScanning && (
          <div style={{ padding: '16px 20px 0' }}>
            <Banner tone="warn">
              <span className="dot warn" />
              <p><strong>Automatic scanning is switched off in Settings.</strong> These schedules stay saved but will not run until you turn it back on.</p>
            </Banner>
          </div>
        )}
        {SCHEDULES.map(([key, label, description]) => (
          <SettingRow
            key={key}
            title={label}
            description={(() => {
              const timing = scheduleTiming(key, Boolean(schedulerStatus?.[key]), scheduleInfo)
              return timing ? <>{description}<br /><span className="mono" style={{ fontSize: 11.5 }}>{timing}</span></> : description
            })()}
          >
            <Toggle
              checked={Boolean(schedulerStatus?.[key])}
              disabled={busy}
              onChange={(next) => toggleSchedule(key, next)}
              label={label}
            />
          </SettingRow>
        ))}
      </Card>
    </div>
  )
}

export default Protection
