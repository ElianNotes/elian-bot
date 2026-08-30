#!/usr/bin/env node
// mcp.js — Grok Bot's full-control interface to ElianBot. Data in, data out.
//
// It edits jobs.json directly (the app picks changes up within a second) and
// drops a file into requests/ to ask for a run NOW. It never spawns a job
// itself — the app is the only runner ("one brain").
//
// Safety model:
//   * Scripts written by the AI land in the ElianBot scripts/ folder with a
//     unique name — an existing file is never overwritten.
//   * delete_job requires confirm:true and never deletes script files.
//   * Everything else is plain data editing, atomic, and visible in the app.

const path = require("node:path");
const fsp = require("node:fs/promises");
const { makeServer } = require("./protocol");
const { dataRoot, P, readJson, writeJson, shape, slug, now } = require("./engine");

// Resolve the data folder on EVERY call — the user can move it from the app's
// UI (settings.json), and a long-running connector must follow the move.
const p = () => P(dataRoot());

const readConfig = () => readJson(p().config, []);
const readState = () => readJson(p().state, {});
const readMessages = () => readJson(p().messages, []);

const MESSAGES = 300;
async function appendMessage(msg) {
  const list = [
    { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: now(), ...msg },
    ...(await readMessages())
  ].slice(0, MESSAGES);
  await writeJson(p().messages, list);
  return list[0];
}

function view(job, state) {
  const s = state[job.id] || {};
  return {
    id: job.id,
    name: job.name,
    description: job.description || "",
    script_path: job.script_path,
    schedule_cron: job.schedule_cron || null,
    webhook_url: job.webhook_url || null,
    enabled: job.enabled !== false,
    last_status: s.last_status || "idle",
    last_run_at: s.last_run_at || null,
    last_exit_code: s.last_exit_code ?? null,
    next_run_at: s.next_run_at || null,
    run_count: s.run_count || 0
  };
}

async function requireJob(id) {
  const config = await readConfig();
  const job = config.find((j) => j.id === String(id || "").trim());
  if (!job) throw new Error(`No job with id "${id}". Use list_jobs.`);
  return { config, job };
}

// If Grok sends script_content, write it as a NEW file (never overwrite).
async function materializeScript(args) {
  if (!args.script_content) return args;
  await fsp.mkdir(p().scripts, { recursive: true });
  const file = path.join(p().scripts, `${slug(args.name || "job")}-${Date.now().toString(36)}.sh`);
  await fsp.writeFile(file, String(args.script_content), { mode: 0o755, flag: "wx" });
  return { ...args, script_path: file };
}

