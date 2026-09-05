/**
 * One place that turns a feed line into a string for the xterm pane. Both the
 * shared stream hook (which owns the EventSource) and the terminal component
 * use this, so "known event" and "off-schema" lines always look the same.
 *
 * Hard rule (client/CLAUDE.md): the terminal shows EVERY line it receives.
 * Known events are formatted; anything off-schema is shown verbatim behind a
 * `! off-schema` marker — never dropped, never rendered as if it were real.
 */

export const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[38;5;244m',
  name: '\x1b[38;5;81m', // cyan-ish, known event name
  key: '\x1b[38;5;108m', // muted green, payload keys
  warn: '\x1b[38;5;179m', // amber
  err: '\x1b[38;5;203m', // red
}

export function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** A parsed, schema-valid event object -> one formatted line. */
export function formatEventLine(obj: Record<string, unknown>): string {
  const { event, ...rest } = obj
  const fields = Object.entries(rest)
    .map(([k, v]) => `${ANSI.key}${k}${ANSI.reset}=${JSON.stringify(v)}`)
    .join('  ')
  return `${ANSI.dim}[${stamp()}]${ANSI.reset} ${ANSI.name}${String(event)}${ANSI.reset}${
    fields ? '  ' + fields : ''
  }`
}

/** Parsed JSON, but off-schema (unknown name or bad payload). Shown verbatim. */
export function offSchemaLine(raw: string, problems: string[]): string {
  const why = problems.length ? ` ${ANSI.dim}(${problems.join('; ')})${ANSI.reset}` : ''
  return `${ANSI.warn}! off-schema${ANSI.reset} ${raw}${why}`
}

/** Not even JSON. Still shown. */
export function unparseableLine(raw: string): string {
  return `${ANSI.err}! unparseable${ANSI.reset} ${raw}`
}

/** A locally-synthesized note (stream end, synthetic Failed, idle hint). */
export function noteLine(text: string): string {
  return `${ANSI.dim}-- ${text} --${ANSI.reset}`
}
