/**
 * Pure helpers for incrementally tailing a growing JSONL file (see
 * vite-plugins/jsonl-sse.ts, run mode). Given the file's full current text
 * and how many complete lines were already sent, returns any new complete
 * lines plus the updated sent-count.
 *
 * A "complete" line is one already terminated by '\n' — the writer's last,
 * still-open line is held back until the next poll sees its newline, so a
 * line is never sent half-written.
 */

export function completeLines(raw: string): string[] {
  const cut = raw.endsWith('\n') ? raw.length : raw.lastIndexOf('\n') + 1
  return raw
    .slice(0, cut)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export interface TailResult {
  lines: string[]
  sentCount: number
}

/** @param raw the file's full text as of this poll
 *  @param sentCount how many complete lines were sent as of the last poll */
export function newLinesSince(raw: string, sentCount: number): TailResult {
  const lines = completeLines(raw)
  return { lines: lines.slice(sentCount), sentCount: lines.length }
}
