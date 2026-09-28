import { useState } from 'react'
import { Banner, Card, Empty, Shield, Stat } from '../components/ui'
import { isLicensed } from '../lib/licensing'
import { formatCount, formatDate, formatDuration, shortPath, timeAgo, titleCase } from '../lib/format'

/** Recent activity entries shown before "Show more". */
const ACTIVITY_PREVIEW = 5

/** Derives a 0-100 protection score from the live module states. */
function computeScore({ settings, realtimeStatus, licenseStatus, quarantineCount, lastScanAt, signatureCount }) {
  let score = 100
  // Without signatures a scan cannot detect anything.
  if (!signatureCount) score -= 30
  if (!realtimeStatus?.running) score -= 28
  if (!settings?.usbProtection) score -= 8
  if (!settings?.automaticScanning) score -= 10
  if (!settings?.updateChecks) score -= 6
  if (!isLicensed(licenseStatus)) score -= 15
  if (quarantineCount > 0) score -= Math.min(12, quarantineCount * 4)
  if (!lastScanAt) score -= 12
  else if (Date.now() - Date.parse(lastScanAt) > 14 * 86400000) score -= 10
  // Without a licence nothing is actually protecting the device, whatever the
  // settings say, so the score can never look healthy.
  if (!isLicensed(licenseStatus)) score = Math.min(score, 25)
  return Math.max(0, Math.min(100, Math.round(score)))
}

