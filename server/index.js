/**
 * Pi Muse Connector — hosted API.
 *
 * Exposes Pi (the terminal coding agent) as a plain REST API so Meta Muse
 * (or any agent) can submit coding tasks and poll for results.
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
 * only PATH/HOME/TERM plus the single model-key env var named by PI_KEY_ENV.
 *
 * Env:
 *   PORT                 (default 3000)
 *   PI_BIN               (default "pi")
 *   PI_PROVIDER          e.g. "openrouter"            (optional)
 *   PI_MODEL             e.g. "openrouter/free"       (optional)
 *   PI_KEY_ENV           name of env var holding the model key (default "OPENROUTER_API_KEY")
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
const PI_PROVIDER = process.env.PI_PROVIDER || "";
const PI_MODEL = process.env.PI_MODEL || "";
const PI_KEY_ENV = process.env.PI_KEY_ENV || "OPENROUTER_API_KEY";
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10);
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || "5", 10);
const MAX_TASK_CHARS = parseInt(process.env.MAX_TASK_CHARS || "2000", 10);
const MAX_RESULT_CHARS = 50000;

const jobs = new Map(); // id -> job
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

app.get("/", (req, res) =>
  res.json({
    name: "pi-muse-connector",
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
  return res.json(job);
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

    const args = ["--print", "--no-session"];
    if (PI_PROVIDER) args.push("--provider", PI_PROVIDER);
    if (PI_MODEL) args.push("--model", PI_MODEL);
    args.push("--", job.task);

    // Scrubbed env: only what Pi needs, nothing else (no host secrets leak).
    const childEnv = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      TERM: "dumb",
    };
    if (process.env[PI_KEY_ENV]) childEnv[PI_KEY_ENV] = process.env[PI_KEY_ENV];

    let stdout = "";
    let stderr = "";
    let timedOut = false;

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
      clearTimeout(timer);
      job.status = status;
      job.result = result;
      job.error = error;
      job.finished_at = new Date().toISOString();
      // best-effort cleanup of the sandbox dir
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
  console.log(`pi-muse-connector listening on :${PORT}`);
  if (!process.env[PI_KEY_ENV]) {
    console.log(
      `WARN: ${PI_KEY_ENV} is not set — Pi will fail unless the provider needs no key.`
    );
  }
});
