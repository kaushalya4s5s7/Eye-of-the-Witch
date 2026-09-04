import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Dev-only event feed.
 *
 * Tails a JSONL file and pushes each line to the browser over Server-Sent
 * Events at `GET /dev/events`. This mirrors how the real UI will consume
 * `runs/<run_id>/events.jsonl` later — the client code stays identical, only
 * the source file (and the artificial pacing) changes. See client/CLAUDE.md,
 * build step 8.
 *
 * Query params:
 *   fixture   "success" | "failure"   which file under fixtures/ to replay
 *   interval  milliseconds            delay between lines (default 800)
 *
 * The interval is a DEV convenience so the ritual is watchable. Real pipeline
 * events arrive with irregular gaps; step 8 drops the interval entirely.
 */

const FIXTURES: Record<string, string> = {
  success: 'fixtures/events-success.jsonl',
  failure: 'fixtures/events-failure.jsonl',
}

const DEFAULT_INTERVAL_MS = 800
const ENDPOINT = '/dev/events'

export function jsonlSse(): Plugin {
  return {
    name: 'eotw:jsonl-sse',
    configureServer(server) {
      server.middlewares.use(ENDPOINT, async (req, res) => {
        // connect strips the mount path, so req.url is like "/?fixture=success"
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const fixture = params.get('fixture') ?? 'success'
        const interval = Number(params.get('interval') ?? DEFAULT_INTERVAL_MS)

        const rel = FIXTURES[fixture]
        if (!rel) {
          res.statusCode = 400
          res.end(`unknown fixture "${fixture}" (expected: ${Object.keys(FIXTURES).join(', ')})`)
          return
        }

        let lines: string[]
        try {
          const raw = await readFile(resolve(server.config.root, rel), 'utf8')
          lines = raw
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        } catch (err) {
          res.statusCode = 500
          res.end(`could not read ${rel}: ${(err as Error).message}`)
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')

        let closed = false
        req.on('close', () => {
          closed = true
        })

        server.config.logger.info(
          `[jsonl-sse] streaming ${rel} (${lines.length} lines, ${interval}ms/line)`,
        )

        for (const line of lines) {
          if (closed) return
          res.write(`data: ${line}\n\n`)
          await delay(interval)
        }

        if (!closed) {
          res.write('event: end\ndata: {}\n\n')
          res.end()
        }
      })
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
