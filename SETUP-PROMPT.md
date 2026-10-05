# Setup prompt — paste into Meta Muse

Copy everything below the line into Muse (replace the host first):

---

Connect to the Pi coding-agent API for me as a custom connector.

- API base: https://REPLACE-WITH-DEPLOYED-HOST
- OpenAPI spec: https://REPLACE-WITH-DEPLOYED-HOST/openapi.json
- Docs: https://REPLACE-WITH-DEPLOYED-HOST/llms.txt

What it does: it runs Pi, the terminal coding agent, on coding tasks I give you.

- `POST /api/pi-task` with `{ "task": "..." }` submits a task. It returns
  202 with a `job_id` immediately — the task runs asynchronously.
- `GET /api/pi-task/{job_id}` polls it. Status goes queued → running →
  done (or failed/timeout). When done, `result` holds Pi's answer.

Build the connector, then test it: submit the task "Write a Python
hello-world script", poll until it is done, and show me the result to confirm
it works.

After that, when I ask you to write or fix code, use this connector.

---
