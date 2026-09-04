/** Client-side helpers for the dev event feed (see vite-plugins/jsonl-sse.ts). */

export type FixtureName = 'success' | 'failure'

export interface StreamOptions {
  fixture?: FixtureName
  /** ms between replayed lines; dev-only pacing, ignored by the real feed */
  interval?: number
}

export function eventStreamUrl(opts: StreamOptions = {}): string {
  const params = new URLSearchParams()
  if (opts.fixture) params.set('fixture', opts.fixture)
  if (opts.interval != null) params.set('interval', String(opts.interval))
  const qs = params.toString()
  return `/dev/events${qs ? `?${qs}` : ''}`
}
