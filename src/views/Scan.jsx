import { useState } from 'react'
import { Banner, Card, LicenseLock, Stat } from '../components/ui'
import { AlertIcon, CheckCircleIcon } from '../components/icons'
import * as api from '../lib/bridge'
import { isLicensed } from '../lib/licensing'
import { formatCount, formatDuration, shortPath, titleCase } from '../lib/format'

const MODES = [
  ['quick', 'Quick scan', 'Checks Downloads, Desktop, Documents and your startup items.'],
  ['full', 'Full scan', 'Walks your entire home folder. This takes considerably longer.'],
  ['custom', 'Custom scan', 'Scans only the folders you list below.'],
]

function Scan({ state, toasts, onNavigate }) {
  const { scannerStatus, setScannerStatus, licenseStatus } = state
  const licensed = isLicensed(licenseStatus)
  const [mode, setMode] = useState('quick')
  const [pathInput, setPathInput] = useState('')
  const [paths, setPaths] = useState([])
  const [busy, setBusy] = useState(false)

  const status = scannerStatus || { state: 'idle', filesScanned: 0, threatsDetected: 0, quarantined: 0, detections: [], elapsedMs: 0, scanSpeed: 0 }
  const detections = Array.isArray(status.detections) ? status.detections : []
  const quarantinedCount = Number(status.quarantined) || 0
  const notQuarantined = Math.max(0, (Number(status.threatsDetected) || 0) - quarantinedCount)
  const running = status.state === 'running'
  const paused = status.state === 'paused'
  const active = running || paused

  const addPath = () => {
    const value = pathInput.trim()
    if (!value) return
    if (paths.includes(value)) {
      setPathInput('')
      return
    }
    setPaths((current) => [...current, value].slice(0, 100))
    setPathInput('')
  }

  const start = async () => {
    if (!licensed) {
      onNavigate?.('license')
      return
    }
    if (mode === 'custom' && paths.length === 0) {
      toasts.warn('Add at least one folder', 'A custom scan needs one or more absolute paths.')
      return
    }
    setBusy(true)
    const result = await api.scanner.start(mode === 'custom' ? { mode, paths } : { mode })
    setBusy(false)
    if (result.ok) {
      setScannerStatus(result.data)
      toasts.notify('Scan started', `${titleCase(mode)} scan is now running.`)
    } else {
      toasts.fail('Could not start the scan', result.error)
    }
  }

  const control = async (action, label) => {
    setBusy(true)
    const result = await api.scanner[action]()
    setBusy(false)
    if (result.ok) {
      if (result.data) setScannerStatus(result.data)
      toasts.notify(label)
    } else {
      toasts.fail(`Could not ${label.toLowerCase()}`, result.error)
    }
  }

  return (
    <div className="view stack">
      {status.state === 'failed' && status.error && (
        <Banner tone="bad">
          <span className="dot bad" />
          <p><strong>The last scan failed.</strong> {status.error}</p>
        </Banner>
      )}

      <div className="grid four">
        <Stat label="State" value={titleCase(status.state)} note={status.mode ? `${titleCase(status.mode)} scan` : 'No scan yet'} />
        <Stat label="Files checked" value={formatCount(status.filesScanned)} note={active ? 'Counting' : 'Since last start'} />
        <Stat label="Threats found" value={formatCount(status.threatsDetected)} note={status.threatsDetected > 0 ? `${formatCount(quarantinedCount)} quarantined` : 'Nothing detected'} />
        <Stat label="Elapsed" value={formatDuration(status.elapsedMs)} note={status.scanSpeed ? `${formatCount(status.scanSpeed)} files/sec` : 'Idle'} />
      </div>

      {active && (
        <Card title="Scan in progress" subtitle={`${titleCase(status.mode)} scan`}>
          <div className="progress indeterminate"><i /></div>
          <div className="scan-file">{status.preparing ? 'Starting the scanning engine (loading 3.6 million ClamAV signatures, about 15 seconds)…' : status.currentFile ? shortPath(status.currentFile, 90) : 'Preparing…'}</div>
          {status.threatsDetected > 0 && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
              {formatCount(status.threatsDetected)} threat(s) found so far, {formatCount(quarantinedCount)} moved to quarantine.
            </p>
          )}
          <div className="row wrap" style={{ marginTop: 18 }}>
            {running ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => control('pause', 'Scan paused')}>Pause</button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => control('resume', 'Scan resumed')}>Resume</button>
            )}
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => control('cancel', 'Scan cancelled')}>Cancel scan</button>
          </div>
        </Card>
      )}

      {!licensed && !active && (
        <Card title="Scanning is locked">
          <LicenseLock title="Your computer is not being scanned" onActivate={() => onNavigate?.('license')}>
            Scanning needs an active licence. Until one is activated, files on this computer are not checked for threats,
            so its condition cannot be confirmed as safe.
          </LicenseLock>
        </Card>
      )}

      {licensed && (
      <Card title="Start a scan" subtitle="Pick how much of the device to check.">
        <div className="stack">
          {MODES.map(([value, label, description]) => (
            <label
              key={value}
              className="setting-row"
              style={{ border: `1px solid ${mode === value ? 'var(--ok-line)' : 'var(--line)'}`, borderRadius: 13, cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="scan-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                style={{ accentColor: 'var(--accent-ink)', height: 18, width: 18 }}
              />
              <div className="text">
                <strong>{label}</strong>
                <small>{description}</small>
              </div>
            </label>
          ))}

          {mode === 'custom' && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="field">
                <label htmlFor="scan-path">Folder to include</label>
                <div className="row">
                  <input
                    id="scan-path"
                    className="input mono"
                    placeholder="C:\Users\you\Projects"
                    value={pathInput}
                    style={{ textTransform: 'none' }}
                    onChange={(event) => setPathInput(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), addPath())}
                  />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addPath}>Add</button>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 12.5 }}>
                Paths must be absolute. The scanner only reaches inside your home folder unless a removable drive triggered the scan.
              </p>
              {paths.length > 0 && (
                <div className="card" style={{ boxShadow: 'none' }}>
                  <div className="list">
                    {paths.map((entry) => (
                      <div className="list-row" key={entry}>
                        <div className="main-cell"><span className="path">{entry}</span></div>
                        <button type="button" className="btn-link" onClick={() => setPaths((current) => current.filter((item) => item !== entry))}>Remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || active} onClick={start}>
              {active ? 'A scan is already running' : 'Start scan'}
            </button>
          </div>
        </div>
      </Card>
      )}

      {!active && ['completed', 'cancelled'].includes(status.state) && (
        <Card title="Last result">
          {status.threatsDetected > 0 ? (
            <div className="health-result warn">
              <span className="badge"><AlertIcon size={26} /></span>
              <div>
                <h3>
                  {notQuarantined === 0
                    ? `${formatCount(status.threatsDetected)} threat(s) found and quarantined`
                    : `${formatCount(status.threatsDetected)} threat(s) found, ${formatCount(notQuarantined)} could not be quarantined`}
                </h3>
                <p>
                  {notQuarantined === 0
                    ? 'Every file that matched a known threat signature was encrypted and moved to quarantine, so it cannot run. Review them in Quarantine.'
                    : 'Files that matched a signature are moved to quarantine. Some could not be moved (for example because they are in use or read-only); remove them manually or scan again.'}
                </p>
              </div>
            </div>
          ) : status.state === 'completed' && !state.definitionInfo?.count ? (
            <div className="health-result warn">
              <span className="badge"><AlertIcon size={26} /></span>
              <div>
                <h3>Scan finished, but no threat definitions are installed</h3>
                <p>
                  {formatCount(status.filesScanned)} files were read, but without signatures nothing could be recognised as a threat.
                  Install definitions from Updates, then scan again.
                </p>
              </div>
            </div>
          ) : status.state === 'completed' ? (
            <div className="health-result ok">
              <span className="badge"><CheckCircleIcon size={28} /></span>
              <div>
                <h3>Your PC is in good condition</h3>
                <p>
                  No threats found. {formatCount(status.filesScanned)} files were checked in {formatDuration(status.elapsedMs)}
                  {licensed ? ', and real-time protection keeps watching new files.' : '.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="health-result warn">
              <span className="badge"><AlertIcon size={26} /></span>
              <div>
                <h3>The scan was cancelled</h3>
                <p>{formatCount(status.filesScanned)} files were checked before it stopped. Run a full scan to confirm your PC is clean.</p>
              </div>
            </div>
          )}
          {detections.length > 0 && (
            <div className="card" style={{ boxShadow: 'none', marginTop: 16 }}>
              <div className="list">
                {detections.map((item, index) => (
                  <div className="list-row" key={`${item.filePath}-${index}`}>
                    <span className={`dot ${item.quarantined ? 'warn' : 'bad'}`} />
                    <div className="main-cell">
                      <strong>{item.threatName}</strong>
                      <span className="path" title={item.filePath}>{shortPath(item.filePath, 80)}</span>
                    </div>
                    <div className="meta">
                      {titleCase(item.severity)}
                      <br />
                      {item.quarantined ? 'Quarantined' : `Not moved${item.error ? `: ${item.error}` : ''}`}
                    </div>
                  </div>
                ))}
              </div>
              {status.threatsDetected > detections.length && (
                <p className="muted" style={{ fontSize: 12, padding: '10px 20px' }}>
                  Showing the first {formatCount(detections.length)} of {formatCount(status.threatsDetected)} detections.
                </p>
              )}
            </div>
          )}
          {status.threatsDetected > 0 && (
            <div className="row wrap" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate?.('quarantine')}>Open quarantine</button>
            </div>
          )}
          {status.state === 'completed' && status.threatsDetected === 0 && (
            <div className="row wrap" style={{ marginTop: 16 }}>
              {!state.definitionInfo?.count && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate?.('updates')}>Get threat definitions</button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate?.('dashboard')}>View protection overview</button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

export default Scan
