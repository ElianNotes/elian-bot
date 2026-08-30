// test.js — headless engine test. No Electron needed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const TMP = path.join(__dirname, ".test-data");
process.env.ELIANBOT_DATA = TMP;

const engine = require("./engine");
const { validateCron } = require("./cron");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await engine.boot();

  // cron sanity
  assert.equal(validateCron("0 8 * * *").ok, true);
  assert.equal(validateCron("nonsense").ok, false);
  assert.equal(validateCron("0 0 30 2 *").neverFires, true);

  // a real script that echoes and reads its env
  const script = path.join(TMP, "hello.sh");
  await fs.writeFile(script, "#!/bin/bash\necho \"hello from $ELIANBOT_JOB_NAME\"\n", { mode: 0o755 });

  // a malicious name is DATA (env), never shell source
  const evil = "x'; echo PWNED > /tmp/elianbot-pwned; '";
  const job = await engine.create({ name: evil, script_path: script, schedule_cron: "0 8 * * *" });
  assert.ok(job.id);
  assert.match(job.next_run_at, /^\d{4}-/);

  await engine.runNow(job.id);
  await wait(400);
  const done = engine.snapshot().find((j) => j.id === job.id);
  assert.equal(done.last_status, "success");
  assert.equal(done.last_exit_code, 0);
  assert.ok(done.last_output.includes(`hello from ${evil}`), "env value arrived verbatim as data");
  let pwned = true;
  try { await fs.access("/tmp/elianbot-pwned"); } catch { pwned = false; }
  assert.equal(pwned, false, "injection attempt must not execute");

  // failure is reported, not hidden
  const bad = path.join(TMP, "bad.sh");
  await fs.writeFile(bad, "#!/bin/bash\necho boom >&2\nexit 3\n", { mode: 0o755 });
  const failing = await engine.create({ name: "Fails", script_path: bad });
  await engine.runNow(failing.id);
  await wait(400);
  const failed = engine.snapshot().find((j) => j.id === failing.id);
  assert.equal(failed.last_status, "error");
  assert.equal(failed.last_exit_code, 3);
  assert.ok(failed.last_output.includes("boom"));

  // pause / resume / delete
  const paused = await engine.toggle(job.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.next_run_at, null);
  const resumed = await engine.toggle(job.id);
  assert.equal(resumed.enabled, true);
  await engine.remove(failing.id);
  assert.equal(engine.snapshot().find((j) => j.id === failing.id), undefined);

  // description (the creating prompt) persists through create + update
  const descJob = await engine.create({
    name: "Described",
    script_path: script,
    description: "make me a job that says hello every morning"
  });
  assert.equal(descJob.description, "make me a job that says hello every morning");
  const descJob2 = await engine.update(descJob.id, { description: "changed prompt" });
  assert.equal(descJob2.description, "changed prompt");
  assert.equal(descJob2.name, "Described", "update keeps untouched fields");
  await engine.remove(descJob.id);

  // validation refuses garbage
  await assert.rejects(() => engine.create({ name: "", script_path: script }), /needs a name/);
  await assert.rejects(() => engine.create({ name: "x", script_path: script, schedule_cron: "bad" }), /expected 5 fields/);

  // ---- @mentions: talk back and forth ----
  const receiverScript = path.join(TMP, "receiver.sh");
  await fs.writeFile(receiverScript, "#!/bin/bash\necho \"got: $ELIANBOT_INPUT\"\n", { mode: 0o755 });
  const receiver = await engine.create({ name: "Receiver", script_path: receiverScript });

  const senderScript = path.join(TMP, "sender.sh");
  await fs.writeFile(
    senderScript,
    "#!/bin/bash\necho \"data-123\"\necho \"@grok sender says hi\"\necho \"@receiver take this\"\n",
    { mode: 0o755 }
  );
  const sender = await engine.create({ name: "Sender", script_path: senderScript });

  await engine.runNow(sender.id);
  await wait(2500); // sender finishes → mention queues receiver → receiver runs

  const receiverDone = engine.snapshot().find((j) => j.id === receiver.id);
  assert.equal(receiverDone.last_status, "success", "mentioned job ran");
  assert.ok(receiverDone.last_output.includes("data-123"), "receiver got sender output as $ELIANBOT_INPUT");

  const msgs = engine.getMessages();
  assert.ok(msgs.some((m) => m.to === "grok" && m.text.includes("sender says hi")), "@grok mention posted");
  assert.ok(msgs.some((m) => m.from === "Sender" && m.to === "Receiver"), "job→job handoff posted");
  assert.ok(msgs.some((m) => m.kind === "ping" && m.text.startsWith("Sender: success")), "auto-ping for sender");
  assert.ok(msgs.some((m) => m.kind === "ping" && m.text.startsWith("Receiver: success")), "auto-ping for receiver");

  // run with direct input (the Grok run_job path)
  await engine.runNow(receiver.id, "direct-input");
  await wait(400);
  assert.ok(
    engine.snapshot().find((j) => j.id === receiver.id).last_output.includes("got: direct-input"),
    "runNow input reaches the job"
  );

  // ---- @webhook: output leaves the machine to any app, with auth ----
  const http = require("node:http");
  let hookPayload = null;
  let hookAuth = null;
  const hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => { hookPayload = JSON.parse(body); hookAuth = req.headers.authorization || null; res.end("ok"); });
  });
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  const hookPort = hookServer.address().port;

  await fs.writeFile(path.join(TMP, "secrets.json"), JSON.stringify({ grok: "test-token-123" }));

  const hookScript = path.join(TMP, "hook.sh");
  await fs.writeFile(
    hookScript,
    `#!/bin/bash\necho "payload-xyz"\necho "@webhook http://127.0.0.1:${hookPort}/in auth=grok daily brief"\necho "@notify check the tape"\n`,
    { mode: 0o755 }
  );
  const hookJob = await engine.create({ name: "Hook", script_path: hookScript });
  await engine.runNow(hookJob.id);
  await wait(1500);

  assert.ok(hookPayload, "webhook received a POST");
  assert.equal(hookPayload.job, "Hook");
  assert.equal(hookPayload.note, "daily brief");
  assert.equal(hookAuth, "Bearer test-token-123", "Authorization header attached from secrets.json");
  assert.ok(!JSON.stringify(engine.getMessages()).includes("test-token-123"), "token never leaks into the feed");
  assert.ok(hookPayload.output.includes("payload-xyz"), "webhook payload carries the output");
  const msgs2 = engine.getMessages();
  assert.ok(msgs2.some((m) => m.to === "webhook" && m.text.includes("200") && m.text.includes("auth=grok")), "webhook delivery logged with auth name");
  assert.ok(msgs2.some((m) => m.to === "user" && m.text === "check the tape"), "@notify posted to feed");

  // without auth= → NO Authorization header
  hookPayload = null;
  hookAuth = "sentinel";
  const openScript = path.join(TMP, "hook-open.sh");
  await fs.writeFile(
    openScript,
    `#!/bin/bash\necho "open-post"\necho "@webhook http://127.0.0.1:${hookPort}/in plain note"\n`,
    { mode: 0o755 }
  );
  const openJob = await engine.create({ name: "Hook Open", script_path: openScript });
  await engine.runNow(openJob.id);
  await wait(1500);

  assert.ok(hookPayload && hookPayload.job === "Hook Open", "no-auth webhook received");
  assert.equal(hookAuth, null, "no Authorization header without auth=");

  // ---- per-job webhook (the app's WEBHOOK panel) ----
  hookPayload = null;
  hookAuth = null;
  const whJob = await engine.create({
    name: "Panel Hook",
    script_path: openScript,
    webhook_url: `http://127.0.0.1:${hookPort}/in`
  });
  // pasted the FULL header line, as GrokBot shows it — must normalize
  await engine.setSecret(whJob.id, "Authorization: Bearer panel-token-9");
  assert.ok(engine.snapshot().find((j) => j.id === whJob.id).has_secret, "has_secret flag set");
  await engine.runNow(whJob.id);
  await wait(1500);
  hookServer.close();

  assert.ok(hookPayload && hookPayload.job === "Panel Hook", "per-job webhook fired on finish");
  assert.equal(hookAuth, "Bearer panel-token-9", "pasted header line normalized to a clean Bearer header");
  assert.ok(!JSON.stringify(engine.getMessages()).includes("panel-token-9"), "panel secret never in the feed");
  await assert.rejects(
    () => engine.create({ name: "bad", script_path: openScript, webhook_url: "ftp://nope" }),
    /http/, "webhook_url must be http(s)"
  );

  // ---- upcoming fires for the calendar ----
  const fires = engine.upcoming(45);
  assert.ok(fires.length >= 30, "daily 08:00 job yields ~45 upcoming fires");
  assert.ok(fires.every((f) => f.at && f.name), "each fire has a time and a name");
  const sorted = [...fires].sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(fires, sorted, "upcoming is sorted");

  await engine.shutdown();
  await fs.rm(TMP, { recursive: true, force: true });
  console.log("elianbot: all checks passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
