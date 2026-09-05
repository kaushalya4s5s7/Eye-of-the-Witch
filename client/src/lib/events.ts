/** Client-side helpers for the dev event feed (see vite-plugins/jsonl-sse.ts). */

export type FixtureName = 'success' | 'success-noexpand' | 'nomatch' | 'failed'

/** Where events come from: a canned fixture (dev/QA, pinned by `?fixture=`
 *  in the URL), or a real run kicked off through the upload gate.
 *
 *  Named `EventFeed` (not `EventSource`) to avoid colliding with the
 *  browser's native `EventSource` global — see useEventStream.ts, which
 *  uses both in the same file (M7). */
export type EventFeed =
  | { mode: 'fixture'; fixture: FixtureName; interval?: number }
  | { mode: 'run'; runId: string }

export function eventStreamUrl(source: EventFeed): string {
  const params = new URLSearchParams()
  if (source.mode === 'fixture') {
    params.set('fixture', source.fixture)
    if (source.interval != null) params.set('interval', String(source.interval))
  } else {
    params.set('run_id', source.runId)
  }
  return `/dev/events?${params.toString()}`
}

/**
 * URL for a run sidecar file (accepted.json, attest.json, ...). In fixture
 * mode the jsonl-sse plugin serves `fixtures/<name>.<fixture>.json`; in run
 * mode it serves `runs/<run_id>/<name>.json`.
 */
export function runFileUrl(source: EventFeed, name: string): string {
  const params = new URLSearchParams({ name })
  if (source.mode === 'fixture') {
    params.set('fixture', source.fixture)
  } else {
    params.set('run_id', source.runId)
  }
  return `/dev/run-file?${params.toString()}`
}

/** Thrown by startRun when a run is already in flight (HTTP 409). */
export class RunConflictError extends Error {}

/**
 * POST one or more face photos to /dev/run as multipart `images`, kicking
 * off a real pipeline run (seed gallery). Resolves as soon as the bridge
 * returns a run_id — the pipeline keeps running in the background.
 */
export async function startRun(files: File | File[]): Promise<{ runId: string }> {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (list.length === 0) throw new Error('could not start run: no images')

  const form = new FormData()
  for (const file of list) form.append('images', file, file.name)

  const res = await fetch('/dev/run', {
    method: 'POST',
    body: form,
  })
  if (res.status === 409) {
    throw new RunConflictError('a ritual is already underway')
  }
  if (!res.ok) {
    throw new Error(`could not start run: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { run_id: string }
  return { runId: body.run_id }
}
