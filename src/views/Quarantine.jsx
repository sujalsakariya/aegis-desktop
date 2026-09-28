import { useState } from 'react'
import { Banner, Card, ConfirmDialog, Empty } from '../components/ui'
import * as api from '../lib/bridge'
import { formatBytes, formatCount, shortPath, timeAgo } from '../lib/format'

function Quarantine({ state, toasts }) {
  const { quarantineItems, refreshQuarantine, allowedItems = [], refreshAllowed } = state
  const [pending, setPending] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const act = async (item, action) => {
    setBusyId(item.id)
    const result = action === 'restore' ? await api.quarantine.restore(item.id) : await api.quarantine.remove(item.id)
    setBusyId(null)
    if (result.ok) {
      toasts.notify(
        action === 'restore' ? 'File restored' : 'File deleted',
        action === 'restore' ? `Returned to ${shortPath(item.originalPath, 48)} and added to allowed items.` : `${item.threatName} removed permanently.`,
      )
      await refreshQuarantine()
    } else {
      toasts.fail(action === 'restore' ? 'Could not restore the file' : 'Could not delete the file', result.error)
    }
  }

  const removeAllowed = async (entry) => {
    setBusyId(entry.sha256)
    const result = await api.quarantine.removeAllowed(entry.sha256)
    setBusyId(null)
    if (result.ok) {
      toasts.notify('No longer allowed', `${shortPath(entry.path, 48)} will be quarantined again if it is scanned or changed.`)
      await refreshAllowed?.()
    } else {
      toasts.fail('Could not update allowed items', result.error)
    }
  }

  const totalSize = quarantineItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0)

  return (
    <div className="view stack">
      <Banner>
        <span className="dot ok" />
        <p>
          Quarantined files are encrypted with AES-256-GCM and moved out of their original location, so they cannot run.
          Restoring puts a file back exactly where it came from and adds it to your allowed items.
        </p>
      </Banner>

      <Card
        title="Quarantined items"
        subtitle={quarantineItems.length ? `${formatCount(quarantineItems.length)} item(s) · ${formatBytes(totalSize)} held` : 'Nothing is isolated'}
        bodyClass="tight"
      >
        {quarantineItems.length === 0 ? (
          <Empty title="Quarantine is empty">
            When a scan or real-time protection finds a file matching a known signature, it is encrypted and moved here for you to review.
          </Empty>
        ) : (
          <div className="list">
            {quarantineItems.map((item) => (
              <div className="list-row" key={item.id}>
                <span className="dot bad" />
                <div className="main-cell">
                  <strong>{item.threatName}</strong>
                  <span className="path" title={item.originalPath}>{shortPath(item.originalPath, 70)}</span>
                </div>
                <div className="meta">
                  {formatBytes(item.size)}
                  <br />
                  {timeAgo(item.quarantinedAt)}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === item.id} onClick={() => setPending({ item, action: 'restore' })}>
                    Restore
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" disabled={busyId === item.id} onClick={() => setPending({ item, action: 'delete' })}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Allowed items"
        subtitle="Files you restored. Scans and real-time protection skip these exact files (matched by content hash)."
        bodyClass="tight"
      >
        {allowedItems.length === 0 ? (
          <Empty glyph="✓" title="No allowed items">
            Restoring a file from quarantine adds it here so it is not quarantined again.
          </Empty>
        ) : (
          <div className="list">
            {allowedItems.map((entry) => (
              <div className="list-row" key={entry.sha256}>
                <span className="dot warn" />
                <div className="main-cell">
                  <strong>{entry.threatName || 'Allowed file'}</strong>
                  <span className="path" title={`${entry.path}\nSHA-256 ${entry.sha256}`}>{shortPath(entry.path, 70)}</span>
                </div>
                <div className="meta">
                  Allowed
                  <br />
                  {timeAgo(entry.allowedAt)}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === entry.sha256} onClick={() => removeAllowed(entry)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.action === 'restore' ? 'Restore this file?' : 'Delete this file permanently?'}
        body={
          pending?.action === 'restore'
            ? `${pending?.item.threatName} will be decrypted and written back to ${shortPath(pending?.item.originalPath || '', 60)}, and this exact file will be allowed so Aegis does not quarantine it again. It matched a known threat signature, so only restore it if you are certain the detection was wrong.`
            : `${pending?.item.threatName} will be erased from quarantine. This cannot be undone.`
        }
        confirmLabel={pending?.action === 'restore' ? 'Restore and allow' : 'Delete permanently'}
        tone={pending?.action === 'restore' ? 'primary' : 'danger'}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const current = pending
          setPending(null)
          if (current) act(current.item, current.action)
        }}
      />
    </div>
  )
}

export default Quarantine
