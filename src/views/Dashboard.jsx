import { useEffect, useState } from 'react'
import { Banner, Card, CountUp, Empty, Shield } from '../components/ui'
import { AlertIcon, CleanerIcon, ProtectionIcon, QuarantineIcon, ScanIcon, UpdatesIcon, LockIcon } from '../components/icons'
import { isLicensed } from '../lib/licensing'
import { computeMeters, securityScore, toneOf } from '../lib/meters'
import * as api from '../lib/bridge'
import { formatCount, formatDate, formatDuration, shortPath, timeAgo, titleCase } from '../lib/format'

/** Button text for each check's fix-it action. */
const ACTION_LABELS = { realtime: 'Turn on', scan: 'Scan now', updates: 'Update', protection: 'Review', cleaner: 'Check now', license: 'Activate' }
const CHECK_ICONS = { realtime: ProtectionIcon, scanning: ScanIcon, signatures: UpdatesIcon, device: LockIcon }
const STATUS_TEXT = { ok: 'Good', warn: 'Needs attention', bad: 'At risk', off: 'Not rated' }

/** Recent activity entries shown before "Show more". */
const ACTIVITY_PREVIEW = 5

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

/** One stat tile with an icon. */
function Tile({ icon: Icon, tone = '', label, value, note }) {
  return (
    <div className={`dash-tile ${tone}`}>
      <span className="dash-tile-icon"><Icon size={18} filled /></span>
      <div>
        <span className="dash-tile-label">{label}</span>
        <strong className="dash-tile-value">{value}</strong>
        <span className="dash-tile-note">{note}</span>
      </div>
    </div>
  )
}

