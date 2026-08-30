// engine.js — the whole brain of ElianBot, in one file.
//
// The design rule is Musk's: the best part is no part.
//
//  * No wrapper scripts. A job runs as  spawn("/bin/bash", [script_path])  —
//    the script path is ARGV and the job's values are ENV. Nothing a job
//    contains is ever parsed as shell source, so there is nothing to escape
//    and no injection surface at all.
//  * No database. jobs.json (config) + state.json (results) + messages.json
//    (the @mention feed). All written atomically (tmp file + rename).
//  * One brain. Only the app fires jobs. Grok's MCP (mcp.js) edits jobs.json,
//    appends to messages.json, and drops a file into requests/ to ask for a
//    run; the app consumes everything within a second (fs.watch + 1s tick).
//
// Talking back and forth (@mentions) — line-leading, in a job's output:
//  * @grok <text>          posts <text> to the feed (Grok pulls read_messages).
//  * @<job-slug> [text]    runs that job with THIS job's full output as input
//                          (ELIANBOT_INPUT / ELIANBOT_INPUT_FILE), depth-capped.
//  * @notify <text>        macOS notification, immediately, with <text>.
//  * @webhook <url> [auth=<name>] [note]
//                          POSTs {job, at, note, output} as JSON to <url> —
//                          the door to any other app (Slack, Zapier, a phone).
//                          auth=<name> attaches "Authorization: Bearer <token>"
//                          using the token stored under <name> in
//                          <data>/secrets.json. The token never appears in
//                          output, feed, or logs — only its name does.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { validateCron, nextFire } = require("./cron");

const TAIL = 2000;        // chars of output kept inline for the UI
const HISTORY = 50;       // runs remembered per job
const MESSAGES = 300;     // feed length
const MAX_DEPTH = 3;      // @mention chain cap
const INPUT_INLINE = 8192; // max chars of input passed inline as env

// ---- shared by the app and the MCP process ----

// Where jobs/logs/messages live. Priority: ELIANBOT_DATA env (tests) →
// settings.json next to the app (user-chosen, editable from the UI) →
// ./data inside the app folder.
const SETTINGS = path.join(__dirname, "settings.json");

function dataRoot() {
  if (process.env.ELIANBOT_DATA) return process.env.ELIANBOT_DATA;
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    if (s && s.data_root) return s.data_root;
  } catch {}
  return path.join(__dirname, "data");
}

function P(root) {
  return {
    config: path.join(root, "jobs.json"),
    state: path.join(root, "state.json"),
    messages: path.join(root, "messages.json"),
    secrets: path.join(root, "secrets.json"),
    runs: path.join(root, "runs"),
    requests: path.join(root, "requests"),
    scripts: path.join(root, "scripts")
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, value) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fsp.rename(tmp, file);
}

