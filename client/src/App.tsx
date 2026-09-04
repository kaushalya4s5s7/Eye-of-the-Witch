import { SplitShell } from './components/SplitShell'
import { EventTerminal } from './components/EventTerminal'
import type { StreamOptions } from './lib/events'

// Module-level constant so the terminal effect doesn't re-run on every render.
// Build step 1: success fixture only, 800ms/line.
const STREAM: StreamOptions = { fixture: 'success', interval: 800 }

export default function App() {
  return (
    <SplitShell
      left={
        <div className="ritual-placeholder">
          <span className="ritual-placeholder__label">ritual UI</span>
          <span className="ritual-placeholder__note">left panel — not wired yet (build step 2)</span>
        </div>
      }
      right={
        <div className="terminal-frame">
          <header className="terminal-frame__bar">
            <span className="terminal-frame__dot" />
            backend event stream · fixtures/events-success.jsonl
          </header>
          <EventTerminal options={STREAM} />
        </div>
      }
    />
  )
}
