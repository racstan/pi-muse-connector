/**
 * Pi - Muse Connector — hosted API.
 *
 * Exposes Pi agent (https://github.com/earendil-works/pi) as a plain REST API so Meta Muse
 * (or any agent) can submit coding tasks and poll for results.
 *
 * BRING YOUR OWN KEY: every task carries the caller's own provider API key
 * (X-Pi-Api-Key header). The server never stores a model key — it writes the
 * key into a job-local Pi config ($workdir/.pi/agent/models.json via a
 * per-job HOME override) that is deleted with the workdir when the job ends.
 * The operator never sees or pays for inference.
 *
 * Endpoints:
 *   POST /api/pi-task        { "task": "..." } -> 202 { job_id, status }
 *   GET  /api/pi-task/:id    -> { id, status, result, error, ... }
 *   GET  /health             -> { ok: true }
 *   GET  /openapi.json       -> OpenAPI spec
 *   GET  /llms.txt           -> agent docs
 *
 * Jobs run strictly one at a time, each in a fresh temp workdir, with a
 * hard timeout. The child Pi process gets a scrubbed environment containing
 * only PATH/HOME/TERM — the provider key lives only in the job-local
 * models.json, never in env or process args, and never in logs.
 *
 * Env:
 *   PORT                 (default 3000)
 *   PI_BIN               (default "pi")
 *   PI_PROVIDER          default provider if caller omits X-Pi-Provider (default "openrouter")
 *   PI_MODEL             default model if caller omits X-Pi-Model (default "openrouter/free")
 *   PI_KEY_ENV           name of the server env var holding a fallback provider
 *                        key (default "OPENROUTER_API_KEY"); used when the
 *                        caller sends no X-Pi-Api-Key. Handy for self-hosters.
 *   JOB_TIMEOUT_MS       (default 300000 = 5 min)
 *   RATE_LIMIT_PER_HOUR  (default 5)
 *   MAX_TASK_CHARS       (default 2000)
 */
"use strict";

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.set("trust proxy", 1);

const PORT = parseInt(process.env.PORT || "3000", 10);
const PI_BIN = process.env.PI_BIN || "pi";
const DEFAULT_PROVIDER = (process.env.PI_PROVIDER || "openrouter").toLowerCase();
const DEFAULT_MODEL = process.env.PI_MODEL || "openrouter/free";
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10);
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || "5", 10);
const MAX_TASK_CHARS = parseInt(process.env.MAX_TASK_CHARS || "2000", 10);
const MAX_RESULT_CHARS = 50000;

const KNOWN_BASE_URLS = {
  openrouter: "https://openrouter.ai/api/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

const jobs = new Map(); // id -> job (apiKey stripped on every read path)
const queue = [];       // fifo of ids
let running = false;
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_HOUR;
}

// The caller's key: header first (how Muse injects vault secrets), body as
// fallback, then the server's own env (self-hosters who bake in their key).
const PI_KEY_ENV = process.env.PI_KEY_ENV || "OPENROUTER_API_KEY";
function readKey(req) {
  return (
    req.header("x-pi-api-key") ||
    (req.body && req.body.api_key) ||
    process.env[PI_KEY_ENV] ||
    ""
  )
    .toString()
    .trim();
}

function sanitize(job) {
  const { apiKey, ...pub } = job;
  return pub;
}

app.get("/", (req, res) =>
  res.json({
    name: "pi-muse-connector",
    auth: "bring your own provider key via X-Pi-Api-Key header",
    docs: "/llms.txt",
    openapi: "/openapi.json",
    health: "/health",
  })
);

app.get("/health", (req, res) =>
  res.json({ ok: true, queued: queue.length, running })
);