function Dashboard({ state, onQuickScan, onToggleRealtime, onNavigate, firstScan }) {
  const { settings, realtimeStatus, usbStatus, licenseStatus, scannerStatus, quarantineItems, historySummary } = state
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [cleaner, setCleaner] = useState({})

  // PC Cleaner's last analysis feeds the PC health score.
  useEffect(() => {
    let alive = true
    api.cleaner.status().then((result) => { if (alive && result.ok && result.data) setCleaner(result.data) })
    const unsubscribe = api.cleaner.onUpdate((next) => { if (next) setCleaner(next) })
    return () => { alive = false; unsubscribe() }
  }, [])

  const licensed = isLicensed(licenseStatus)
  const realtimeOn = Boolean(realtimeStatus?.running)
  const scanning = scannerStatus?.state === 'running' || scannerStatus?.state === 'paused'

  const runAction = (action) => {
    if (action === 'realtime') onToggleRealtime?.()
    else if (action === 'scan') onQuickScan?.()
    else if (action) onNavigate?.(action)
  }

  const totals = historySummary?.totals
  const lastScan = historySummary?.lastScan
  const daily = historySummary?.daily || []
  const events = historySummary?.events || []
  const visibleEvents = showAllActivity ? events : events.slice(0, ACTIVITY_PREVIEW)
  const hiddenEvents = events.length - ACTIVITY_PREVIEW
  const hasScanHistory = daily.some((day) => day.filesScanned > 0 || day.threats > 0)

  const lastScanAt = scannerStatus?.startedAt ? new Date(scannerStatus.startedAt).toISOString() : lastScan?.finishedAt || null
  // The score only means something once this PC has actually been scanned, and
  // only scans finished after the licence was activated count; without a licence
  // nothing is checked, so no score is shown at all.
  const lastCompletedScanAt = historySummary?.lastCompletedScanAt || null
  const activatedAt = licensed ? licenseStatus?.activatedAt : null
  const hasScanned = licensed && Boolean(lastCompletedScanAt) && (!activatedAt || Date.parse(lastCompletedScanAt) >= Date.parse(activatedAt))
  const needsRescan = licensed && !hasScanned && Boolean(lastCompletedScanAt)

  const meters = computeMeters({
    licensed,
    settings,
    realtimeRunning: realtimeOn,
    usbSupported: usbStatus?.supported !== false,
    signatures: { count: state.definitionInfo?.count || 0, updatedAt: state.definitionInfo?.updatedAt || null },
    lastScanAt: hasScanned ? lastCompletedScanAt : null,
    cleaner,
  })
  const checks = meters.filter((meter) => meter.id !== 'cleanliness')
  const health = meters.find((meter) => meter.id === 'cleanliness')
  const score = securityScore(meters) ?? 0
  const noSignatures = !state.definitionInfo?.count
  const tone = toneOf(score)

  // During a scan the ring climbs from 0 towards the score this device gets once
  // the scan finishes, in step with how far the scan has got. Progress is
  // measured against the files the last scan of the same kind checked; without
  // one it follows a curve that slows down and never claims to be done.
  let ringScore = score
  let ringTone = tone
  let ringCaption = null
  if (scanning) {
    const projected = securityScore(computeMeters({
      licensed,
      settings,
      realtimeRunning: realtimeOn,
      usbSupported: usbStatus?.supported !== false,
      signatures: { count: state.definitionInfo?.count || 0, updatedAt: state.definitionInfo?.updatedAt || null },
      lastScanAt: new Date().toISOString(),
      cleaner,
    })) ?? 0
    const files = scannerStatus.filesScanned || 0
    const expected = lastScan?.state === 'completed' && lastScan.mode === scannerStatus.mode && lastScan.filesScanned > 0 ? lastScan.filesScanned : 0
    const waiting = scannerStatus.waitingForSignatures || scannerStatus.preparing
    const progress = waiting ? 0 : expected ? Math.min(0.97, files / expected) : Math.min(0.95, 1 - Math.exp(-files / 1500))
    ringScore = Math.round(projected * progress)
    ringTone = 'scan'
    ringCaption = scannerStatus.waitingForSignatures ? 'Downloading' : waiting ? 'Starting' : scannerStatus.state === 'paused' ? 'Paused' : `Scanning ${Math.round(progress * 100)}%`
  }
  const pending = hasScanned || scanning ? null : !licensed ? 'No licence' : needsRescan ? 'Scan needed' : 'Not scanned'

  // While a scan runs, its live counters are the truthful figure to show.
  const filesScanned = scanning ? scannerStatus.filesScanned : totals?.filesScanned ?? 0
  const threats = scanning ? scannerStatus.threatsDetected : totals?.threatsDetected ?? 0

  const headline = scanning
    ? scannerStatus.waitingForSignatures ? 'Getting the threat signatures…' : 'Scanning your device…'
    : !hasScanned
    ? !licensed
      ? 'Activate your licence, then scan your device.'
      : scanning
        ? 'Scanning your device…'
        : noSignatures
          ? 'Download the threat signatures, then scan your device.'
          : needsRescan
            ? 'Scan your device to update your security score.'
            : 'Scan your device to see your security score.'
    : scanning
      ? 'A scan is running right now.'
      : tone === 'ok'
        ? 'Your device is well protected.'
        : tone === 'warn'
          ? 'A few things need your attention.'
          : 'Your protection is incomplete.'

  const lede = scanning
    ? scannerStatus.waitingForSignatures
      ? 'Downloading the threat signatures (about 110 MB, first time only). The scan starts by itself as soon as they are ready.'
      : `${formatCount(scannerStatus.filesScanned || 0)} files checked so far. Your score fills in as the scan goes, and you can keep using your computer.`
    : !hasScanned && !licensed
    ? 'Aegis can scan and watch this computer once you activate your licence key.'
    : !hasScanned && scanning
      ? 'Your security score appears when this first scan finishes. You can keep using your computer.'
      : !hasScanned && needsRescan
        ? 'Your licence is active. Run a scan so the score reflects this computer as it is now.'
        : !hasScanned
          ? 'A quick scan checks Downloads, Desktop, Documents and startup items, then shows how well this computer is protected.'
          : noSignatures
            ? 'No threat signatures are installed, so threats cannot be recognised yet.'
            : realtimeOn
              ? 'Real-time protection is watching your Downloads, Desktop and Documents folders.'
              : 'Real-time protection is off, so new files are not checked as they arrive.'

  const healthTone = toneOf(health.score)

  return (
    <div className="view stack dashboard">
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
          <p><strong>Getting ready for your first scan.</strong> Downloading the threat signatures (about 110 MB, first time only)…</p>
        </Banner>
      )}
      {firstScan === 'running' && scanning && (
        <Banner>
          <span className="dot ok" />
          <p>
            <strong>Welcome to Aegis — running your first scan.</strong> Checking Downloads, Desktop, Documents and startup
            items. {formatCount(scannerStatus.filesScanned)} files checked so far. You can keep using your computer.
          </p>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate?.('scan')}>View details</button>
        </Banner>
      )}

      {/* The two scores that matter: security, and how clean the PC is. */}
      <section className={`dash-hero tone-${pending ? 'off' : ringTone}`}>
        <div className="dash-hero-main">
          <Shield score={ringScore} tone={ringTone} pending={pending} caption={ringCaption} label="Security" size="lg" />
          <div className="dash-hero-copy">
            <span className="dash-eyebrow">Security score</span>
            <h2>{headline}</h2>
            <p>{lede}</p>
            <div className="row wrap">
              {licensed ? (
                <>
                  <button type="button" className="btn btn-primary" onClick={onQuickScan} disabled={scanning}>
                    <ScanIcon size={16} /> {scanning ? 'Scan in progress' : hasScanned ? 'Run a quick scan' : 'Scan my device'}
                  </button>
                  {noSignatures ? (
                    <button type="button" className="btn btn-ghost" onClick={() => onNavigate?.('updates')}>Get threat signatures</button>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={onToggleRealtime}>
                      {realtimeOn ? 'Pause real-time protection' : 'Turn on real-time protection'}
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => onNavigate?.('license')}>Activate a licence</button>
              )}
            </div>
          </div>
        </div>

        <div className="dash-hero-health">
          <Shield
            score={health.score ?? 0}
            tone={healthTone}
            pending={health.score === null ? (licensed ? 'Not checked' : 'No licence') : null}
            label="Health"
            size="md"
          />
          <span className="dash-eyebrow">PC health</span>
          <strong className="dash-health-title">{health.score === null ? 'Not checked yet' : healthTone === 'ok' ? 'Clean and tidy' : 'Junk is building up'}</strong>
          <span className="dash-health-detail">{health.detail}</span>
          {licensed && (
            <button type="button" className={`btn btn-sm ${health.action ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onNavigate?.('cleaner')}>
              <CleanerIcon size={14} /> {health.score === null ? 'Check for junk' : health.action ? 'Clean up' : 'Open PC Cleaner'}
            </button>
          )}
        </div>
      </section>

      <Card title="Protection checklist" subtitle="What makes up your security score">
        <div className="check-list">
          {checks.map((check) => {
            const Icon = CHECK_ICONS[check.id]
            const checkTone = toneOf(check.score)
            return (
              <div className={`check-row tone-${checkTone}`} key={check.id}>
                <span className="check-icon"><Icon size={18} filled /></span>
                <div className="check-main">
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                <div className="check-bar" aria-hidden="true"><i style={{ width: `${check.score ?? 0}%` }} /></div>
                <span className="check-score">{check.score == null ? '—' : <CountUp value={check.score} />}</span>
                <span className={`check-pill ${checkTone}`}>{STATUS_TEXT[checkTone]}</span>
                <div className="check-action">
                  {check.action && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => runAction(check.action)}>{ACTION_LABELS[check.action]}</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <div className="dash-tiles">
        <Tile icon={ScanIcon} label="Files scanned" value={<CountUp value={filesScanned} format={(n) => formatCount(Math.round(n))} />} note={scanning ? 'Updating live' : lastScanAt ? `Last scan ${timeAgo(lastScanAt)}` : 'No scan run yet'} />
        <Tile icon={AlertIcon} tone={threats ? 'bad' : ''} label="Threats found" value={<CountUp value={threats} format={(n) => formatCount(Math.round(n))} />} note={threats === 0 ? 'Nothing detected' : 'Review quarantine'} />
        <Tile icon={QuarantineIcon} label="In quarantine" value={<CountUp value={quarantineItems.length} format={(n) => formatCount(Math.round(n))} />} note={quarantineItems.length === 0 ? 'Nothing isolated' : 'Isolated and encrypted'} />
        <Tile
          icon={UpdatesIcon}
          label="Threat signatures"
          value={state.definitionInfo?.count ? `${(state.definitionInfo.count / 1e6).toFixed(2)}M` : 'Not yet'}
          note={state.definitionInfo?.updatedAt ? `Updated ${timeAgo(state.definitionInfo.updatedAt)}` : 'Download them from Updates'}
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
            Scans, detections, drive activity and signature updates are logged here as they happen.
          </Empty>
        )}
      </Card>
    </div>
  )
}

export default Dashboard
