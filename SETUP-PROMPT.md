# Setup prompt — paste into Meta Muse

Copy everything below the line into Muse (replace the host first):

---

Connect to the Pi - Muse Connector API for me as a custom connector.

- API base: https://YOUR-TUNNEL-URL.trycloudflare.com
  (I'm running the pi-muse-connector Docker image on my own machine and
  exposing it with `cloudflared tunnel --url http://localhost:3000` —
  replace with my actual tunnel URL)
- OpenAPI spec: https://YOUR-TUNNEL-URL.trycloudflare.com/openapi.json
- Docs: https://YOUR-TUNNEL-URL.trycloudflare.com/llms.txt

What it does: it runs Pi agent (https://github.com/earendil-works/pi), the terminal coding agent, on coding tasks I give you.

- `POST /api/pi-task` with `{ "task": "..." }` submits a task. It returns
  202 with a `job_id` immediately — the task runs asynchronously.
- `GET /api/pi-task/{job_id}` polls it. Status goes queued → running →
  done (or failed/timeout). When done, `result` holds Pi's answer.

Auth: my provider key is baked into my container env, so no per-call key
is needed. (If I ever remove it, ask me for my OpenRouter key, store it
sealed in your vault, and send it as the `X-Pi-Api-Key` header on every call.)
Optional headers: `X-Pi-Provider` (default openrouter), `X-Pi-Model`
(default openrouter/free).

Build the connector, then test it: submit the task "Write a Python
hello-world script", poll until it is done, and show me the result to confirm
it works.

After that, when I ask you to write or fix code, use this connector.

---
