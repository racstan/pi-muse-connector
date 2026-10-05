# Pi — Meta Muse Connector

**Ask Pi to write code, from inside Meta Muse.** This connector puts [Pi](https://pi.dev) — the terminal coding agent developers love — behind a plain REST API, so Meta Muse can hand it coding tasks and get back finished work.

```
Meta Muse ──(POST /api/pi-task)──▶ pi-muse-connector ──(pi --print)──▶ Pi agent
              (poll job status)      your own machine,                your key,
                                     one Docker command               your bill
```

**Self-hosted by design.** You run it on your machine — no central server,
no sign-up, nobody else's bill. One Docker command, one free tunnel, and
Pi lives inside your Muse.

## What a Muse user can do

| Ask Muse | What happens |
|---|---|
| "Write a Python script that parses this CSV" | Muse submits the task to Pi; polls; returns Pi's script |
| "Fix the bug in this function" + pasted code | Pi diagnoses and returns the fix |
| "Explain what this regex does" | Pi explains it in plain words |
| "Scaffold an Express app with a /health endpoint" | Pi returns the scaffold |

## Use it today — custom connector (no review, no wait)

You host it yourself in about two minutes. Meta's servers make the connector
calls, so `localhost` won't do — you need a public HTTPS URL. A free
Cloudflare Tunnel gives you one with zero config:

```bash
# 1. Run the connector (put your provider key in the env)
docker build -t pi-muse-connector .
docker run -d -p 3000:3000 -e OPENROUTER_API_KEY=your_key_here pi-muse-connector

# 2. Expose it (free, no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:3000
# → gives you https://something.trycloudflare.com
```

Then in Muse:

1. Paste the prompt from [SETUP-PROMPT.md](./SETUP-PROMPT.md), replacing the
   host with your tunnel URL.
2. Muse builds and tests the connector, saves it — then ask away.

Prefer your key sealed in Muse's vault instead of in the container env?
Skip the `-e` flag and let Muse send it as the `X-Pi-Api-Key` header per call.

## Directory listing

Submitted for review in the Muse Connectors directory at [muse.ai/platform](https://muse.ai/platform). Once approved: one tap in Settings → Connectors.

## Bring your own key

Nobody pays for inference but you, and no central server ever holds a key.
**You** bring your own AI provider key (e.g. OpenRouter) — two ways:

**A. Sealed in Muse's vault (recommended).** When you connect it in Muse,
you enter your provider API key once. Muse stores it sealed — the connector
never sees it at rest — and sends it as the `X-Pi-Api-Key` header with each
task.

**B. In your container env.** Pass `-e OPENROUTER_API_KEY=...` to `docker run`
(it's your machine, your key). The server uses it as a fallback when no
header is sent.

Either way, the key is used for one Pi run at a time: written into a
job-local Pi config inside the task's sandbox directory and deleted with it
when the job ends. You pay your provider directly, at your provider's rates.

## How Pi runs inside

The container replicates the exact Pi setup recipe proven on the dev VM:

1. Pi installed via npm, version pinned (`@earendil-works/pi-coding-agent@0.87.1`).
2. Per task, the server writes a **job-local** `~/.pi/agent/models.json`
   (via a per-job `HOME` override) containing the caller's provider, model,
   and key — verified: Pi reads the job-local config, not any global one.
3. Each task spawns `pi --print --no-session --provider … --model … -- "<task>"`
   with stdin ignored, in a fresh temp workdir.

Verified: a real Pi run (OpenRouter free model) completed a file-writing task
end to end with exit 0 — `--print` mode auto-approves tool calls, no prompts,
no hangs.

## Self-host

```bash
docker build -t pi-muse-connector .
docker run -p 3000:3000 -e OPENROUTER_API_KEY=your_key_here pi-muse-connector
```

Your key can live in the container env (as above) or be sent per call as the
`X-Pi-Api-Key` header — header wins. Either way it is used for one Pi run at
a time and never leaves your machine.

Server env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `PI_PROVIDER` | `openrouter` | Default provider if caller omits `X-Pi-Provider` |
| `PI_MODEL` | `openrouter/free` | Default model if caller omits `X-Pi-Model` |
| `PI_KEY_ENV` | `OPENROUTER_API_KEY` | Env var holding the fallback server-side key |
| `JOB_TIMEOUT_MS` | 300000 | Hard kill timeout per task (5 min) |
| `RATE_LIMIT_PER_HOUR` | 5 | Max tasks per IP per hour |
| `MAX_TASK_CHARS` | 2000 | Max task length |

API reference: [`openapi.json`](./openapi.json) · Agent docs: [`llms.txt`](./llms.txt) · Health: `GET /health`

## Safety model (v1)

- Jobs run **one at a time**, each in a **fresh temp workdir** deleted afterwards.
- The Pi child gets a **scrubbed environment** (PATH/HOME/TERM plus standard
  network-egress vars only) — host secrets never leak in. Your provider key
  lives only in the job-local Pi config, never in env or process args.
- **Hard timeout** kills runaway tasks; **per-IP rate limits** blunt abuse.
- Runs as a **non-root** user in Docker.
- **Your provider key** is used for one Pi run only, kept inside the task's
  sandbox, and deleted with it — never stored server-side.

Known v1 limits (hardening roadmap): the sandbox is a temp dir, not a VM/gVisor boundary; for production, put auth in front of `/api/pi-task` beyond the per-IP rate limit. Do not expose this without understanding those tradeoffs.

## Costs

You pay your own provider directly for the inference your tasks use — e.g.
OpenRouter's free models cost nothing. The connector operator pays nothing.

---

Built by [@beechrasta](https://github.com/beechrasta)
