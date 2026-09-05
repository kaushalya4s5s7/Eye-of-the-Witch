/**
 * Tests for `streamRun` (see jsonl-sse.ts) — the SSE tailing/termination
 * loop behind run-mode `/dev/events?run_id=...`. Every Important-tier bug
 * the final review found (I1, I2) and one Minor-tier one (M2) lived in this
 * exact function; per the review's R3 recommendation, `streamRun` is
 * exported and driven here with a real temp directory, a fake req/res pair
 * satisfying its minimal `StreamRunRequest`/`StreamRunResponse` interfaces,
 * and a stubbed `isRunInFlight`, instead of spawning the real Python
 * pipeline.
 *
 * `readFile` from `node:fs/promises` is mocked (delegating to the real
 * implementation except when told to fail) so the I1 test can inject a
 * single transient read failure deterministically, by call count rather
 * than by timing. Everything else (`access`, `mkdir`, `writeFile`) is real,
 * and file setup/teardown in this test file uses the synchronous `node:fs`
 * API directly, bypassing the mock entirely.
 *
 * Follows the conventions of src/lib/tailFile.test.ts (same project): real
 * file I/O, no mocking of the pure logic itself, temp dirs cleaned up after
 * each test.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readFileControl = vi.hoisted(() => ({
  callCount: 0,
  failOnCall: null as number | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      readFileControl.callCount++
      if (readFileControl.failOnCall === readFileControl.callCount) {
        throw new Error('simulated transient read failure')
      }
      return actual.readFile(...args)
    }),
  }
})

const { streamRun } = await import('./jsonl-sse')
type StreamRunRequest = Parameters<typeof streamRun>[0]
type StreamRunResponse = Parameters<typeof streamRun>[1]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class FakeReq implements StreamRunRequest {
  private closeHandlers: Array<() => void> = []
  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeHandlers.push(listener)
  }
  triggerClose(): void {
    for (const cb of this.closeHandlers) cb()
  }
}

class FakeRes implements StreamRunResponse {
  statusCode = 200
  ended = false
  chunks: string[] = []
  writeHead(status: number, _headers?: Record<string, string>): void {
    this.statusCode = status
  }
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk)
    this.ended = true
  }
  /** The JSON payload of every `data: ...` SSE frame written, in order. */
  dataFrames(): string[] {
    return this.chunks
      .filter((c) => c.startsWith('data: '))
      .map((c) => c.slice('data: '.length).replace(/\n\n$/, ''))
  }
  sawEnd(): boolean {
    return this.chunks.some((c) => c.startsWith('event: end'))
  }
}

let runsDir: string

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'eotw-streamrun-'))
  readFileControl.callCount = 0
  readFileControl.failOnCall = null
})

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true })
})

/** Creates runsDir/<run-id>/events.jsonl with the given already-complete lines. */
function makeRun(lines: string[]): { runId: string; eventsPath: string } {
  const runId = `run-${randomUUID()}`
  const dir = join(runsDir, runId)
  mkdirSync(dir, { recursive: true })
  const eventsPath = join(dir, 'events.jsonl')
  writeFileSync(eventsPath, lines.length ? lines.join('\n') + '\n' : '')
  return { runId, eventsPath }
}

describe('streamRun happy path', () => {
  it('delivers every complete line then terminates once the run is no longer in flight and nothing new remains', async () => {
    const { runId } = makeRun(['{"a":1}', '{"b":2}'])
    let inFlight = true
    const req = new FakeReq()
    const res = new FakeRes()

    const promise = streamRun(req, res, runId, runsDir, () => inFlight)
    await sleep(80) // let the first poll happen and deliver both lines
    expect(res.dataFrames()).toEqual(['{"a":1}', '{"b":2}'])
    expect(res.ended).toBe(false) // still polling — inFlight is still true

    inFlight = false
    await promise

    expect(res.dataFrames()).toEqual(['{"a":1}', '{"b":2}'])
    expect(res.sawEnd()).toBe(true)
    expect(res.ended).toBe(true)
  })
})