function ActivityChart({ data }) {
  const peak = Math.max(1, ...data.map((day) => day.filesScanned))
  return (
    <>
      <div className="chart">
        {data.map((day) => (
          <div className="col" key={day.date} title={`${formatDate(day.date)} · ${formatCount(day.filesScanned)} files, ${day.threats} threat(s)`}>
            {day.threats > 0 && <i className="threat" style={{ height: `${Math.min(28, day.threats * 14)}%` }} />}
            <i style={{ height: `${Math.max(2, (day.filesScanned / peak) * 72)}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span><i style={{ background: '#0f9e74' }} />Files scanned</span>
        <span><i style={{ background: '#d0544a' }} />Threats</span>
      </div>
    </>
  )
}

function Dashboard({ state, onQuickScan, onToggleRealtime, onNavigate, firstScan }) {
  const { settings, realtimeStatus, usbStatus, licenseStatus, scannerStatus, quarantineItems, historySummary } = state
  const [showAllActivity, setShowAllActivity] = useState(false)

  const licensed = isLicensed(licenseStatus)
  const realtimeOn = Boolean(realtimeStatus?.running)
  const scanning = scannerStatus?.state === 'running' || scannerStatus?.state === 'paused'

  const totals = historySummary?.totals
  const lastScan = historySummary?.lastScan
  const definitions = historySummary?.definitions
  const daily = historySummary?.daily || []
  const events = historySummary?.events || []
  const visibleEvents = showAllActivity ? events : events.slice(0, ACTIVITY_PREVIEW)
  const hiddenEvents = events.length - ACTIVITY_PREVIEW
  const hasScanHistory = daily.some((day) => day.filesScanned > 0 || day.threats > 0)

  const lastScanAt = scannerStatus?.startedAt ? new Date(scannerStatus.startedAt).toISOString() : lastScan?.finishedAt || null
  // The score only means something once this PC has actually been scanned, so
  // until a full device scan completes the ring asks for a scan instead.
  const lastCompletedScanAt = historySummary?.lastCompletedScanAt || null
  // Once a licence is activated (or restored), only a scan finished after that
  // counts: otherwise the score would jump up without anything being checked.
  // Without a licence (never activated, or logged out) nothing is being checked,
  // so no score is shown at all; the ring asks for a licence instead.
  const activatedAt = licensed ? licenseStatus?.activatedAt : null
  const hasScanned = licensed && Boolean(lastCompletedScanAt) && (!activatedAt || Date.parse(lastCompletedScanAt) >= Date.parse(activatedAt))
  const needsRescan = licensed && !hasScanned && Boolean(lastCompletedScanAt)

  const score = computeScore({
    settings,
    realtimeStatus,
    licenseStatus,
    quarantineCount: quarantineItems.length,
    lastScanAt: lastCompletedScanAt,
    signatureCount: state.definitionInfo?.count || 0,
  })
  const noSignatures = !state.definitionInfo?.count
  const tone = score >= 80 ? 'ok' : score >= 55 ? 'warn' : 'bad'
  const pending = hasScanned ? null : !licensed ? 'No licence' : scanning ? 'Scanning' : needsRescan ? 'Scan needed' : 'Not scanned'

  // While a scan runs, its live counters are the truthful figure to show.
  const filesScanned = scanning ? scannerStatus.filesScanned : totals?.filesScanned ?? 0
  const threats = scanning ? scannerStatus.threatsDetected : totals?.threatsDetected ?? 0

  const headline = !hasScanned
    ? !licensed
      ? 'Activate your licence, then scan your device.'
      : scanning
        ? 'Scanning your device…'
        : noSignatures
          ? 'Install threat definitions, then scan your device.'
          : needsRescan
            ? 'Scan your device to update your protection score.'
            : 'Scan your device to see your protection score.'
    : !licensed
    ? 'Your computer is not protected.'
    : scanning
      ? 'A scan is running right now.'
      : noSignatures
        ? 'Install threat definitions to finish protecting your Device.'
        : tone === 'ok'
        ? 'Your Device is in good condition.'
        : tone === 'warn'
          ? 'A few things need your attention.'
          : 'Your protection is incomplete.'

  return (
    <div className="view stack">
      {!licensed && licenseStatus?.state !== 'checking' && (
        <Banner tone="bad">
          <span className="dot bad" />
          <p>
            <strong>No active licence.</strong> Scanning, real-time protection and removable drive checks are switched off,
            so threats on this computer are not being detected. {licenseStatus?.reason || ''}
          </p>
          <span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate?.('license')}>Activate a licence</button>
        </Banner>
      )}

      {firstScan === 'preparing' && (
        <Banner tone="warn">
          <span className="dot warn" />
          <p><strong>Getting ready for your first scan.</strong> Downloading the latest signed threat definitions…</p>
        </Banner>
      )}
      {firstScan === 'running' && scanning && (
        <Banner>
          <span className="dot ok" />
          <p>
            <strong>Welcome to Aegis — running your first scan.</strong> Checking Downloads, Desktop, Documents and startup
            items. {formatCount(scannerStatus.filesScanned)} files checked so far. You can keep using your PC.
          </p>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate?.('scan')}>View details</button>
        </Banner>
      )}

      <section className="card">
        <div className="shield-wrap">
          <Shield score={score} tone={tone} pending={pending} busy={scanning && !hasScanned} />
          <div className="shield-copy">
            <h2>{headline}</h2>
            <p>
              {!hasScanned && !licensed
                ? 'Your protection score appears after your first scan. Aegis can scan this PC once you enter your details and activate your licence key.'
                : !hasScanned && scanning
                  ? 'Your protection score will appear when this first scan finishes. You can keep using your PC.'
                  : !hasScanned && !noSignatures && needsRescan
                    ? 'Your licence is active. Run a scan so your score reflects this PC as it is now, with your licence protecting it.'
                  : !hasScanned && !noSignatures
                    ? 'Aegis has not checked this PC yet. A quick scan checks Downloads, Desktop, Documents and startup items, and then shows how well this PC is protected.'
                : !licensed
                ? 'Aegis cannot scan or watch files until a licence is activated on this device. Enter your details and activate your licence key to protect it.'
                : noSignatures
                  ? 'No threat signatures are installed, so scans and real-time protection cannot recognise any threat yet.'
                  : realtimeOn
                  ? 'Real-time protection is watching your Downloads, Desktop and Documents folders.'
                  : 'Real-time protection is off, so new files are not being checked as they arrive.'}
            </p>
            <div className="row wrap">
              {licensed ? (
                <>
                  <button type="button" className="btn btn-primary btn-sm" onClick={onQuickScan} disabled={scanning}>
                    {scanning ? 'Scan in progress' : hasScanned ? 'Run a quick scan' : 'Scan my device'}
                  </button>
                  {noSignatures ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate?.('updates')}>Get threat definitions</button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onToggleRealtime}>
                      {realtimeOn ? 'Pause real-time protection' : 'Turn on real-time protection'}
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate?.('license')}>
                  Activate a licence
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid four">
        <Stat
          label="Files scanned"
          value={formatCount(filesScanned)}
          note={scanning ? 'Updating live' : lastScanAt ? `Last scan ${timeAgo(lastScanAt)}` : 'No scan run yet'}
        />
        <Stat
          label="Threats found"
          value={formatCount(threats)}
          note={threats === 0 ? 'Nothing detected' : 'Review quarantine'}
        />
        <Stat
          label="In quarantine"
          value={formatCount(quarantineItems.length)}
          note={quarantineItems.length === 0 ? 'Nothing isolated' : 'Isolated and encrypted'}
        />
        <Stat
          label="Definitions"
          value={definitions?.version || 'Not installed'}
          note={definitions?.installedAt ? `Installed ${timeAgo(definitions.installedAt)}` : 'Install them from Updates'}
        />
      </div>

      <div className="grid hero">
        <Card title="Scan activity" subtitle="Last 14 days on this device">
          {hasScanHistory ? (
            <ActivityChart data={daily} />
          ) : (
            <Empty glyph="◷" title="No scan history yet">
              Run a scan and the results recorded on this device will build up here.
            </Empty>
          )}
        </Card>

        <Card title="Protection modules">
          <div className="list" style={{ margin: '-4px 0' }}>
            {(licensed
              ? [
                  ['Licence', true, licenseStatus?.state === 'offline-grace' ? 'Offline grace period' : 'Active'],
                  ['Real-time protection', realtimeOn, realtimeOn ? 'Watching file changes' : 'Currently off'],
                  ['Scheduled scans', Boolean(settings?.automaticScanning), settings?.automaticScanning ? 'Allowed to run on schedule' : 'Manual scans only'],
                  ['Removable drives', Boolean(usbStatus?.running), usbStatus?.supported === false ? 'Not supported on this platform' : usbStatus?.running ? `${usbStatus.devices?.length || 0} drive(s) seen` : 'Currently off'],
                  ['Threat definitions', !noSignatures, noSignatures ? 'Not installed' : `${state.definitionInfo.count} signature(s) · v${state.definitionInfo.version || '?'}`],
                  ['Update checks', Boolean(settings?.updateChecks), settings?.updateChecks ? 'Definitions kept current' : 'Currently off'],
                ]
              : [
                  ['Licence', false, 'Not activated'],
                  ['Real-time protection', false, 'Needs an active licence'],
                  ['Scheduled scans', false, 'Needs an active licence'],
                  ['Removable drives', false, 'Needs an active licence'],
                  ['Update checks', Boolean(settings?.updateChecks), settings?.updateChecks ? 'Definitions kept current' : 'Currently off'],
                ]
            ).map(([label, on, note]) => (
              <div className="list-row" key={label} style={{ paddingInline: 0 }}>
                <span className={`dot ${on ? 'ok' : licensed ? 'off' : 'bad'}`} />
                <div className="main-cell">
                  <strong>{label}</strong>
                  <span className="path">{note}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid two">
        <Card title="Recent activity" bodyClass="tight">
          {events.length > 0 ? (
            <>
            <div className="list">
              {visibleEvents.map((event, index) => (
                <div className="event-row" key={`${event.at}-${index}`}>
                  <span className={`dot ${event.tone}`} />
                  <div className="body">
                    <p>{event.text}</p>
                    <div className="when">{timeAgo(event.at)}</div>
                  </div>
                </div>
              ))}
            </div>
            {hiddenEvents > 0 && (
              <div className="activity-more">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAllActivity((open) => !open)} aria-expanded={showAllActivity}>
                  {showAllActivity ? 'Show less' : `Show more (${hiddenEvents})`}
                </button>
              </div>
            )}
            </>
          ) : (
            <Empty glyph="◷" title="Nothing recorded yet">
              Scans, detections, drive activity and definition updates are logged here as they happen.
            </Empty>
          )}
        </Card>

        <Card title="Last scan">
          {scanning ? (
            <>
              <div className="kv"><span>Mode</span><strong>{titleCase(scannerStatus.mode)}</strong></div>
              <div className="kv"><span>State</span><strong>{titleCase(scannerStatus.state)}</strong></div>
              <div className="kv"><span>Files checked</span><strong>{formatCount(scannerStatus.filesScanned)}</strong></div>
              <div className="kv"><span>Threats found</span><strong>{formatCount(scannerStatus.threatsDetected)}</strong></div>
              <div className="kv"><span>Elapsed</span><strong>{formatDuration(scannerStatus.elapsedMs)}</strong></div>
              {scannerStatus.currentFile && (
                <div className="kv"><span>Current file</span><strong className="mono">{shortPath(scannerStatus.currentFile, 34)}</strong></div>
              )}
            </>
          ) : lastScan ? (
            <>
              <div className="kv"><span>Mode</span><strong>{titleCase(lastScan.mode)}</strong></div>
              <div className="kv"><span>Result</span><strong>{titleCase(lastScan.state)}</strong></div>
              <div className="kv"><span>Files checked</span><strong>{formatCount(lastScan.filesScanned)}</strong></div>
              <div className="kv"><span>Threats found</span><strong>{formatCount(lastScan.threatsDetected)}</strong></div>
              <div className="kv"><span>Duration</span><strong>{formatDuration(lastScan.elapsedMs)}</strong></div>
              <div className="kv"><span>When</span><strong>{timeAgo(lastScan.finishedAt)}</strong></div>
              {lastScan.error && <div className="kv"><span>Error</span><strong>{lastScan.error}</strong></div>}
            </>
          ) : (
            <Empty glyph="◎" title="No scan run yet">
              Start a quick scan to check the folders most likely to hold new downloads.
            </Empty>
          )}
        </Card>
      </div>
    </div>
  )
}

export default Dashboard