app.post("/api/pi-task", (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({
      error: "rate_limited",
      message: `Max ${RATE_LIMIT_PER_HOUR} tasks per hour per IP.`,
    });
  }
  const apiKey = readKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: "missing_key",
      message:
        "Provide your AI provider API key in the X-Pi-Api-Key header (e.g. your OpenRouter key).",
    });
  }
  const provider = (
    req.header("x-pi-provider") ||
    (req.body && req.body.provider) ||
    DEFAULT_PROVIDER
  )
    .toString()
    .toLowerCase();
  const model = (
    req.header("x-pi-model") ||
    (req.body && req.body.model) ||
    DEFAULT_MODEL
  ).toString();
  const baseUrl = (
    req.header("x-pi-base-url") ||
    (req.body && req.body.base_url) ||
    KNOWN_BASE_URLS[provider] ||
    ""
  ).toString();
  if (!baseUrl) {
    return res.status(400).json({
      error: "bad_request",
      message: `Unknown provider "${provider}". Pass X-Pi-Base-Url for custom providers.`,
    });
  }
  const task = ((req.body && req.body.task) || "").toString().trim();
  if (!task) {
    return res
      .status(400)
      .json({ error: "bad_request", message: 'Provide a "task" string.' });
  }
  if (task.length > MAX_TASK_CHARS) {
    return res.status(400).json({
      error: "bad_request",
      message: `Task too long (max ${MAX_TASK_CHARS} chars).`,
    });
  }
  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    status: "queued",
    task,
    provider,
    model,
    apiKey, // in-memory only until the run; never serialized to clients
    baseUrl,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return res.status(202).json({ job_id: id, status: "queued" });
});

app.get("/api/pi-task/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not_found" });
  return res.json(sanitize(job));
});

app.get("/openapi.json", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "openapi.json"))
);
app.get("/llms.txt", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "llms.txt"))
);

function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) {
    pump();
    return;
  }
  running = true;
  runJob(job).finally(() => {
    running = false;
    pump();
  });
}

function runJob(job) {
  return new Promise((resolve) => {
    job.status = "running";
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-job-"));

    // Job-local Pi config: the caller's key lives here and only here.
    // HOME override makes Pi read $workdir/.pi/agent/models.json.
    const agentDir = path.join(workdir, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const modelsPath = path.join(agentDir, "models.json");
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          [job.provider]: {
            api: "openai-completions",
            apiKey: job.apiKey,
            baseUrl: job.baseUrl,
            models: [{ id: job.model }],
          },
        },
      })
    );
    fs.chmodSync(modelsPath, 0o600);
    // Key is now on disk in the sandbox; drop it from memory.
    job.apiKey = null;

    const args = [
      "--print",
      "--no-session",
      "--provider",
      job.provider,
      "--model",
      job.model,
      "--",
      job.task,
    ];

    // Scrubbed env: PATH/HOME/TERM only, plus standard egress config when the
    // host needs it for outbound HTTPS (proxied or TLS-intercepting
    // environments). Absent on direct-egress hosts — harmless there.
    // No provider keys here: the key lives only in the job-local models.json,
    // never in env or process args, and never in logs.
    const childEnv = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: workdir,
      TERM: "dumb",
    };
    for (const v of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
      "NODE_USE_ENV_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ]) {
      if (process.env[v]) childEnv[v] = process.env[v];
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const child = spawn(PI_BIN, args, {
      cwd: workdir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored: pi --print must not wait on it
      timeout: JOB_TIMEOUT_MS,
    });

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_RESULT_CHARS)
        stdout = stdout.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => {
      finish("failed", null, `spawn error: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      if (timedOut) return; // handled by the timeout path
      if (code === 0) {
        finish("done", stdout.trim() || "(empty result)", null);
      } else {
        finish(
          "failed",
          null,
          `pi exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.trim().slice(-500)}`
        );
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {
        /* already gone */
      }
      finish("timeout", null, `task exceeded ${JOB_TIMEOUT_MS}ms and was killed`);
    }, JOB_TIMEOUT_MS);
    timer.unref();

    function finish(status, result, error) {
      if (finished) return; // first outcome wins (error then close both fire)
      finished = true;
      clearTimeout(timer);
      job.status = status;
      job.result = result;
      job.error = error;
      job.finished_at = new Date().toISOString();
      // best-effort cleanup of the sandbox dir (config + key with it)
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
      resolve();
    }
  });
}

app.listen(PORT, () => {
  console.log(`pi-muse-connector listening on :${PORT} (bring-your-own-key mode)`);
});