describe('streamRun — I1 (transient read failure)', () => {
  it('does not reset progress or cause early/duplicate delivery', async () => {
    const { runId, eventsPath } = makeRun(['{"a":1}', '{"b":2}'])
    // Fail exactly the 2nd readFile call streamRun makes: the 1st poll
    // succeeds (delivers the 2 seed lines), the 2nd is forced to throw.
    readFileControl.failOnCall = 2
    let inFlight = true
    const req = new FakeReq()
    const res = new FakeRes()

    const promise = streamRun(req, res, runId, runsDir, () => inFlight)

    await sleep(80) // 1st poll completes: 2 lines delivered, sentCount=2
    expect(res.dataFrames()).toEqual(['{"a":1}', '{"b":2}'])

    // A 3rd line lands on disk while the forced failure is in flight.
    appendFileSync(eventsPath, '{"c":3}\n')

    // Let the forced-failure poll (2nd call) and the recovery poll (3rd
    // call, which should pick up the 3rd line) both happen.
    await sleep(700)
    expect(res.dataFrames()).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']) // no duplicates, no reset
    expect(res.ended).toBe(false) // the one failed read must not have ended the stream early

    inFlight = false
    await promise

    expect(res.dataFrames()).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(res.sawEnd()).toBe(true)
  })
})

describe('streamRun — I2 (file-wait loop exit conditions)', () => {
  it('exits fast (not after the full FILE_WAIT_MS ceiling) once isRunInFlight goes false before the file ever appears', async () => {
    const runId = `run-${randomUUID()}` // deliberately never created — events.jsonl never appears
    let inFlight = true
    const req = new FakeReq()
    const res = new FakeRes()

    const start = Date.now()
    const promise = streamRun(req, res, runId, runsDir, () => inFlight)
    await sleep(50)
    inFlight = false
    await promise
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(5000) // nowhere near the 90s FILE_WAIT_MS ceiling
    expect(res.statusCode).toBe(404)
    expect(res.ended).toBe(true)
  })

  it('a client disconnect while waiting for the file stops the loop without writing to the aborted response', async () => {
    const runId = `run-${randomUUID()}` // never created
    const req = new FakeReq()
    const res = new FakeRes()

    const promise = streamRun(req, res, runId, runsDir, () => true) // run "still in flight" the whole time
    await sleep(20)
    req.triggerClose()
    await promise

    // The wait loop's `if (closed) return` fires before it ever calls
    // writeHead/write/end — a disconnected client's response is left alone.
    expect(res.chunks).toEqual([])
    expect(res.ended).toBe(false)
  })
})

describe('streamRun — M2 (per-run, not global, in-flight tracking)', () => {
  it('tailing an old completed run while a different run_id is in flight terminates correctly instead of hanging', async () => {
    const { runId: oldRunId } = makeRun(['{"old":1}', '{"old":2}'])
    const newRunId = `run-${randomUUID()}` // the "currently in flight" run — different id, no file needed here

    // Mirrors the real plugin's `() => inFlightRunId === runId`: this
    // predicate is specific to oldRunId, so it stays false the whole time
    // even though "a" run (newRunId) is in flight — the bug (M2) was a
    // bare boolean that would have made this true and hung until
    // HARD_CEILING_MS (5 minutes).
    const isOldRunInFlight = () => newRunId === oldRunId // always false: different ids

    const req = new FakeReq()
    const res = new FakeRes()
    const start = Date.now()
    await streamRun(req, res, oldRunId, runsDir, isOldRunInFlight)
    const elapsed = Date.now() - start

    expect(res.dataFrames()).toEqual(['{"old":1}', '{"old":2}'])
    expect(res.sawEnd()).toBe(true)
    expect(elapsed).toBeLessThan(5000) // did not hang toward the 5-minute HARD_CEILING_MS
  })
})
