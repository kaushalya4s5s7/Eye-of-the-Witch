import { describe, expect, it } from 'vitest'
import {
  PipelinePresenter,
  describeEvent,
  formatAcceptedPosts,
  formatEventLine,
  formatGraphSummary,
  noteLine,
  offSchemaLine,
  pipelineBootLines,
  stamp,
  unparseableLine,
} from './terminalFormat'

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('describeEvent / formatEventLine', () => {
  it('renders a clean face-scan line', () => {
    const line = plain(
      formatEventLine({
        event: 'FaceDetected',
        backend: 'insightface_buffalo_s',
        det_score: 0.8127,
        embedding_sha256: '9c1f4a7e2d0538a6f13c9045b7e8d1a5',
      }),
    )
    expect(line).toContain('Face detected')
    expect(line).toContain('insightface_buffalo_s')
  })

  it('renders search + chain steps clearly', () => {
    expect(plain(describeEvent({ event: 'SearchMerged', unique: 18 }))).toContain('merged')
    expect(plain(describeEvent({ event: 'PostAccepted', count: 3, top_sim: 0.91 }))).toContain(
      'Matching posts',
    )
    expect(plain(describeEvent({ event: 'Attested', tx_hash: '0xabc', uid: '0xuid', easscan: 'https://x' }))).toContain(
      'On-chain attestation',
    )
    expect(plain(describeEvent({ event: 'VerifyPassed', root: '0xroot', uid: '0xuid' }))).toContain(
      'Re-verify passed',
    )
  })
})

describe('PipelinePresenter', () => {
  it('emits stage banners in brief order', () => {
    const p = new PipelinePresenter()
    const face = p.format({ event: 'FaceDetected', backend: 'x', det_score: 0.9, embedding_sha256: 'ab' }).map(plain)
    expect(face.some((l) => l.includes('FACE SCAN'))).toBe(true)

    const search = p.format({ event: 'SearchMerged', unique: 4 }).map(plain)
    expect(search.some((l) => l.includes('WEB / SOCIAL SEARCH'))).toBe(true)

    const graph = p.format({ event: 'GraphUpserted', nodes: 10, edges: 9 }).map(plain)
    expect(graph.some((l) => l.includes('EVIDENCE GRAPH'))).toBe(true)

    const chain = p.format({ event: 'MerkleBuilt', root: '0xabc' }).map(plain)
    expect(chain.some((l) => l.includes('BLOCKCHAIN'))).toBe(true)
  })

  it('does not repeat the same stage banner', () => {
    const p = new PipelinePresenter()
    p.format({ event: 'FaceDetected', backend: 'x', det_score: 0.9, embedding_sha256: 'ab' })
    const second = p.format({ event: 'ImageHosted', url: 'https://i.ibb.co/x.jpg' }).map(plain)
    expect(second.some((l) => l.includes('FACE SCAN'))).toBe(false)
    expect(second.some((l) => l.includes('Face crop hosted'))).toBe(true)
  })
})

describe('formatAcceptedPosts / formatGraphSummary', () => {
  it('lists matching posts for the demo', () => {
    const lines = formatAcceptedPosts([
      { url: 'https://www.youtube.com/watch?v=1', faceSim: 0.9, title: 'Clip' },
    ]).map(plain)
    expect(lines[0]).toContain('matching posts found')
    expect(lines[1]).toContain('youtube.com')
  })

  it('summarizes graph node kinds', () => {
    const lines = formatGraphSummary({
      nodes: [
        { kind: 'FaceSeed', id: 'face:seed' },
        { kind: 'ImageHit', id: 'h1' },
        { kind: 'ImageHit', id: 'h2' },
        { kind: 'Post', id: 'p1' },
        { kind: 'Anchor', id: 'a1' },
      ],
      links: [{}, {}, {}],
    }).map(plain)
    expect(lines.some((l) => l.includes('seed → hits'))).toBe(true)
    expect(lines.some((l) => l.includes('5 nodes'))).toBe(true)
    expect(lines.some((l) => l.includes('ImageHit=2'))).toBe(true)
  })
})

describe('offSchemaLine — hard rule: never dropped, always verbatim + flagged', () => {
  it('keeps the raw line and appends the reasons', () => {
    const raw = '{"event":"FaceLocked","weird":true}'
    const line = plain(offSchemaLine(raw, ['unknown event "FaceLocked"']))
    expect(line).toContain('! off-schema')
    expect(line).toContain(raw)
    expect(line).toContain('unknown event "FaceLocked"')
  })

  it('still shows the raw line when there are no specific problems', () => {
    const raw = '{"event":"SearchMerged","x":1}'
    expect(plain(offSchemaLine(raw, []))).toContain(raw)
  })
})

describe('unparseableLine / noteLine / boot', () => {
  it('flags and preserves a non-JSON line', () => {
    const line = plain(unparseableLine('not json at all'))
    expect(line).toContain('unparseable')
    expect(line).toContain('not json at all')
  })

  it('wraps a local note in dashes', () => {
    expect(plain(noteLine('stream end'))).toBe('-- stream end --')
  })

  it('boots with the brief pipeline shape', () => {
    const boot = pipelineBootLines().map(plain).join('\n')
    expect(boot).toContain('Face scan')
    expect(boot).toContain('Blockchain')
  })
})

describe('stamp', () => {
  it('formats hh:mm:ss.mmm', () => {
    expect(stamp(new Date(2026, 0, 1, 4, 7, 9, 3))).toBe('04:07:09.003')
  })
})
