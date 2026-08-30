// dashboard.js — the interactive calendar + message feed.
// Past runs come from each job's history; future marks are computed from the
// crons by the engine (upcoming). Click a day → its timeline; click a run →
// its log. No framework, no state beyond the viewed month + selected day.

(() => {
  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  let view = new Date();          // month being shown
  let selectedDay = dayKey(new Date());
  let cache = { jobs: [], upcoming: [], messages: [] };

  function collectByDay() {
    const byDay = {};
    const bucket = (key) => (byDay[key] ||= { past: [], planned: [] });
    for (const job of cache.jobs) {
      for (const run of job.history || []) {
        bucket(dayKey(new Date(run.at))).past.push({ ...run, name: job.name });
      }
    }
    for (const fire of cache.upcoming) {
      bucket(dayKey(new Date(fire.at))).planned.push(fire);
    }
    return byDay;
  }

  function renderCalendar() {
    const byDay = collectByDay();
    const year = view.getFullYear();
    const month = view.getMonth();
    document.querySelector("#cal-title").textContent =
      view.toLocaleDateString([], { month: "long", year: "numeric" }).toUpperCase();

    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // back to Monday
    const todayKey = dayKey(new Date());

    let html = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
      .map((d) => `<div class="cal-head">${d}</div>`).join("");
    const cursor = new Date(start);
    for (let i = 0; i < 42; i++) {
      const key = dayKey(cursor);
      const info = byDay[key] || { past: [], planned: [] };
      const ok = info.past.filter((r) => r.status === "success").length;
      const bad = info.past.length - ok;
      const dots =
        (ok ? `<i class="dot success"></i>${ok > 1 ? `<em>${ok}</em>` : ""}` : "") +
        (bad ? `<i class="dot error"></i>${bad > 1 ? `<em>${bad}</em>` : ""}` : "") +
        (info.planned.length ? `<i class="dot planned"></i>${info.planned.length > 1 ? `<em>${info.planned.length}</em>` : ""}` : "");
      html += `
        <button class="cal-day ${cursor.getMonth() === month ? "" : "dim"} ${key === todayKey ? "today" : ""} ${key === selectedDay ? "selected" : ""}" data-day="${key}">
          <span class="num">${cursor.getDate()}</span>
          <span class="marks">${dots}</span>
        </button>`;
      cursor.setDate(cursor.getDate() + 1);
    }
    document.querySelector("#calendar").innerHTML = html;
    document.querySelectorAll(".cal-day").forEach((el) => {
      el.onclick = () => { selectedDay = el.dataset.day; renderCalendar(); renderDay(); };
    });
  }

  function renderDay() {
    const byDay = collectByDay();
    const info = byDay[selectedDay] || { past: [], planned: [] };
    const items = [
      ...info.past.map((r) => ({ ...r, kind: "past" })),
      ...info.planned.map((f) => ({ ...f, kind: "planned" }))
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

    const label = new Date(selectedDay + "T00:00:00")
      .toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    const el = document.querySelector("#day-panel");
    el.innerHTML = `
      <p class="eyebrow">DAY</p>
      <h2>${esc(label)}</h2>
      <div class="timeline">
        ${items.length ? items.map((it) => it.kind === "past" ? `
          <button class="tl-item" data-log="${esc(it.log || "")}" data-name="${esc(it.name)}">
            <i class="dot ${it.status}"></i>
            <span class="tl-time">${hhmm(it.at)}</span>
            <span class="tl-name">${esc(it.name)}</span>
            <span class="tl-tag">${it.status}${it.exit_code ? ` · exit ${it.exit_code}` : ""} · log ↗</span>
          </button>` : `
          <div class="tl-item planned-item">
            <i class="dot planned"></i>
            <span class="tl-time">${hhmm(it.at)}</span>
            <span class="tl-name">${esc(it.name)}</span>
            <span class="tl-tag">scheduled</span>
          </div>`).join("") : '<p class="muted-note">Nothing ran or is scheduled this day.</p>'}
      </div>`;
    el.querySelectorAll("[data-log]").forEach((btn) => {
      btn.onclick = async () => {
        document.querySelector("#log-title").textContent = btn.dataset.name;
        let text = "(log unavailable)";
        try { text = await window.elianBot.readLog(btn.dataset.log); } catch (err) { text = String(err.message || err); }
        document.querySelector("#log-body").textContent = text || "(empty log)";
        document.querySelector("#log-dialog").showModal();
      };
    });
  }

  function renderMessages() {
    const el = document.querySelector("#messages");
    el.innerHTML = cache.messages.length
      ? cache.messages.slice(0, 60).map((m) => `
        <div class="msg ${m.kind === "ping" ? "ping" : ""}">
          <span class="msg-route">${esc(m.from)} → ${esc(m.to)}</span>
          <span class="msg-text">${esc(m.text)}</span>
          <span class="msg-time">${new Date(m.at).toLocaleString()}</span>
        </div>`).join("")
      : '<p class="muted-note" style="padding:14px 18px">No messages yet. Jobs print "@grok …" to talk; every finished run auto-pings.</p>';
  }

  async function refresh(sharedState) {
    cache.jobs = sharedState.jobs || [];
    [cache.upcoming, cache.messages] = await Promise.all([
      window.elianBot.upcoming(45),
      window.elianBot.messages()
    ]);
    renderCalendar();
    renderDay();
    renderMessages();
  }

  document.querySelector("#cal-prev").onclick = () => { view.setMonth(view.getMonth() - 1); renderCalendar(); renderDay(); };
  document.querySelector("#cal-next").onclick = () => { view.setMonth(view.getMonth() + 1); renderCalendar(); renderDay(); };
  document.querySelector("#cal-today").onclick = () => { view = new Date(); selectedDay = dayKey(new Date()); renderCalendar(); renderDay(); };
  document.querySelector(".log-close").onclick = () => document.querySelector("#log-dialog").close();

  window.elianBotDashboard = { refresh };
})();
