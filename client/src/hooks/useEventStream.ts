/**
 * The one EventSource. Both panels read from what this hook produces, so the
 * terminal tail and the ritual stage can never drift out of sync.
 *
 * Responsibilities (client/CLAUDE.md "Stack"):
 *  - open a single SSE connection to the dev feed
 *  - every line -> a terminal string (formatted if known, verbatim+flagged if not)
 *  - every KNOWN event -> dispatched into the pure scene reducer
 *  - on PostAccepted -> fetch accepted.json, then dispatch @StarsResolved
 *  - idle > 5s in scrying/weighing -> dispatch @Idle (the long candidate-scoring gap)
 *  - stream ends with no terminal event -> dispatch @StreamEnded (synthetic Failed)
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { eventStreamUrl, runFileUrl, type EventFeed } from '../lib/events'
import { classifyEvent, validateEvent } from '../lib/schema'
import {
  formatEventLine,
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

  // Latest scene, readable from inside long-lived callbacks without re-subscribing.
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  useEffect(() => {
    let lineId = 0
    const push = (text: string) =>
      setLines((prev) => [...prev, { id: lineId++, text }])

    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let starTimer: ReturnType<typeof setTimeout> | undefined
    let ended = false

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        const phase = sceneRef.current.phase
        if (phase === 'scrying' || phase === 'weighing') {
          push(noteLine('scoring candidates…'))
          dispatch({ event: '@Idle' })
        }
      }, IDLE_MS)
    }

    const endStream = () => {
      if (ended) return
      ended = true
      if (idleTimer) clearTimeout(idleTimer)
      eventStream.close() // stop the dev feed's 3s auto-reconnect + replay loop
      if (!sceneRef.current.terminalReached) {
        push(noteLine('stream ended with no result — the thread was cut'))
        dispatch({ event: '@StreamEnded' })
      } else {
        push(noteLine('stream end'))
      }
    }

    const eventStream = new EventSource(sourceUrl)

    eventStream.onmessage = (message) => {
      armIdle()

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
        push(formatEventLine(obj))
      }

      // Unknown / malformed -> terminal only, never touches the scene reducer.
      if (tier === 'unknown') return

      dispatch(parsed as Parameters<typeof reduceScene>[1])

      if (name === 'PostAccepted') {
        void fetch(runFileUrl(source, 'accepted'))
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((json) => {
            const stars = mapAccepted(json)
            if (stars.length === 0) return
            starTimer = setTimeout(
              () => dispatch({ event: '@StarsResolved', stars }),
              STAR_STAGGER_MS,
            )
          })
          .catch(() => {
            push(noteLine('no gallery sidecar for this run'))
          })
      }
    }

    eventStream.addEventListener('end', endStream)
    eventStream.onerror = () => {
      // The dev feed closes the socket after the last line; that surfaces here
      // as an error with readyState CLOSED. Treat only that as end-of-stream.
      if (eventStream.readyState === EventSource.CLOSED) endStream()
    }

    armIdle()

    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (starTimer) clearTimeout(starTimer)
      eventStream.close()
    }
    // INVARIANT (M12): this effect closes over the full `source` object (via
    // `eventStreamUrl`/`runFileUrl` calls inside), but the dep array below is
    // just `[sourceUrl]`. That's safe only because `sourceUrl` is derived
    // from every field `EventFeed` has that this effect reads — if
    // `EventFeed`'s shape ever grows a field the effect needs without also
    // folding it into `sourceUrl`, this array must be revisited (there is no
    // ESLint react-hooks/exhaustive-deps config in client/ to catch that
    // drift automatically).
  }, [sourceUrl])

  return { scene, lines, sourceUrl }
}
