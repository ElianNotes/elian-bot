const $ = (s) => document.querySelector(s);
let state = { jobs: [], root: "" };
let selected = null;

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const stateLine = (j) =>
  !j.enabled ? "Paused" : j.schedule_cron ? `Next: ${when(j.next_run_at)}` : "Manual only";

function render() {
  const jobs = state.jobs || [];
  $("#root-path").textContent = state.root || "";
  $("#job-count").textContent = `${jobs.length}`;
  $("#job-list").innerHTML = jobs.length
    ? jobs.map((j) => `
      <button class="job ${selected === j.id ? "selected" : ""}" data-id="${j.id}">
        <span class="dot ${j.running ? "running" : j.last_status || "idle"}"></span>
        <span class="job-text">
          <b>${escapeHtml(j.name)}</b>
          <small>${escapeHtml(stateLine(j))}</small>
        </span>
        ${j.enabled ? "" : '<span class="chip">PAUSED</span>'}
      </button>`).join("")
    : '<div class="list-empty">No jobs yet.<br /><br />Create one, or let Grok create one over MCP.</div>';
  document.querySelectorAll(".job").forEach((el) => {
    el.onclick = () => { selected = el.dataset.id; render(); };
  });
  renderDetail(jobs.find((j) => j.id === selected));
}

function renderDetail(j) {
  const el = $("#detail");
  if (!j) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-mark">⏱</div>
        <h2>Select a job</h2>
        <p>One job = one .sh file on disk, run by code — on a schedule or on click.</p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <p class="eyebrow ${j.running ? "running" : j.last_status || ""}">${j.running ? "RUNNING" : (j.last_status || "idle").toUpperCase()}</p>
    <h2>${escapeHtml(j.name)}</h2>
    ${j.description ? `<p class="desc">${escapeHtml(j.description)}</p>` : ""}
    <p class="path" title="Reveal in Finder">${escapeHtml(j.script_path)}</p>
    <div class="actions">
      <button class="primary" data-act="run" ${j.running ? "disabled" : ""}>${j.running ? "Running…" : "▶ Run now"}</button>
      <button class="secondary" data-act="toggle">${j.enabled ? "Pause" : "Resume"}</button>
      <button class="secondary" data-act="edit">Edit</button>
      <button class="danger" data-act="delete">Delete</button>
    </div>
    <div class="facts">
      <div><span>Schedule</span><b>${escapeHtml(j.schedule_cron || "Manual")}</b></div>
      <div><span>Next run</span><b>${escapeHtml(when(j.next_run_at))}</b></div>
      <div><span>Last run</span><b>${escapeHtml(when(j.last_run_at))}</b></div>
      <div><span>Runs</span><b>${j.run_count || 0}${j.last_exit_code != null ? ` · exit ${j.last_exit_code}` : ""}</b></div>
    </div>
    <div class="webhook">
      <div class="section-head"><span>WEBHOOK — push output when this job finishes</span>${j.webhook_url ? '<span class="wh-on">ON</span>' : ""}</div>
      <div class="wh-grid">
        <input id="wh-url" placeholder="Webhook URL — https://…" autocomplete="off"
               value="${escapeHtml(j.webhook_url || "")}" />
        <input id="wh-secret" type="password" autocomplete="new-password"
               placeholder="${j.has_secret ? "Authorization stored ✓ — paste to replace, save empty to keep" : "Authorization header value (kept in secrets.json, never shown)"}" />
        <button id="wh-save" class="secondary">Save</button>
        ${j.has_secret ? '<button id="wh-clear" class="danger">Clear secret</button>' : ""}
      </div>
      <small class="wh-hint">The URL is plain config. The Authorization value is written straight into
        <b>secrets.json</b> on this Mac — it never shows in the app, output, feed, or git.</small>
    </div>
    <div class="output">
      <div class="section-head"><span>LATEST OUTPUT</span>${j.last_log_path ? '<button class="linkish" data-act="reveal">Reveal log ↗</button>' : ""}</div>
      <pre>${escapeHtml(j.last_output || "No output yet.")}</pre>
    </div>`;
  el.querySelector("#wh-save").onclick = async () => {
    try {
      const url = el.querySelector("#wh-url").value.trim();
      const secret = el.querySelector("#wh-secret").value;
      await window.elianBot.update(j.id, { webhook_url: url });
      if (secret !== "") await window.elianBot.setSecret(j.id, secret);
      await refresh();
    } catch (err) { alert(err.message || String(err)); }
  };
  const whClear = el.querySelector("#wh-clear");
  if (whClear) whClear.onclick = async () => {
    if (confirm("Remove the stored Authorization value for this job?")) {
      await window.elianBot.setSecret(j.id, "");
      await refresh();
    }
  };
  el.querySelector('[data-act="run"]').onclick = () => window.elianBot.run(j.id);
  el.querySelector('[data-act="toggle"]').onclick = () => window.elianBot.toggle(j.id);
  el.querySelector('[data-act="edit"]').onclick = () => openDialog(j);
  el.querySelector('[data-act="delete"]').onclick = async () => {
    if (confirm(`Delete "${j.name}"? The .sh file itself stays on disk.`)) {
      await window.elianBot.remove(j.id);
      selected = null;
    }
  };
  el.querySelector(".path").onclick = () => window.elianBot.reveal(j.script_path);
  const reveal = el.querySelector('[data-act="reveal"]');
  if (reveal) reveal.onclick = () => window.elianBot.reveal(j.last_log_path);
}

function openDialog(j) {
  const form = $("#job-form");
  form.reset();
  form.dataset.id = j ? j.id : "";
  $("#dialog-title").textContent = j ? "Edit job" : "New job";
  if (j) for (const k of ["name", "description", "script_path", "schedule_cron"]) form.elements[k].value = j[k] || "";
  pickerFromCron((j && j.schedule_cron) || "");
  updateCronHint();
  $("#job-dialog").showModal();
}

// ---- the schedule builder: dropdowns in, cron out ----
const S = {
  repeat: () => $("#sched-repeat"),
  every: () => $("#sched-every"),
  day: () => $("#sched-day"),
  date: () => $("#sched-date"),
  at: () => $("#sched-at"),
  hourWrap: () => $("#sched-hour-wrap"),
  hour: () => $("#sched-hour"),
  min: () => $("#sched-min")
};

// fill hour 00–23, minute 00–55 (5 steps), date 1–28
(() => {
  S.hour().innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}</option>`).join("");
  S.min().innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i * 5}">${String(i * 5).padStart(2, "0")}</option>`).join("");
  S.date().innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">on day ${i + 1}</option>`).join("");
})();

