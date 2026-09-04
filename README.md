# Eye of the Witch

Split-screen ritual UI. Left: fantasy / video UI. Right: a real terminal
(xterm.js) tailing a JSONL event stream from the backend pipeline.

The UI side lives in [`client/`](client/). Its ground-truth spec — event
schema, hard rules, UI state machine, build order — is
[`client/CLAUDE.md`](client/CLAUDE.md). Read that first.

## Layout

```
client/
  CLAUDE.md              ground-truth doc (read every session)
  fixtures/              hand-authored JSONL event runs for dev
  media/                 AI-generated video clips
  src/                   the UI
```

No backend logic lives in this repo. This repo only consumes events.
