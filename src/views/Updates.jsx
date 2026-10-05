import { useState } from 'react'
import { Banner, Card, Empty, KeyValue } from '../components/ui'
import * as api from '../lib/bridge'
import { APP_VERSION } from '../lib/bridge'
import { formatCount, formatDateTime, timeAgo } from '../lib/format'

/** No third-party engine names in the log: "ClamAV daily 28143" -> "28143". */
const plain = (text) => String(text ?? '').replace(/\bclam(av)?\b\s*(daily\s*)?/gi, '').trim()

/** One line of the update log, plus the dot tone. */
function describe(raw) {
  const event = raw ? { ...raw, version: raw.version && plain(raw.version), installedVersion: raw.installedVersion && plain(raw.installedVersion), error: raw.error && plain(raw.error) } : raw
  switch (event?.type) {
    case 'definitions-updated':
      return ['ok', `Threat signatures updated to version ${event.version}${Number.isFinite(event.signatureCount) ? ` (${formatCount(event.signatureCount)} signatures)` : ''}.`]
    case 'definitions-current':
      return ['ok', `${event.background ? 'Automatic check: t' : 'T'}hreat signatures version ${event.version} are already the newest.`]
    case 'definitions-checked':
      if (event.unknownLatest) return ['warn', `Could not reach the signature servers to compare versions${event.installedVersion ? `. Installed: version ${event.installedVersion}` : ''}.`]
      return event.upToDate
        ? ['ok', `Checked for new signatures: version ${event.installedVersion} is the newest.`]
        : event.installedVersion
          ? ['warn', `Signatures version ${event.version} is available (installed ${event.installedVersion}).`]
          : ['warn', 'Threat signatures are not downloaded yet.']
    case 'definitions-failed':
      return ['bad', `${event.background ? 'Automatic signature update' : 'Signature update'} failed. ${event.error || ''}`.trim()]
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
  const { updateEvents, refreshHistory, refreshDefinitions, definitionInfo } = state
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
        toasts.notify('Signatures checked', result.data?.upToDate
          ? `You have the newest signatures (version ${result.data.installedVersion}).`
          : `Version ${result.data?.version} is available. Choose Update now.`)
      } else if (result.data?.alreadyInstalled) {
        toasts.notify('Already up to date', `Version ${result.data.version} is the newest. Nothing was downloaded.`)
      } else {
        refreshHistory()
        refreshDefinitions?.()
        toasts.notify('Signatures updated', `Version ${result.data?.version} is now active.`)
      }
    }
  }

  const available = definition
  const hasSignatures = Boolean(definitionInfo?.count)
  const release = application?.release || null

  return (
    <div className="view stack">
      <Banner>
        <span className="dot ok" />
        <p>
          Aegis scans with its built-in engine and 3.6 million threat signatures. Signatures come from official signature
          servers, are digitally signed, and are checked before they are used. Aegis looks for new signatures when it starts
          and every 6 hours.
        </p>
      </Banner>

      {error && (
        <Banner tone="bad">
          <span className="dot bad" />
          <p>
            <strong>
              {error.kind.startsWith('definitions') ? 'Signature update failed.' : error.kind === 'application-open' ? 'Could not open the download.' : 'Application update check failed.'}
            </strong>{' '}
            {error.message}
          </p>
        </Banner>
      )}

      <div className="grid two">
        <Card title="Threat signatures" subtitle="What the scanning engine recognises">
          {hasSignatures ? (
            <>
              <KeyValue label="Scanning engine">{definitionInfo.engineRunning ? 'Running' : 'Starts when needed'}</KeyValue>
              <KeyValue label="Signature version">{definitionInfo.version}</KeyValue>
              <KeyValue label="Signatures">{formatCount(definitionInfo.count)}</KeyValue>
              {definitionInfo.updatedAt && <KeyValue label="Last updated">{formatDateTime(definitionInfo.updatedAt)}</KeyValue>}
            </>
          ) : (
            <Empty glyph="↻" title="Threat signatures are not downloaded yet">
              Aegis downloads about 110 MB of threat signatures the first time. Until then it cannot detect threats.
            </Empty>
          )}

          {available && !available.unknownLatest && (
            <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
              <div className="section-title">Newest available</div>
              <KeyValue label="Version">{available.version}</KeyValue>
              {available.publishedAt && <KeyValue label="Published">{formatDateTime(available.publishedAt)}</KeyValue>}
              {available.upToDate && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>You already have these signatures.</p>}
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => run('definitions-check')}>
              {busy === 'definitions-check' ? 'Checking…' : 'Check for updates'}
            </button>
            {(!hasSignatures || (available && !available.upToDate)) && (
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => run('definitions-install')}>
                {busy === 'definitions-install' ? (hasSignatures ? 'Updating…' : 'Downloading…') : hasSignatures ? 'Update now' : 'Download signatures'}
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
            Signature updates, failures and application update checks appear here.
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
                    <div className="when">{timeAgo(event.at)}{event.repeats > 1 ? ` · same result ${event.repeats} times, first ${timeAgo(event.firstAt)}` : ''}</div>
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
