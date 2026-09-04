import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { eventStreamUrl, type StreamOptions } from '../lib/events'
import { validateEvent } from '../lib/schema'

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[38;5;244m',
  name: '\x1b[38;5;81m', // cyan-ish
  key: '\x1b[38;5;108m', // muted green
  warn: '\x1b[38;5;179m', // amber
  err: '\x1b[38;5;203m', // red
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Render one already-parsed event object as a single terminal line. */
function formatLine(obj: Record<string, unknown>): string {
  const { event, ...rest } = obj
  const fields = Object.entries(rest)
    .map(([k, v]) => `${ANSI.key}${k}${ANSI.reset}=${JSON.stringify(v)}`)
    .join('  ')
  return `${ANSI.dim}[${stamp()}]${ANSI.reset} ${ANSI.name}${String(event)}${ANSI.reset}${
    fields ? '  ' + fields : ''
  }`
}

/**
 * Right pane. Embeds xterm.js and prints each event from the dev feed as one
 * formatted line. It only ever prints events that pass the schema validator —
 * an off-schema line is flagged, not rendered as if it were real.
 */
export function EventTerminal({ options }: { options: StreamOptions }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: false,
      cursorStyle: 'bar',
      theme: {
        background: '#0a0d13',
        foreground: '#c4d0e0',
        selectionBackground: '#2a3550',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const doFit = () => {
      try {
        fit.fit()
      } catch {
        /* container not laid out yet */
      }
    }
    const raf = requestAnimationFrame(doFit)
    const resizeObserver = new ResizeObserver(doFit)
    resizeObserver.observe(host)

    const url = eventStreamUrl(options)
    term.writeln(`${ANSI.dim}eye-of-the-witch // backend event tail${ANSI.reset}`)
    term.writeln(`${ANSI.dim}source ${url}${ANSI.reset}`)
    term.writeln('')

    const source = new EventSource(url)

    source.onmessage = (message) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        term.writeln(`${ANSI.err}! unparseable line${ANSI.reset} ${message.data}`)
        return
      }
      const problems = validateEvent(parsed)
      if (problems.length > 0) {
        term.writeln(`${ANSI.err}! off-schema, not rendered${ANSI.reset} ${problems.join('; ')}`)
        return
      }
      term.writeln(formatLine(parsed as Record<string, unknown>))
    }

    source.addEventListener('end', () => {
      term.writeln('')
      term.writeln(`${ANSI.dim}-- stream end --${ANSI.reset}`)
      source.close()
    })

    source.onerror = () => {
      // EventSource auto-reconnects; only note it once per drop.
      term.writeln(`${ANSI.warn}~ stream interrupted, retrying${ANSI.reset}`)
    }

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      source.close()
      term.dispose()
    }
  }, [options])

  return <div ref={hostRef} className="terminal-host" />
}
