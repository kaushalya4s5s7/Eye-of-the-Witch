/**
 * The upload gate. Shown only when no `?fixture=` is pinned in the URL —
 * the real entry point: gather one or more likenesses, kick off a real
 * pipeline run.
 *
 * Holds no pipeline knowledge beyond "post files, get a run id back or an
 * error" — see
 * docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RunConflictError, startRun } from '../lib/events'

const MAX_BYTES = 15 * 1024 * 1024
const MAX_FACES = 5

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

type Picked = { id: string; file: File; url: string }

function validateImage(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'that is not an image the Eye can read'
  if (file.size > MAX_BYTES) return 'too large — under 15MB each, please'
  return null
}

export function UploadGate({ onStarted }: { onStarted: (runId: string) => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const [picked, setPicked] = useState<Picked[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      for (const p of picked) URL.revokeObjectURL(p.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revoke on unmount only
  }, [])

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list)
    if (incoming.length === 0) return

    setPicked((prev) => {
      const room = MAX_FACES - prev.length
      if (room <= 0) {
        setStatus({ kind: 'error', message: 'five likenesses is enough — the Eye grows dizzy beyond that' })
        return prev
      }
      const next = [...prev]
      for (const file of incoming.slice(0, room)) {
        const err = validateImage(file)
        if (err) {
          setStatus({ kind: 'error', message: err })
          continue
        }
        next.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, url: URL.createObjectURL(file) })
      }
      if (next.length > prev.length) setStatus({ kind: 'idle' })
      return next
    })
  }, [])

  const removeAt = useCallback((id: string) => {
    setPicked((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((p) => p.id !== id)
    })
    setStatus({ kind: 'idle' })
  }, [])

  const cast = useCallback(async () => {
    if (picked.length === 0) {
      setStatus({ kind: 'error', message: 'offer at least one likeness before the rite begins' })
      return
    }
    setStatus({ kind: 'busy' })
    try {
      const { runId } = await startRun(picked.map((p) => p.file))
      onStarted(runId)
    } catch (err) {
      if (err instanceof RunConflictError) {
        setStatus({ kind: 'error', message: 'a ritual is already underway — wait for it to finish' })
      } else {
        setStatus({ kind: 'error', message: 'the rite failed to begin — try again' })
      }
    }
  }, [onStarted, picked])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      if (status.kind === 'busy') return
      addFiles(e.dataTransfer.files)
    },
    [addFiles, status.kind],
  )

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files)
      e.target.value = ''
    },
    [addFiles],
  )

  const busy = status.kind === 'busy'
  const count = picked.length

  return (
    <div className="upload-gate">
      <div
        className={`upload-gate__drop${dragOver ? ' is-drag-over' : ''}${busy ? ' is-busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => {
          if (!busy) inputRef.current?.click()
        }}
        onKeyDown={(e) => {
          if (busy) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Add face photos"
      >
        <p className="upload-gate__title">Show Her Your Face</p>
        <p className="upload-gate__hint">
          {busy
            ? 'the Eye is opening…'
            : count === 0
              ? 'drop a likeness, or click to choose'
              : `${count} likeness${count === 1 ? '' : 'es'} gathered — click to add another angle`}
        </p>
        <p className="upload-gate__counsel">
          One face opens the hunt. Offer more — front, side, soft light — and the Eye sees her truer across every sky.
        </p>

        {count > 0 && (
          <ul
            className="upload-gate__faces"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {picked.map((p, i) => (
              <li key={p.id} className="upload-gate__face">
                <img src={p.url} alt={`likeness ${i + 1}`} />
                <button
                  type="button"
                  className="upload-gate__face-remove"
                  aria-label={`Remove likeness ${i + 1}`}
                  disabled={busy}
                  onClick={() => removeAt(p.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {status.kind === 'error' && <p className="upload-gate__error">{status.message}</p>}
      </div>

      <button
        type="button"
        className="upload-gate__cast"
        disabled={busy || count === 0}
        onClick={(e) => {
          e.stopPropagation()
          void cast()
        }}
      >
        {busy ? 'Opening the Eye…' : count > 1 ? 'Cast These Likenesses' : 'Cast the Likeness'}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="upload-gate__input"
        onChange={onPick}
      />
    </div>
  )
}
