import { useState } from 'react'
import { Banner, Card, Empty, KeyValue } from '../components/ui'
import * as api from '../lib/bridge'
import { APP_VERSION } from '../lib/bridge'
import { formatCount, formatDateTime, timeAgo } from '../lib/format'

/** One line of the update log, plus the dot tone. */
function describe(event) {
  switch (event?.type) {
    case 'definitions-updated':
      return ['ok', `Definitions updated to ${event.version}${Number.isFinite(event.signatureCount) ? ` (${formatCount(event.signatureCount)} signatures)` : ''}.`]
    case 'definitions-current':
      return ['ok', `Definitions ${event.version} are already installed.`]
    case 'definitions-failed':
      return ['bad', `Definition update failed. ${event.error || ''}`.trim()]
    case 'application-checked':
      return event.updateAvailable
        ? ['warn', `Aegis ${event.latestVersion} is available (installed ${event.currentVersion}).`]
        : ['ok', `Aegis is up to date${event.latestVersion ? ` (latest release ${event.latestVersion})` : ''}.`]
    case 'application-check-failed':
      return ['bad', `Application update check failed. ${event.error || ''}`.trim()]
    default:
      return ['ok', 'Update event recorded.']
  }
}

function Updates({ state, toasts }) {
  const { updateEvents, historySummary, refreshHistory, refreshDefinitions, definitionInfo } = state
  const installed = historySummary?.definitions || null
  const [definition, setDefinition] = useState(null)
  const [application, setApplication] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')

  const run = async (kind) => {
    setBusy(kind)
    setError(null)
    const result =
      kind === 'definitions-check'
        ? await api.updates.checkDefinitions()
        : kind === 'definitions-install' || kind === 'definitions-reinstall'
          ? await api.updates.installDefinitions({ force: kind === 'definitions-reinstall' })
          : kind === 'application-open'
            ? await api.updates.openApplicationDownload()
            : await api.updates.checkApplication()
    setBusy('')

    if (!result.ok) {
      setError({ kind, message: result.error })
      toasts.fail(kind === 'application-open' ? 'Could not open the download' : 'Update failed', result.error)
      return
    }

    if (kind === 'application-open') {
      toasts.notify('Download opened in your browser', 'Run the installer when it finishes downloading.')
    } else if (kind === 'application-check') {
      setApplication(result.data)
      if (result.data?.updateAvailable) toasts.notify('Application update available', `Version ${result.data.latestVersion} is ready to download.`)
      else toasts.notify('Aegis is up to date', result.data?.latestVersion ? `You have the latest release (${result.data.latestVersion}).` : 'No newer release has been published.')
    } else {
      setDefinition(result.data)
      if (kind === 'definitions-check') {
        toasts.notify('Definitions checked', result.data?.noRelease
          ? `Version ${result.data.version} is installed and no newer release has been published.`
          : result.data?.upToDate ? `Version ${result.data.version} is already installed.` : `Version ${result.data?.version} is available.`)
      } else if (result.data?.alreadyInstalled) {
        toasts.notify('Already up to date', `Definitions ${result.data.version} are installed. Nothing was downloaded.`)
      } else {
        refreshHistory()
        refreshDefinitions?.()
        toasts.notify('Definitions installed', `Version ${result.data?.version} is now active.`)
      }
    }
  }

  const available = definition
  const upToDate = Boolean(available?.upToDate || (available && installed?.version === available.version && definitionInfo?.count))
  const release = application?.release || null

  return (
    <div className="view stack">
      <Banner>
        <span className="dot ok" />
        <p>
          Updates come from the Aegis update server, and every package is checked against its digital signature and checksum
          before it is installed. A package that fails either check, or is not a valid signature
          list, is rejected and your current definitions are kept.
        </p>
      </Banner>

      {error && (
        <Banner tone="bad">
          <span className="dot bad" />
          <p>
            <strong>
              {error.kind.startsWith('definitions') ? 'Definition update failed.' : error.kind === 'application-open' ? 'Could not open the download.' : 'Application update check failed.'}
            </strong>{' '}
            {error.message}
          </p>
        </Banner>
      )}

      <div className="grid two">
        <Card title="Threat definitions" subtitle="The signature set the scanner matches against.">
          {installed ? (
            <>
              <KeyValue label="Installed version">{installed.version || 'Unknown'}</KeyValue>
              <KeyValue label="Installed">{formatDateTime(installed.installedAt)}</KeyValue>
              {Number.isFinite(installed.signatureCount) && <KeyValue label="Signatures">{formatCount(installed.signatureCount)}</KeyValue>}
              {installed.sha256 && (
                <KeyValue label="Checksum"><span className="mono" style={{ fontSize: 11 }}>{String(installed.sha256).slice(0, 24)}…</span></KeyValue>
              )}
            </>
          ) : definitionInfo?.version ? (
            <>
              <KeyValue label="Installed version">{definitionInfo.version}</KeyValue>
              <KeyValue label="Signatures">{formatCount(definitionInfo.count)}</KeyValue>
            </>
          ) : (
            <Empty glyph="↻" title="No definitions installed">
              The scanner can only match signatures it has. Download and install a release to start detecting.
            </Empty>
          )}

          {available?.noRelease && (
            <p className="muted" style={{ borderTop: '1px solid var(--line)', fontSize: 12.5, marginTop: 16, paddingTop: 12 }}>
              Your definitions are current. No newer release has been published on the update server.
            </p>
          )}
          {available && !available.noRelease && (
            <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
              <div className="section-title">Available on the server</div>
              <KeyValue label="Version">{available.version}</KeyValue>
              {available.publishedAt && <KeyValue label="Published">{formatDateTime(available.publishedAt)}</KeyValue>}
              {upToDate && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>You already have this release.</p>}
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => run('definitions-check')}>
              {busy === 'definitions-check' ? 'Checking…' : 'Check for updates'}
            </button>
            {upToDate ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => run('definitions-reinstall')}>
                {busy === 'definitions-reinstall' ? 'Reinstalling…' : 'Reinstall'}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => run('definitions-install')}>
                {busy === 'definitions-install' ? 'Installing…' : 'Download and install'}
              </button>
            )}
          </div>
        </Card>

        <Card title="Application" subtitle="The Aegis desktop build itself.">
          <KeyValue label="Installed version">{application?.currentVersion || APP_VERSION}</KeyValue>
          {!application ? (
            <KeyValue label="Latest version">Not checked</KeyValue>
          ) : application.updateAvailable && release ? (
            <>
              <KeyValue label="Available version">{application.latestVersion}</KeyValue>
              {release.platform && <KeyValue label="Platform">{`${release.platform} · ${release.architecture}`}</KeyValue>}
              {release.releaseNotes && (
                <div style={{ borderTop: '1px solid var(--line)', marginTop: 8, paddingTop: 12 }}>
                  <div className="section-title">What&rsquo;s new</div>
                  <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{release.releaseNotes}</p>
                </div>
              )}
            </>
          ) : (
            <KeyValue label="Latest version">{application.latestVersion ? `${application.latestVersion} · up to date` : 'No releases published · up to date'}</KeyValue>
          )}
          <div className="row wrap" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => run('application-check')}>
              {busy === 'application-check' ? 'Checking…' : 'Check for a newer build'}
            </button>
            {application?.updateAvailable && (
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => run('application-open')}>
                {busy === 'application-open' ? 'Opening…' : 'Download update'}
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
            Download update opens the signed release in your browser. Run the installer to upgrade; your settings and quarantine are kept.
          </p>
        </Card>
      </div>

      <Card title="Update log" subtitle="The last 50 update events on this device." bodyClass="tight">
        {updateEvents.length === 0 ? (
          <Empty glyph="◷" title="Nothing logged yet">
            Definition installs, failures and application update checks appear here.
          </Empty>
        ) : (
          <div className="list">
            {updateEvents.map((event, index) => {
              const [tone, text] = describe(event)
              return (
                <div className="event-row" key={`${event.at}-${index}`}>
                  <span className={`dot ${tone}`} />
                  <div className="body">
                    <p>{text}</p>
                    <div className="when">{timeAgo(event.at)}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

export default Updates
