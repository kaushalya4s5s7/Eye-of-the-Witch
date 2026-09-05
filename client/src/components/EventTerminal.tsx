import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ANSI } from '../lib/terminalFormat'
import type { TerminalLine } from '../hooks/useEventStream'

/**
 * Right pane. A dumb xterm.js sink: it renders whatever lines the shared
 * `useEventStream` hook hands it, in order, exactly once each. The hook owns
 * the EventSource, the parsing, and the schema check — so this panel and the
 * ritual stage can never disagree about what the backend said.
 *
 * Every line the hook produces is printed. Off-schema lines arrive already
 * flagged and verbatim (see lib/terminalFormat.ts); nothing is filtered here.
 */
export function EventTerminal({ lines }: { lines: TerminalLine[] }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writtenRef = useRef(0)

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
    termRef.current = term

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

    term.writeln(`${ANSI.dim}eye-of-the-witch // backend event tail${ANSI.reset}`)
    term.writeln('')

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      writtenRef.current = 0
    }
  }, [])

  // Flush any lines we haven't printed yet.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    for (let i = writtenRef.current; i < lines.length; i++) {
      term.writeln(lines[i].text)
    }
    writtenRef.current = lines.length
  }, [lines])

  return <div ref={hostRef} className="terminal-host" />
}
