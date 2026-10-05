import { useEffect, useMemo, useState } from 'react'
import { Banner, Card, ConfirmDialog, LicenseLock } from '../components/ui'
import { CleanerIcon } from '../components/icons'
import * as api from '../lib/bridge'
import { isLicensed } from '../lib/licensing'
import { formatBytes, formatCount, timeAgo } from '../lib/format'

function Cleaner({ state, toasts, onNavigate }) {
  const licensed = isLicensed(state.licenseStatus)
  const [status, setStatus] = useState(null)
  // Ticks belong to one analysis; a new analysis starts from the recommended categories.
  const [picked, setPicked] = useState({ at: null, ids: new Set() })
  const [confirm, setConfirm] = useState(false)

  const busy = status?.state === 'analyzing' || status?.state === 'cleaning'
  const analysis = status?.analysis || null
  const lastClean = status?.lastClean || null

  useEffect(() => {
    let alive = true
    api.cleaner.status().then((result) => { if (alive && result.ok) setStatus(result.data) })
    const unsubscribe = api.cleaner.onUpdate((next) => setStatus(next))
    return () => { alive = false; unsubscribe() }
  }, [])

  const selected = useMemo(() => {
    if (!analysis) return new Set()
    if (picked.at === analysis.at) return picked.ids
    return new Set(analysis.categories.filter((c) => c.defaultOn && c.bytes > 0).map((c) => c.id))
  }, [analysis, picked])

  const analyze = async () => {
    const result = await api.cleaner.analyze()
    if (!result.ok) toasts.fail('Could not analyze this computer', result.error)
  }

  // Opening the page measures the junk straight away, like a quick scan.
  useEffect(() => {
    if (licensed && status && !busy && !analysis && !lastClean) analyze()
  }, [licensed, status === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (analysis?.categories || []).filter((c) => selected.has(c.id)), [analysis, selected])
  const chosenBytes = chosen.reduce((sum, c) => sum + c.bytes, 0)
  const chosenFiles = chosen.reduce((sum, c) => sum + c.files, 0)
  const emptiesBin = chosen.some((c) => c.id === 'recycle')
  const needsAdmin = chosen.some((c) => c.elevated)

  const toggle = (id) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked({ at: analysis.at, ids: next })
  }

  const clean = async () => {
    setConfirm(false)
    const result = await api.cleaner.clean(chosen.map((c) => c.id))
    if (!result.ok) {
      toasts.fail('Cleaning failed', result.error)
      return
    }
    const r = result.data
    toasts.notify(
      r.freedBytes ? `Freed ${formatBytes(r.freedBytes)}` : 'Nothing could be removed',
      `${formatCount(r.deleted)} file(s) removed${r.skipped ? `, ${formatCount(r.skipped)} skipped because they are in use` : ''}.`,
    )
    if (r.elevationDeclined) toasts.warn('Windows Update leftovers were skipped', 'Windows did not get permission to remove them. Clean again and choose Yes when Windows asks.')
    state.refreshHistory?.()
    await analyze()
  }

  if (!licensed) {
    return (
      <div className="view stack">
        <Card title="PC Cleaner is locked">
          <LicenseLock title="PC Cleaner is included with every Aegis plan" onActivate={() => onNavigate?.('license')}>
            Activate your licence to find and remove temporary files, browser caches, crash reports and other junk
            that takes up space on this computer.
          </LicenseLock>
        </Card>
      </div>
    )
  }

  return (
    <div className="view stack">
      <Banner>
        <span className="dot ok" />
        <p>
          PC Cleaner only removes junk from well-known places: temporary folders, browser caches, crash reports and
          the {navigator.platform?.startsWith('Mac') ? 'Trash' : 'Recycle Bin'} if you choose it. Your documents, photos,
          programs, passwords and browser history are never touched.
        </p>
      </Banner>

      <Card className="cleaner-hero">
        <div className="cleaner-summary">
          <span className={`cleaner-badge ${busy ? 'busy' : ''}`}><CleanerIcon size={30} /></span>
          <div className="cleaner-figure">
            {busy ? (
              <>
                <h2>{status.state === 'cleaning' ? 'Cleaning…' : 'Looking for junk…'}</h2>
                <p>{status.current ? `Checking ${status.current.toLowerCase()}` : 'Starting'}{status.progress ? ` · ${formatCount(status.progress.deleted)} removed` : ''}</p>
              </>
            ) : analysis ? (
              <>
                <h2>{analysis.totalBytes ? <>{formatBytes(analysis.totalBytes)} <span>of junk found</span></> : 'Your computer is clean'}</h2>
                <p>Analyzed {timeAgo(analysis.at)}{lastClean ? ` · last cleaning freed ${formatBytes(lastClean.freedBytes)}` : ''}</p>
              </>
            ) : (
              <>
                <h2>Free up space on this computer</h2>
                <p>Analyze to see how much junk can be removed. Nothing is deleted until you choose to clean.</p>
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {busy ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.cleaner.cancel()}>Stop</button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={analyze}>{analysis ? 'Analyze again' : 'Analyze'}</button>
            )}
          </div>
        </div>
        {busy && <div className="progress indeterminate" style={{ marginTop: 18 }}><i /></div>}
      </Card>

      {analysis && (
        <Card title="What can be removed" subtitle="Ticked items are removed when you clean." bodyClass="tight">
          <div className="list">
            {analysis.categories.map((category) => {
              const empty = category.bytes === 0
              return (
                <label className={`list-row cleaner-row ${empty ? 'is-empty' : ''}`} key={category.id}>
                  <input
                    type="checkbox"
                    className="cleaner-check"
                    checked={selected.has(category.id)}
                    disabled={empty || busy}
                    onChange={() => toggle(category.id)}
                  />
                  <div className="main-cell">
                    <strong>{category.label}{category.elevated && !empty && <span className="cleaner-admin">Needs administrator</span>}</strong>
                    <span className="cleaner-desc">{category.description}</span>
                    {category.parts?.length > 0 && (
                      <span className="cleaner-parts">
                        {category.parts.map((part) => `${part.name} ${formatBytes(part.bytes)}${part.running ? ' (open)' : ''}`).join(' · ')}
                      </span>
                    )}
                    {category.note && <span className="cleaner-note">{category.note}</span>}
                  </div>
                  <div className="meta">
                    <strong className="cleaner-size">{empty ? 'Clean' : formatBytes(category.bytes)}</strong>
                    {!empty && `${formatCount(category.files)} file(s)`}
                  </div>
                </label>
              )
            })}
          </div>
          <div className="cleaner-actions">
            <p className="muted">
              {chosen.length ? `${formatBytes(chosenBytes)} in ${formatCount(chosenFiles)} file(s) selected.` : 'Tick what you want to remove.'}
            </p>
            <button type="button" className="btn btn-primary" disabled={busy || !chosen.length || !chosenBytes} onClick={() => setConfirm(true)}>
              <CleanerIcon size={16} /> Clean {chosen.length ? formatBytes(chosenBytes) : ''}
            </button>
          </div>
        </Card>
      )}

      {lastClean && (
        <Card title="Last cleaning" subtitle={timeAgo(lastClean.at)}>
          <div className="grid three">
            <div className="stat"><div className="label">Space freed</div><div className="value">{formatBytes(lastClean.freedBytes)}</div></div>
            <div className="stat"><div className="label">Files removed</div><div className="value">{formatCount(lastClean.deleted)}</div></div>
            <div className="stat"><div className="label">Skipped</div><div className="value">{formatCount(lastClean.skipped)}</div><div className="note">In use or protected by the system</div></div>
          </div>
          {lastClean.skippedBrowsers?.length > 0 && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
              {lastClean.skippedBrowsers.join(', ')} {lastClean.skippedBrowsers.length > 1 ? 'were' : 'was'} open, so {lastClean.skippedBrowsers.length > 1 ? 'their caches were' : 'its cache was'} left alone. Close it and clean again.
            </p>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        title={`Remove ${formatBytes(chosenBytes)} of junk?`}
        body={`${chosen.map((c) => c.label).join(', ')} will be cleaned. Removed files cannot be restored.${emptiesBin ? ' This empties the Recycle Bin / Trash, so anything you deleted earlier will be gone for good.' : ''}${needsAdmin ? ' Windows will then ask for permission to remove the Windows Update leftovers.' : ''}`}
        confirmLabel="Clean now"
        onCancel={() => setConfirm(false)}
        onConfirm={clean}
      />
    </div>
  )
}

export default Cleaner
