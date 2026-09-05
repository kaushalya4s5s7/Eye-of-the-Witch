import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunConflictError, eventStreamUrl, runFileUrl, startRun } from './events'

describe('eventStreamUrl', () => {
  it('builds a fixture-mode url', () => {
    expect(eventStreamUrl({ mode: 'fixture', fixture: 'success', interval: 800 })).toBe(
      '/dev/events?fixture=success&interval=800',
    )
  })

  it('omits interval when not given', () => {
    expect(eventStreamUrl({ mode: 'fixture', fixture: 'nomatch' })).toBe('/dev/events?fixture=nomatch')
  })

  it('builds a run-mode url', () => {
    expect(eventStreamUrl({ mode: 'run', runId: 'full-abc123' })).toBe('/dev/events?run_id=full-abc123')
  })
})

describe('runFileUrl', () => {
  it('builds a fixture-mode sidecar url', () => {
    expect(runFileUrl({ mode: 'fixture', fixture: 'success' }, 'accepted')).toBe(
      '/dev/run-file?name=accepted&fixture=success',
    )
  })

  it('builds a run-mode sidecar url', () => {
    expect(runFileUrl({ mode: 'run', runId: 'full-abc123' }, 'accepted')).toBe(
      '/dev/run-file?name=accepted&run_id=full-abc123',
    )
  })
})

describe('startRun', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves with the runId on success (multipart images)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ run_id: 'full-abc123' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array([1, 2, 3])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).resolves.toEqual({ runId: 'full-abc123' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/dev/run',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    )
  })

  it('accepts multiple files', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ run_id: 'full-abc123' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const a = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })
    const b = new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' })

    await expect(startRun([a, b])).resolves.toEqual({ runId: 'full-abc123' })
    const body = fetchMock.mock.calls[0][1].body as FormData
    expect(body.getAll('images')).toHaveLength(2)
  })

  it('throws RunConflictError on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '' }))
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).rejects.toBeInstanceOf(RunConflictError)
  })

  it('throws a generic error on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).rejects.toThrow(/500/)
  })
})
