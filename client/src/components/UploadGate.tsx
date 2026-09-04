/**
 * The upload gate. Shown only when no `?fixture=` is pinned in the URL —
 * the real entry point: pick a photo, kick off a real pipeline run.
 *
 * Holds no pipeline knowledge beyond "post a file, get a run id back or an
 * error" — see
 * docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.
 */

import { useCallback, useRef, useState } from 'react'
import { RunConflictError, startRun } from '../lib/events'

const MAX_BYTES = 15 * 1024 * 1024

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

export function UploadGate({ onStarted }: { onStarted: (runId: string) => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setStatus({ kind: 'error', message: 'that is not an image the Eye can read' })
        return
      }
      if (file.size > MAX_BYTES) {
        setStatus({ kind: 'error', message: 'too large — under 15MB, please' })
        return
      }
      setStatus({ kind: 'busy' })
      try {
        const { runId } = await startRun(file)
        onStarted(runId)
      } catch (err) {
        if (err instanceof RunConflictError) {
          setStatus({ kind: 'error', message: 'a ritual is already underway — wait for it to finish' })
        } else {
          setStatus({ kind: 'error', message: 'the rite failed to begin — try again' })
        }
      }
    },
    [onStarted],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void submit(file)
    },
    [submit],
  )

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void submit(file)
      e.target.value = ''
    },
    [submit],
  )

  return (
    <div className="upload-gate">
      <div
        className={`upload-gate__drop${dragOver ? ' is-drag-over' : ''}${status.kind === 'busy' ? ' is-busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => status.kind !== 'busy' && inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <p className="upload-gate__title">Show Her Your Face</p>
        <p className="upload-gate__hint">
          {status.kind === 'busy' ? 'the Eye is opening…' : 'drop a photo, or click to choose one'}
        </p>
        {status.kind === 'error' && <p className="upload-gate__error">{status.message}</p>}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="upload-gate__input" onChange={onPick} />
    </div>
  )
}