const tools = [
  {
    name: "list_jobs",
    description: "List every ElianBot job with status, schedule, and next run.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const [config, state] = [await readConfig(), await readState()];
      return config.length ? config.map((j) => view(j, state)) : "No jobs yet.";
    }
  },
  {
    name: "get_job",
    description: "Full detail of one job, including its recent run history and last output.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job id from list_jobs." } },
      required: ["id"]
    },
    handler: async (args) => {
      const { job } = await requireJob(args.id);
      const state = await readState();
      const s = state[job.id] || {};
      return { ...view(job, state), history: s.history || [], last_output: s.last_output || "", last_log_path: s.last_log_path || null };
    }
  },
  {
    name: "create_job",
    description: "Create a job. ALWAYS set description to the user's original prompt verbatim — it is shown in the app as the job's description. Give script_path (an existing .sh) OR script_content (ElianBot saves it as a new .sh in its scripts folder). schedule_cron is optional 5-field cron; omit it for a manual-only job. webhook_url (optional) makes every successful run POST {source, job, at, output} to that URL; the user attaches an Authorization secret to it in the app's WEBHOOK panel (never ask for or handle the token yourself). Output routing — a script line starting with: \"@grok <text>\" posts to the feed for you; \"@<job-slug>\" runs that job with this output as $ELIANBOT_INPUT; \"@notify <text>\" fires a macOS notification; \"@webhook <url> [auth=<name>]\" POSTs the output as JSON, auth=<name> using a named token from the user's local secrets.json (refer to tokens only by name).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string", description: "The user's original prompt that asked for this job, verbatim. A read-only record shown in the app — it is NEVER executed and has no effect on runs; only the script runs." },
        script_path: { type: "string", description: "Absolute path to an existing .sh file." },
        script_content: { type: "string", description: "Full bash script body; saved as a new file, never overwrites." },
        schedule_cron: { type: "string", description: "e.g. \"0 8 * * *\" (min hour day month weekday)." },
        webhook_url: { type: "string", description: "Optional http(s) URL — every successful run POSTs its output there." },
        enabled: { type: "boolean" }
      },
      required: ["name"]
    },
    handler: async (args) => {
      const data = await materializeScript(args);
      const config = await readConfig();
      const id = `${slug(data.name)}-${Date.now().toString(36)}`;
      const job = shape(data, { id, created_at: now() });
      config.push(job);
      await writeJson(p().config, config);
      return { created: job, note: "The app arms it within a second while ElianBot is open." };
    }
  },
  {
    name: "update_job",
    description: "Edit a job's name, description, script, schedule, or webhook. script_content writes a NEW script file and points the job at it (the old file stays on disk). Keep description = the prompt that defines the job; update it if the user's ask changes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string", description: "The prompt that defines this job, verbatim. Informational record only — never executed." },
        script_path: { type: "string" },
        script_content: { type: "string" },
        schedule_cron: { type: "string", description: "New cron, or \"\" to make the job manual-only." },
        webhook_url: { type: "string", description: "http(s) URL to POST output to on success, or \"\" to turn it off." },
        enabled: { type: "boolean" }
      },
      required: ["id"]
    },
    handler: async (args) => {
      const { config, job } = await requireJob(args.id);
      const data = await materializeScript({ ...args, name: args.name || job.name });
      config[config.indexOf(job)] = shape(data, job);
      await writeJson(p().config, config);
      return { updated: config.find((j) => j.id === job.id) };
    }
  },
  {
    name: "run_job",
    description: "Run a job now, optionally handing it input (the job reads $ELIANBOT_INPUT / $ELIANBOT_INPUT_FILE). Queues a run request; the ElianBot app executes it within a second (the app must be open). Every finished run auto-pings the feed — check read_messages or get_job for the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        input: { type: "string", description: "Optional text handed to the job as $ELIANBOT_INPUT." }
      },
      required: ["id"]
    },
    handler: async (args) => {
      const { job } = await requireJob(args.id);
      await fsp.mkdir(p().requests, { recursive: true });
      await fsp.writeFile(
        path.join(p().requests, job.id),
        JSON.stringify({ input: args.input || undefined, depth: 0 })
      );
      return `Run queued for "${job.name}". The app fires it within ~1s while open; read_messages shows the auto-ping when it finishes.`;
    }
  },
  {
    name: "read_messages",
    description: "Read the ElianBot message feed, newest first: auto-pings for every finished run, @grok mentions printed by jobs, and job→job handoffs. Use kind=\"ping\" entries for run outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default 30)." },
        since: { type: "string", description: "ISO timestamp — only messages after this." }
      }
    },
    handler: async (args) => {
      let list = await readMessages();
      if (args.since) list = list.filter((m) => m.at > args.since);
      list = list.slice(0, Math.max(1, Math.min(200, args.limit || 30)));
      return list.length ? list : "No messages.";
    }
  },
  {
    name: "send_message",
    description: "Post a message to the ElianBot feed (shows in the app's Dashboard). Use it to leave status notes or answer a job's @grok mention.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        to: { type: "string", description: "Optional recipient label (default \"user\")." }
      },
      required: ["text"]
    },
    handler: async (args) => {
      const msg = await appendMessage({ from: "grok", to: args.to || "user", text: String(args.text) });
      return { posted: msg };
    }
  },
  {
    name: "pause_job",
    description: "Pause a job (it keeps its config but never fires).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args) => {
      const { config, job } = await requireJob(args.id);
      job.enabled = false;
      await writeJson(p().config, config);
      return `Paused "${job.name}".`;
    }
  },
  {
    name: "resume_job",
    description: "Resume a paused job.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args) => {
      const { config, job } = await requireJob(args.id);
      job.enabled = true;
      await writeJson(p().config, config);
      return `Resumed "${job.name}".`;
    }
  },
  {
    name: "get_output",
    description: "Read the tail of a job's latest log file (up to 8 KB).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args) => {
      const { job } = await requireJob(args.id);
      const s = (await readState())[job.id] || {};
      if (!s.last_log_path) return "No runs yet.";
      try {
        const text = await fsp.readFile(s.last_log_path, "utf8");
        return text.slice(-8192) || "(empty log)";
      } catch {
        return `Log file missing: ${s.last_log_path}`;
      }
    }
  },
  {
    name: "delete_job",
    description: "Delete a job from ElianBot. DESTRUCTIVE: requires confirm:true. Script files on disk are never deleted.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirm: { type: "boolean", description: "Must be true." }
      },
      required: ["id", "confirm"]
    },
    handler: async (args) => {
      if (args.confirm !== true) throw new Error("Refused: pass confirm:true to delete.");
      const { config, job } = await requireJob(args.id);
      await writeJson(p().config, config.filter((j) => j.id !== job.id));
      return `Deleted "${job.name}". Its script file stays on disk.`;
    }
  }
];

makeServer({ name: "elianbot", version: "0.1.0", tools }).listen();
