# Pi — Meta Muse Connector

**Ask Pi to write code, from inside Meta Muse.** This connector puts [Pi](https://pi.dev) — the terminal coding agent developers love — behind a plain REST API, so Meta Muse can hand it coding tasks and get back finished work.

```
Meta Muse ──(POST /api/pi-task)──▶ pi-muse-connector ──(pi --print)──▶ Pi agent
              (poll job status)         sandboxed runner               free models
```

## What a Muse user can do

| Ask Muse | What happens |
|---|---|
| "Write a Python script that parses this CSV" | Muse submits the task to Pi; polls; returns Pi's script |
| "Fix the bug in this function" + pasted code | Pi diagnoses and returns the fix |
| "Explain what this regex does" | Pi explains it in plain words |
| "Scaffold an Express app with a /health endpoint" | Pi returns the scaffold |

## Use it today — custom connector (no review, no wait)

Meta Muse can build a custom connector from any public API spec:

1. Deploy this service (see below) so it has a public HTTPS URL.
2. Open Muse and paste the prompt from [SETUP-PROMPT.md](./SETUP-PROMPT.md).
3. Muse writes and tests the client, saves it — then ask away.

## Directory listing

Submitted for review in the Muse Connectors directory at [muse.ai/platform](https://muse.ai/platform). Once approved: one tap in Settings → Connectors.

## Self-host

```bash
docker build -t pi-muse-connector .
docker run -p 3000:3000 \
  -e PI_PROVIDER=openrouter \
  -e PI_MODEL='openrouter/free' \
  -e OPENROUTER_API_KEY=your_key_here \
  pi-muse-connector
```

Env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `PI_PROVIDER` | — | Pi provider name (e.g. `openrouter`) |
| `PI_MODEL` | — | Pi model pattern (e.g. `openrouter/free`) |
| `PI_KEY_ENV` | `OPENROUTER_API_KEY` | Name of the env var holding the model key |
| `JOB_TIMEOUT_MS` | 300000 | Hard kill timeout per task (5 min) |
| `RATE_LIMIT_PER_HOUR` | 5 | Max tasks per IP per hour |
| `MAX_TASK_CHARS` | 2000 | Max task length |

API reference: [`openapi.json`](./openapi.json) · Agent docs: [`llms.txt`](./llms.txt) · Health: `GET /health`

## Safety model (v1)

- Jobs run **one at a time**, each in a **fresh temp workdir** deleted afterwards.
- The Pi child gets a **scrubbed environment** (PATH/HOME/TERM + the one model-key var) — host secrets never leak in.
- **Hard timeout** kills runaway tasks; **per-IP rate limits** blunt abuse.
- Runs as a **non-root** user in Docker.

Known v1 limits (hardening roadmap): the sandbox is a temp dir, not a VM/gVisor boundary; the model key is server-side, so set a spend cap on it; for production, put auth (API keys) in front of `/api/pi-task`. Do not expose this without understanding those tradeoffs.

## Costs

You pay for the model inference behind Pi. Use free-tier models (e.g. OpenRouter free) + the built-in rate limits to keep it near zero.

---

Built by [@beechrasta](https://github.com/beechrasta)
