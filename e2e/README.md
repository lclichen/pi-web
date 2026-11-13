# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Unknown sessions and paths outside the fixture project are rejected.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

Guardrail UI suite (separate runner, deterministic — no real model):

```sh
npm run test:e2e:guardrails
```

- A local OpenAI-compatible mock model (`e2e/mock-model.mjs`) drives a real
  `write` tool call to an out-of-workspace path, so the **path guard ask**
  dialog appears deterministically.
- Scenarios: ask options + allow-once / deny / deny-and-never-again /
  allow-and-never-again (decisions file, second-turn skip), session switch
  (hide + replay), page reload (replay), audit-free assertions.
- Known issue (documented, skipped by default): with a pending ask, opening a
  second window on the same session stays at “loading session”. Reproduce with
  `E2E_MULTI_WINDOW=1` (add `E2E_STRICT=1` to fail instead of warn).
- Runs its own dev server on a free loopback port (same `.next/dev` lock rule).

Real-channel checks (run against the VM / real targets, not part of `npm test`):

- `e2e/ssh-real.mjs` — runs INSIDE the VM: real ssh2 loopback to `127.0.0.1`,
  exercises `ssh-tools` bash/read/write/edit/ls/grep/find + `user_bash`
  against a temp remote dir, then cleans up. Prereq: a loopback key at
  `~/.ssh/qa_loopback` appended to `authorized_keys`:
  `ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/qa_loopback && cat ~/.ssh/qa_loopback.pub >> ~/.ssh/authorized_keys`.
- Local-machine / sandbox real tool round-trips live in the Python SDK QA suite
  (`qa/test_modes.py`: write/read must land on the paired machine / container).

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.