function pickerLayout() {
  const r = S.repeat().value;
  S.every().hidden = r !== "minutes";
  S.day().hidden = r !== "weekly";
  S.date().hidden = r !== "monthly";
  S.at().hidden = !["hourly", "daily", "weekdays", "weekends", "weekly", "monthly"].includes(r);
  S.hourWrap().style.display = r === "hourly" ? "none" : "";
}

function cronFromPicker() {
  const r = S.repeat().value;
  const m = S.min().value, h = S.hour().value;
  switch (r) {
    case "manual":   return "";
    case "minutes":  return `*/${S.every().value} * * * *`;
    case "hourly":   return `${m} * * * *`;
    case "daily":    return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekends": return `${m} ${h} * * 0,6`;
    case "weekly":   return `${m} ${h} * * ${S.day().value}`;
    case "monthly":  return `${m} ${h} ${S.date().value} * *`;
    default:         return $("#job-form").elements.schedule_cron.value.trim();
  }
}

// reverse: recognize a cron and preset the dropdowns (else "custom")
function pickerFromCron(expr) {
  const set = (r) => { S.repeat().value = r; pickerLayout(); };
  const setTime = (m, h) => { S.min().value = String(+m - (+m % 5)); if (h !== undefined) S.hour().value = String(+h); };
  if (!expr) return set("manual");
  const f = expr.split(/\s+/);
  let m2;
  if (f.length === 5) {
    const [m, h, dom, mon, dow] = f;
    const num = (s) => /^\d+$/.test(s);
    if ((m2 = m.match(/^\*\/(\d+)$/)) && h === "*" && dom === "*" && dow === "*") {
      set("minutes");
      if ([...S.every().options].some((o) => o.value === m2[1])) S.every().value = m2[1];
      return;
    }
    if (num(m) && h === "*" && dom === "*" && dow === "*") { set("hourly"); return setTime(m); }
    if (num(m) && num(h) && dom === "*" && mon === "*") {
      if (dow === "*") { set("daily"); return setTime(m, h); }
      if (dow === "1-5") { set("weekdays"); return setTime(m, h); }
      if (dow === "0,6" || dow === "6,0") { set("weekends"); return setTime(m, h); }
      if (num(dow)) { set("weekly"); S.day().value = String(+dow % 7); return setTime(m, h); }
    }
    if (num(m) && num(h) && num(dom) && +dom <= 28 && mon === "*" && dow === "*") {
      set("monthly"); S.date().value = dom; return setTime(m, h);
    }
  }
  set("custom");
}