const now = () => new Date().toISOString();
const slug = (s) =>
  String(s || "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "job";

// Validate + normalize one job config entry. Throws a human message.
function shape(data, prev = {}) {
  const name = String(data.name ?? prev.name ?? "").trim();
  const description = String(data.description ?? prev.description ?? "").trim();
  const script_path = String(data.script_path ?? prev.script_path ?? "").trim();
  const schedule_cron = String(data.schedule_cron ?? prev.schedule_cron ?? "").trim();
  const webhook_url = String(data.webhook_url ?? prev.webhook_url ?? "").trim();
  if (!name) throw new Error("A job needs a name.");
  if (!script_path) throw new Error("A job needs a script (.sh path).");
  if (schedule_cron) {
    const v = validateCron(schedule_cron);
    if (!v.ok) throw new Error(v.reason);
  }
  if (webhook_url && !/^https?:\/\//i.test(webhook_url)) {
    throw new Error("Webhook URL must start with http:// or https://");
  }
  return {
    id: prev.id,
    created_at: prev.created_at,
    name,
    description,
    script_path,
    schedule_cron,
    webhook_url,
    enabled: data.enabled ?? prev.enabled ?? true
  };
}

// ---- app runtime (only the Electron app calls anything below) ----

let root = null;
let config = [];        // [{id, name, script_path, schedule_cron, enabled, created_at}]
let state = {};         // id -> { last_status, next_run_at, history, ... }
let messages = [];      // [{id, at, from, to, text}] newest first
let notify = () => {};
let onFinished = () => {}; // app hook: macOS notification per finished run
let onNotify = () => {};   // app hook: @notify mention → macOS notification
let timer = null;
let watchers = [];
let ticking = false;
const inflight = new Set();

function arm() {
  const ids = new Set(config.map((j) => j.id));
  for (const id of Object.keys(state)) if (!ids.has(id)) delete state[id];
  for (const job of config) {
    const s = (state[job.id] ||= { last_status: "idle", history: [], run_count: 0 });
    if (!job.enabled || !job.schedule_cron) {
      s.next_run_at = null;
      s.armed_cron = null;
      continue;
    }
    // Re-arm only when the schedule changed (or was never armed). A past
    // next_run_at deliberately survives an app restart: it fires once as a
    // catch-up run, then moves forward.
    if (s.armed_cron !== job.schedule_cron || !s.next_run_at) {
      s.armed_cron = job.schedule_cron;
      try { s.next_run_at = nextFire(job.schedule_cron, new Date()).toISOString(); }
      catch { s.next_run_at = null; }
    }
  }
}

const reloadTimers = {};
function debounced(key, fn) {
  clearTimeout(reloadTimers[key]);
  reloadTimers[key] = setTimeout(fn, 150);
}

async function postMessage(msg) {
  messages = [
    { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: now(), ...msg },
    ...messages
  ].slice(0, MESSAGES);
  await writeJson(P(root).messages, messages);
  notify();
}

// POST a finished run's output to a URL. token may be null (open webhook).
// A token containing a space is a full header ("Basic xyz"); bare = Bearer.
async function deliverWebhook(job, url, token, note, tail, authLabel) {
  const headers = { "content-type": "application/json" };
  if (token) {
    // Accept any paste shape: "abc123", "Bearer abc123", "Authorization: Bearer abc123".
    const t = String(token).replace(/^\s*authorization\s*:\s*/i, "").trim();
    headers.authorization = /\s/.test(t) ? t : `Bearer ${t}`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "elianbot", job: job.name, at: now(), note: note || undefined, output: tail })
    });
    await postMessage({ from: job.name, to: "webhook", kind: "ping", text: `output POSTed to ${url} (${res.status}${authLabel ? `, auth=${authLabel}` : ""})` });
  } catch (err) {
    await postMessage({ from: "elianbot", to: "grok", kind: "ping", text: `${job.name}: webhook POST failed — ${err.message}` });
  }
}

