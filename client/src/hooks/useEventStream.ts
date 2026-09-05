/**
 * The one EventSource. Both panels read from what this hook produces, so the
 * terminal tail and the ritual stage can never drift out of sync.
 *
 * Responsibilities (client/CLAUDE.md "Stack"):
 *  - open a single SSE connection to the dev feed
 *  - every line -> staged pipeline terminal strings
 *  - every KNOWN event -> dispatched into the pure scene reducer
 *  - on PostAccepted -> fetch accepted.json, print posts + @StarsResolved
 *  - on GraphUpserted -> fetch graph.json, print evidence-graph summary
 *  - idle > 5s in scrying/weighing -> dispatch @Idle
 *  - stream ends with no terminal event -> dispatch @StreamEnded
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { eventStreamUrl, runFileUrl, type EventFeed } from '../lib/events'
import { classifyEvent, validateEvent } from '../lib/schema'
import {
  PipelinePresenter,
  formatAcceptedPosts,
  formatGraphSummary,
  noteLine,
  offSchemaLine,
  unparseableLine,
} from '../lib/terminalFormat'
import { initialScene, reduceScene } from '../scene/reducer'
import type { SceneState, Star } from '../scene/state'

export interface TerminalLine {
  id: number
  text: string
}

export interface EventStream {
  scene: SceneState
  lines: TerminalLine[]
  sourceUrl: string
}

const IDLE_MS = 5000
const STAR_STAGGER_MS = 600
const DIM = '\x1b[38;5;244m'
const RESET = '\x1b[0m'

/** Per-stream bookkeeping survives React StrictMode remount / SSE reconnect
 *  so the same events.jsonl lines are not printed twice. */
type StreamBook = { seen: Set<string>; presenter: PipelinePresenter }
const streamBooks = new Map<string, StreamBook>()

function bookFor(url: string): StreamBook {
  let book = streamBooks.get(url)
  if (!book) {
    book = { seen: new Set(), presenter: new PipelinePresenter() }
    streamBooks.set(url, book)
  }
  return book
}

/** accepted.json entry -> Star. Tolerant: the sidecar shape is provisional. */
function mapAccepted(raw: unknown): Star[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const o = (entry ?? {}) as Record<string, unknown>
      return {
        url: typeof o.url === 'string' ? o.url : '',
        thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : '',
        faceSim: typeof o.face_similarity === 'number' ? o.face_similarity : 0,
        title: typeof o.title === 'string' ? o.title : '',
      }
    })
    .filter((s) => s.url !== '')
}

export function useEventStream(source: EventFeed): EventStream {
  const [scene, dispatch] = useReducer(reduceScene, initialScene)
  const [lines, setLines] = useState<TerminalLine[]>([])

  const sourceUrl = eventStreamUrl(source)

  const sceneRef = useRef(scene)
  sceneRef.current = scene

  useEffect(() => {
    let lineId = 0
    const push = (text: string) =>
      setLines((prev) => [...prev, { id: lineId++, text }])
    const pushMany = (texts: string[]) => {
      if (texts.length === 0) return
      setLines((prev) => {
        const next = [...prev]
        for (const text of texts) next.push({ id: lineId++, text })
        return next
      })
    }

    const book = bookFor(sourceUrl)
    const { seen, presenter } = book
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let starTimer: ReturnType<typeof setTimeout> | undefined
    let ended = false

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        const phase = sceneRef.current.phase
        if (phase === 'scrying' || phase === 'weighing') {
          push(noteLine('scoring candidates against the seed face…'))
          dispatch({ event: '@Idle' })
        }
      }, IDLE_MS)
    }

    const endStream = () => {
      if (ended) return
      ended = true
      if (idleTimer) clearTimeout(idleTimer)
      eventStream.close()
      streamBooks.delete(sourceUrl)
      if (!sceneRef.current.terminalReached) {
        push(noteLine('stream ended with no result — the thread was cut'))
        dispatch({ event: '@StreamEnded' })
      } else {
        push('')
        push(noteLine('pipeline complete'))
      }
    }

    const eventStream = new EventSource(sourceUrl)

    eventStream.onmessage = (message) => {
      armIdle()

      // SSE reconnect / StrictMode remount re-tails events.jsonl from the start —
      // skip exact payloads we already rendered for this sourceUrl.
      if (seen.has(message.data)) return
      seen.add(message.data)

      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        push(unparseableLine(message.data))
        return
      }

      const problems = validateEvent(parsed)
      const obj = parsed as Record<string, unknown>
      const name = typeof obj.event === 'string' ? obj.event : ''
      const tier = classifyEvent(name)

      if (tier === 'unknown' || problems.length > 0) {
        push(offSchemaLine(message.data, problems))
      } else {
        pushMany(presenter.format(obj))
      }

      if (tier === 'unknown') return

      dispatch(parsed as Parameters<typeof reduceScene>[1])

      if (name === 'PostAccepted') {
        // Summary carries count; per-post events also use this name — only
        // load the sidecar once from the summary.
        if (typeof obj.count !== 'number') return
        void fetch(runFileUrl(source, 'accepted'))
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((json) => {
            const stars = mapAccepted(json)
            // Dedupe sidecar print too (reconnect can re-fire PostAccepted once
            // before seen catches it — key on run posts block).
            const postsKey = `posts:${message.data}`
            if (!seen.has(postsKey)) {
              seen.add(postsKey)
              pushMany(formatAcceptedPosts(stars))
            }
            if (stars.length === 0) return
            starTimer = setTimeout(
              () => dispatch({ event: '@StarsResolved', stars }),
              STAR_STAGGER_MS,
            )
          })
          .catch(() => {
            push(noteLine('no accepted.json sidecar for this run'))
          })
      }

      if (name === 'GraphUpserted') {
        void fetch(runFileUrl(source, 'graph'))
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((json) => {
            const graphKey = `graph:${message.data}`
            if (seen.has(graphKey)) return
            seen.add(graphKey)
            pushMany(formatGraphSummary(json))
          })
          .catch(() => {
            /* counts already on the event line */
          })
      }

      if (name === 'Attested' && typeof obj.easscan === 'string' && obj.easscan) {
        push(`${DIM}   explorer: ${obj.easscan}${RESET}`)
      }
    }

    eventStream.addEventListener('end', endStream)
    eventStream.onerror = () => {
      if (eventStream.readyState === EventSource.CLOSED) endStream()
    }

    armIdle()

    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (starTimer) clearTimeout(starTimer)
      eventStream.close()
    }
  }, [sourceUrl])

  return { scene, lines, sourceUrl }
}
