import { useCallback, useState } from 'react'
import { SplitShell } from './components/SplitShell'
import { EventTerminal } from './components/EventTerminal'
import { RitualStage } from './components/RitualStage'
import { UploadGate } from './components/UploadGate'
import { useEventStream } from './hooks/useEventStream'
import type { EventSource, FixtureName } from './lib/events'

const FIXTURES: FixtureName[] = ['success', 'success-noexpand', 'nomatch', 'failed']

/** `?fixture=nomatch` / `?fixture=failed` for the verify checklist. Absent
 *  entirely -> the real upload gate, not a default fixture. */
function readFixture(): FixtureName | null {
  const q = new URLSearchParams(window.location.search).get('fixture')
  return (FIXTURES as string[]).includes(q ?? '') ? (q as FixtureName) : null
}

// Resolved once at load: fixture mode is locked in by the URL for the whole
// session, exactly as before. Run mode is chosen live via the upload gate.
const FIXED_FIXTURE = readFixture()

type Stage = { kind: 'gate' } | { kind: 'active'; source: EventSource }

export default function App() {
  const [stage, setStage] = useState<Stage>(() =>
    FIXED_FIXTURE
      ? { kind: 'active', source: { mode: 'fixture', fixture: FIXED_FIXTURE, interval: 800 } }
      : { kind: 'gate' },
  )

  const handleStarted = useCallback((runId: string) => {
    setStage({ kind: 'active', source: { mode: 'run', runId } })
  }, [])

  const handleCastAgain = useCallback(() => {
    setStage({ kind: 'gate' })
  }, [])

  if (stage.kind === 'gate') {
    return (
      <SplitShell
        left={<UploadGate onStarted={handleStarted} />}
        right={
          <div className="terminal-frame">
            <header className="terminal-frame__bar">
              <span className="terminal-frame__dot" />
              backend event stream · waiting for a photo
            </header>
            <EventTerminal lines={[]} />
          </div>
        }
      />
    )
  }

  return (
    <ActiveRun
      key={stage.source.mode === 'run' ? stage.source.runId : stage.source.fixture}
      source={stage.source}
      onCastAgain={handleCastAgain}
    />
  )
}

function ActiveRun({ source, onCastAgain }: { source: EventSource; onCastAgain: () => void }) {
  const { scene, lines } = useEventStream(source)
  const label =
    source.mode === 'fixture'
      ? `fixtures/events-${source.fixture}.jsonl`
      : `runs/${source.runId}/events.jsonl`

  return (
    <SplitShell
      left={<RitualStage scene={scene} onCastAgain={source.mode === 'run' ? onCastAgain : undefined} />}
      right={
        <div className="terminal-frame">
          <header className="terminal-frame__bar">
            <span className="terminal-frame__dot" />
            backend event stream · {label}
          </header>
          <EventTerminal lines={lines} />
        </div>
      }
    />
  )
}