// Scan a finished run's output for @mentions (line-leading only).
async function handleMentions(job, tail, depth) {
  for (const line of tail.split("\n")) {
    const m = line.match(/^\s*@([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/);
    if (!m) continue;
    const target = m[1].toLowerCase();
    const text = m[2].trim();
    if (target === "grok") {
      await postMessage({ from: job.name, to: "grok", text: text || "(no text)" });
      continue;
    }
    if (target === "notify") {
      await postMessage({ from: job.name, to: "user", text: text || "(no text)" });
      try { onNotify(job, text || "Job pinged you."); } catch {}
      continue;
    }
    if (target === "webhook") {
      const words = text.split(/\s+/).filter(Boolean);
      const url = words.shift() || "";
      let authName = null;
      const noteWords = [];
      for (const w of words) {
        const a = w.match(/^auth=([A-Za-z0-9._-]+)$/);
        if (a) authName = a[1]; else noteWords.push(w);
      }
      const note = noteWords.join(" ");
      if (!/^https?:\/\//i.test(url)) {
        await postMessage({ from: "elianbot", to: "grok", kind: "ping", text: `${job.name}: @webhook needs an http(s) URL.` });
        continue;
      }
      let token = null;
      if (authName) {
        const secrets = await readJson(P(root).secrets, {});
        token = secrets[authName];
        if (!token) {
          await postMessage({ from: "elianbot", to: "grok", kind: "ping", text: `${job.name}: webhook skipped — no secret named "${authName}" in secrets.json.` });
          continue;
        }
      }
      await deliverWebhook(job, url, token, note, tail, authName);
      continue;
    }
    const other = config.find(
      (j) => j.id !== job.id && (slug(j.name) === target || j.id === target)
    );
    if (!other) continue;
    if (depth >= MAX_DEPTH) {
      await postMessage({ from: "elianbot", to: "grok", text: `Mention chain stopped at depth ${MAX_DEPTH}: ${job.name} → ${other.name}` });
      continue;
    }
    await postMessage({ from: job.name, to: other.name, text: text || "→ run with my output as input" });
    await fsp.writeFile(
      path.join(P(root).requests, other.id),
      JSON.stringify({ input: tail, depth: depth + 1 })
    );
  }
}

async function execute(job, opts = {}) {
  if (inflight.has(job.id)) return { status: "busy" };
  const s = (state[job.id] ||= { history: [], run_count: 0 });
  const startedAt = now();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const runDir = path.join(P(root).runs, job.id);
  const logPath = path.join(runDir, stamp + ".log");
  await fsp.mkdir(runDir, { recursive: true });

  const env = {
    ...process.env,
    ELIANBOT_DATA: root,
    ELIANBOT_JOB_ID: job.id,
    ELIANBOT_JOB_NAME: job.name,
    ELIANBOT_LOG: logPath
  };
  if (opts.input != null && opts.input !== "") {
    const inputFile = path.join(runDir, stamp + ".input.txt");
    await fsp.writeFile(inputFile, String(opts.input));
    env.ELIANBOT_INPUT_FILE = inputFile;
    env.ELIANBOT_INPUT = String(opts.input).slice(0, INPUT_INLINE);
  }

  inflight.add(job.id);
  s.last_status = "running";
  s.last_run_at = startedAt;
  s.last_log_path = logPath;
  await writeJson(P(root).state, state);
  notify();

  // The entire safety model is this call: script path as ARGV, job values as
  // ENV. No shell ever parses job data.
  const child = spawn("/bin/bash", [job.script_path], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const out = fs.createWriteStream(logPath);
  let tail = "";
  const keep = (b) => { tail = (tail + b.toString("utf8")).slice(-TAIL); };
  child.stdout.on("data", (b) => { out.write(b); keep(b); });
  child.stderr.on("data", (b) => { out.write(b); keep(b); });
  child.on("error", (err) => keep(Buffer.from(`spawn failed: ${err.message}\n`)));

  child.on("close", async (code) => {
    out.end();
    inflight.delete(job.id);
    s.last_status = code === 0 ? "success" : "error";
    s.last_exit_code = code;
    s.last_finished_at = now();
    s.last_output = tail;
    s.run_count = (s.run_count || 0) + 1;
    s.history = [
      { at: startedAt, finished_at: s.last_finished_at, status: s.last_status, exit_code: code, log: logPath },
      ...(s.history || [])
    ].slice(0, HISTORY);
    await writeJson(P(root).state, state);
    notify();
    // Auto-ping: every finished run lands in the feed (Grok reads it with
    // read_messages) and pings the app hook (macOS notification).
    const seconds = Math.max(0, Math.round((Date.parse(s.last_finished_at) - Date.parse(startedAt)) / 1000));
    try {
      await postMessage({
        from: "elianbot",
        to: "grok",
        kind: "ping",
        text: `${job.name}: ${s.last_status}${code !== 0 ? ` (exit ${code})` : ""} in ${seconds}s`
      });
    } catch (err) { console.error("[elianbot] auto-ping failed:", err.message); }
    try { onFinished(job, s.last_status, code); } catch {}
    // Mentions only fire from successful runs — a crashing script shouldn't
    // trigger other jobs with garbage input.
    if (code === 0) {
      try { await handleMentions(job, tail, opts.depth || 0); }
      catch (err) { console.error("[elianbot] mention handling failed:", err.message); }
      // Per-job webhook (set in the app's WEBHOOK panel): deliver the output,
      // with the job's stored secret (secrets.json[job.id]) if there is one.
      if (job.webhook_url) {
        try {
          const secrets = await readJson(P(root).secrets, {});
          await deliverWebhook(job, job.webhook_url, secrets[job.id] || null, "", tail, secrets[job.id] ? "stored" : "");
        } catch (err) { console.error("[elianbot] webhook delivery failed:", err.message); }
      }
    }
  });

  return { status: "started", log: logPath };
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // 1. Run-now requests (from the MCP or an @mention): one file per job id.
    let requests = [];
    try { requests = await fsp.readdir(P(root).requests); } catch {}
    for (const id of requests) {
      const file = path.join(P(root).requests, id);
      let payload = {};
      try { payload = JSON.parse(await fsp.readFile(file, "utf8")) || {}; } catch {}
      await fsp.rm(file, { force: true });
      const job = config.find((j) => j.id === id);
      if (job) await execute(job, { input: payload.input, depth: payload.depth || 0 });
    }
    // 2. Due cron slots. next_run_at is advanced BEFORE the spawn, so a slot
    //    fires exactly once.
    let advanced = false;
    for (const job of config) {
      const s = state[job.id];
      if (!job.enabled || !s || !s.next_run_at) continue;
      if (Date.parse(s.next_run_at) > Date.now()) continue;
      s.next_run_at = nextFire(job.schedule_cron, new Date()).toISOString();
      advanced = true;
      await execute(job);
    }
    if (advanced) await writeJson(P(root).state, state);
  } finally {
    ticking = false;
  }
}

async function boot(onChange, onRunFinished, onUserNotify) {
  root = dataRoot();
  notify = onChange || notify;
  onFinished = onRunFinished || onFinished;
  onNotify = onUserNotify || onNotify;
  const p = P(root);
  for (const dir of [root, p.runs, p.requests, p.scripts]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  config = await readJson(p.config, []);
  state = await readJson(p.state, {});
  messages = await readJson(p.messages, []);
  // An empty secrets.json template, so the user knows where tokens go.
  if ((await readJson(p.secrets, null)) === null) await writeJson(p.secrets, {});
  await reloadSecretNames();
  // A crash can leave "running" behind; this process is the only runner.
  for (const s of Object.values(state)) if (s.last_status === "running") s.last_status = "error";
  arm();
  await writeJson(p.state, state);
  try {
    watchers.push(fs.watch(root, (_e, f) => {
      if (f === "jobs.json") debounced("config", async () => {
        config = await readJson(p.config, []);
        arm();
        await writeJson(p.state, state);
        notify();
      });
      if (f === "messages.json") debounced("messages", async () => {
        messages = await readJson(p.messages, []);
        notify();
      });
      if (f === "secrets.json") debounced("secrets", async () => {
        await reloadSecretNames();
        notify();
      });
    }));
    watchers.push(fs.watch(p.requests, () => tick().catch(console.error)));
  } catch {}
  timer = setInterval(() => tick().catch(console.error), 1000);
  return { root };
}

function snapshot() {
  return config.map((j) => ({
    ...j,
    ...(state[j.id] || {}),
    running: inflight.has(j.id),
    has_secret: secretNames.has(j.id)
  }));
}

// The UI only ever learns WHICH jobs have a stored secret — never the value.
let secretNames = new Set();
async function reloadSecretNames() {
  secretNames = new Set(Object.keys(await readJson(P(root).secrets, {})));
}

// Store/replace (or clear with "") a job's Authorization value. Write-only
// from the UI's point of view: nothing ever reads it back out.
async function setSecret(id, value) {
  const secrets = await readJson(P(root).secrets, {});
  if (String(value || "") === "") delete secrets[id];
  else secrets[id] = String(value);
  await writeJson(P(root).secrets, secrets);
  await reloadSecretNames();
  notify();
}

function getMessages() {
  return messages;
}

// Every scheduled fire in the next `days`, for the calendar.
function upcoming(days = 45) {
  const end = Date.now() + days * 86400e3;
  const out = [];
  for (const job of config) {
    if (!job.enabled || !job.schedule_cron) continue;
    let t = new Date();
    for (let n = 0; n < 200; n++) {
      let next;
      try { next = nextFire(job.schedule_cron, t); } catch { break; }
      if (next.getTime() > end) break;
      out.push({ job_id: job.id, name: job.name, at: next.toISOString() });
      t = next;
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 1000);
}

// Read a log/input file — only from inside the data root.
async function readLog(file) {
  const resolved = path.resolve(String(file || ""));
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error("Refused: not an ElianBot file.");
  }
  const text = await fsp.readFile(resolved, "utf8");
  return text.slice(-16384);
}

async function persist() {
  await writeJson(P(root).config, config);
  arm();
  await writeJson(P(root).state, state);
  notify();
}

async function create(data) {
  const id = `${slug(data.name)}-${Date.now().toString(36)}`;
  const job = shape(data, { id, created_at: now() });
  config.push(job);
  await persist();
  return snapshot().find((j) => j.id === id);
}

async function update(id, data) {
  const i = config.findIndex((j) => j.id === id);
  if (i < 0) throw new Error("Job not found.");
  config[i] = shape(data, config[i]);
  await persist();
  return snapshot().find((j) => j.id === id);
}

async function toggle(id) {
  const job = config.find((j) => j.id === id);
  if (!job) throw new Error("Job not found.");
  return update(id, { enabled: !job.enabled });
}

async function remove(id) {
  config = config.filter((j) => j.id !== id);
  await persist();
}

async function runNow(id, input) {
  const job = config.find((j) => j.id === id);
  if (!job) throw new Error("Job not found.");
  return execute(job, { input, depth: 0 });
}

async function shutdown() {
  clearInterval(timer);
  for (const key of Object.keys(reloadTimers)) clearTimeout(reloadTimers[key]);
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];
}

// Move the whole data folder somewhere else (user picks a directory in the
// UI). Stops the engine, moves every entry, fixes absolute log paths inside
// state.json, remembers the choice in settings.json, boots again.
async function relocate(newRoot) {
  newRoot = path.resolve(String(newRoot || "").trim());
  const oldRoot = path.resolve(root);
  if (!newRoot || newRoot === oldRoot) return { root };
  if ((newRoot + path.sep).startsWith(oldRoot + path.sep)) {
    throw new Error("Pick a folder outside the current data folder.");
  }
  await shutdown();
  await fsp.mkdir(newRoot, { recursive: true });
  let entries = [];
  try { entries = await fsp.readdir(oldRoot); } catch {}
  for (const name of entries) {
    const from = path.join(oldRoot, name);
    const to = path.join(newRoot, name);
    try { await fsp.rename(from, to); }
    catch {
      await fsp.cp(from, to, { recursive: true, force: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
  }
  try { await fsp.rmdir(oldRoot); } catch {}
  // History entries carry absolute log paths — point them at the new home.
  try {
    const stateFile = path.join(newRoot, "state.json");
    const text = await fsp.readFile(stateFile, "utf8");
    await fsp.writeFile(stateFile, text.split(oldRoot).join(newRoot));
  } catch {}
  await writeJson(SETTINGS, { data_root: newRoot });
  return boot(notify, onFinished, onNotify);
}

module.exports = {
  dataRoot, P, readJson, writeJson, shape, slug, now,      // shared with mcp.js
  boot, snapshot, create, update, toggle, remove, runNow, shutdown, relocate,
  getMessages, postMessage, upcoming, readLog, setSecret
};