function onPickerChange() {
  pickerLayout();
  if (S.repeat().value !== "custom") {
    $("#job-form").elements.schedule_cron.value = cronFromPicker();
  }
  updateCronHint();
}
for (const el of [S.repeat(), S.every(), S.day(), S.date(), S.hour(), S.min()]) {
  el.addEventListener("change", onPickerChange);
}

// ---- cron → plain words + a clock, for people who don't speak cron ----
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CLOCKS = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"];

function humanizeCron(expr) {
  const f = expr.split(/\s+/);
  if (f.length !== 5) return "custom schedule";
  const [m, h, dom, mon, dow] = f;
  const pad = (x) => String(x).padStart(2, "0");
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${pad(h)}:${pad(m)}` : null;
  const everyN = (s) => { const mm = s.match(/^\*\/(\d+)$/); return mm ? +mm[1] : null; };
  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "every minute";
  if (everyN(m) && h === "*" && dom === "*" && dow === "*") return `every ${everyN(m)} minutes`;
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && dow === "*") return `every hour at :${pad(m)}`;
  if (everyN(h) && /^\d+$/.test(m) && dom === "*" && dow === "*") return `every ${everyN(h)} hours at :${pad(m)}`;
  if (time && dom === "*" && mon === "*") {
    if (dow === "*") return `every day at ${time}`;
    if (dow === "1-5") return `weekdays at ${time}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6,7") return `weekends at ${time}`;
    if (/^\d+$/.test(dow)) return `every ${DAY_NAMES[+dow % 7]} at ${time}`;
    if (/^[\d,]+$/.test(dow)) return `${dow.split(",").map((d) => DAY_NAMES[+d % 7]).join(", ")} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `monthly on day ${dom} at ${time}`;
  return "custom schedule";
}

async function updateCronHint() {
  const el = $("#cron-hint");
  const expr = $("#job-form").elements.schedule_cron.value.trim();
  el.classList.remove("bad");
  if (!expr) { el.textContent = "Manual only — fires when you press ▶ Run now"; return; }
  try {
    const info = await window.elianBot.cronInfo(expr);
    if (!info.ok) { el.classList.add("bad"); el.textContent = `✕ ${info.reason}`; return; }
    const next = new Date(info.next[0]);
    const clock = CLOCKS[next.getHours() % 12];
    el.textContent = `${clock} ${humanizeCron(expr)} — next: ${next.toLocaleString([], { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  } catch { el.textContent = "minute · hour · day · month · weekday"; }
}

let activeTab = "jobs";

function setTab(tab) {
  activeTab = tab;
  document.querySelector("#jobs-main").hidden = tab !== "jobs";
  document.querySelector("#dash-main").hidden = tab !== "dash";
  document.querySelector("#tab-jobs").classList.toggle("active", tab === "jobs");
  document.querySelector("#tab-dash").classList.toggle("active", tab === "dash");
  refresh();
}

async function refresh() {
  state = await window.elianBot.state();
  if (activeTab === "dash") await window.elianBotDashboard.refresh(state);
  else render();
}

$("#tab-jobs").onclick = () => setTab("jobs");
$("#tab-dash").onclick = () => setTab("dash");

$("#root-path").onclick = async () => {
  try {
    const root = await window.elianBot.changeRoot();
    if (root) await refresh();
  } catch (err) {
    alert(err.message || String(err));
  }
};

$("#help").onclick = () => $("#help-dialog").showModal();
$(".help-close").onclick = () => $("#help-dialog").close();

$("#new-job").onclick = () => openDialog(null);
$("#job-dialog .close").onclick = () => $("#job-dialog").close();
$("#job-dialog .cancel").onclick = () => $("#job-dialog").close();
$("#browse-script").onclick = async () => {
  const file = await window.elianBot.pickScript();
  if (file) $("#job-form").elements.script_path.value = file;
};
$("#reveal-script").onclick = () => {
  const p = $("#job-form").elements.script_path.value.trim();
  if (p) window.elianBot.reveal(p);
};
$("#job-form").elements.schedule_cron.addEventListener("input", () => {
  // hand-editing the cron flips the picker to Custom (the cron always wins)
  S.repeat().value = "custom";
  pickerLayout();
  updateCronHint();
});
$("#job-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  delete data.description; // locked: only the MCP (Grok) writes it
  try {
    const job = form.dataset.id
      ? await window.elianBot.update(form.dataset.id, data)
      : await window.elianBot.create(data);
    selected = job.id;
    $("#job-dialog").close();
    await refresh();
  } catch (err) {
    alert(err.message || String(err));
  }
};

window.elianBot.onChanged(refresh);
refresh();
