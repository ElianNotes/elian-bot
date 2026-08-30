# ElianBot

**An AI-controlled local script scheduler.** One job = one `.sh` file on disk, run
by plain deterministic code — on a cron schedule or on click. The AI (any MCP
client: Grok, Claude, Cursor, …) writes the script *once*; ElianBot runs it
forever — free, offline, and reproducible. No tokens burned per run.

The idea in one line: **AI for creation, code for execution.**

```
AI writes script ──▶ ElianBot schedules & runs it ──▶ output routed anywhere
        (once)              (forever, free)          (feed · jobs · notify · webhook)
```

## Quick start

```bash
npm install     # once (installs Electron)
npm start       # open the app — open = the scheduler runs; closed = nothing fires
npm test        # headless engine checks (cron, safety, mentions, webhooks)
```

macOS: double-click `ElianBot.command` — it installs on first run, then launches.

## The app

A small Electron window with two tabs:

- **Jobs** — job list + detail pane. Per job: Run now, Pause, Edit, Delete,
  reveal script/log in Finder. Schedules are built with plain dropdowns
  (every X minutes / hourly / daily / weekdays / weekly / monthly at a time);
  a raw cron field stays underneath for power users, with a live plain-English
  preview ("weekdays at 08:00 — next: Mon 08:00").
- **Dashboard** — a calendar of past runs (green = ok, red = failed, blue =
  scheduled, computed from the crons), a per-day timeline with one-click log
  viewing, and the live message feed.
- A **"?" button** opens the built-in manual.

Every finished run **auto-pings**: a feed entry plus a macOS notification
(failures ping with sound).

## Routing output with @ lines

A job talks by printing lines that start with `@`:

| line printed by the script | what happens |
|---|---|
| `@grok <text>` | posts to the message feed (the AI reads it via MCP `read_messages`) |
| `@<job-slug>` | runs that job with this output as its input (`$ELIANBOT_INPUT`), chain depth capped at 3 |
| `@notify <text>` | immediate macOS notification |
| `@webhook <url> [auth=<name>]` | POSTs `{source, job, at, note, output}` as JSON to any app |

Each job also has a **WEBHOOK panel** in the UI: paste a URL and (optionally) an
Authorization value — every successful run then POSTs its output there. The
secret is written straight into a local, gitignored `secrets.json`; it can never
be read back from the UI and never appears in output, feed, logs, or git. Any
paste shape works: bare key, `Bearer key`, or a full `Authorization: …` header line.

What a script receives as environment:

| variable | meaning |
|---|---|
| `$ELIANBOT_INPUT` / `$ELIANBOT_INPUT_FILE` | input handed over by a mention or `run_job` |
| `$ELIANBOT_JOB_ID` / `$ELIANBOT_JOB_NAME` | identity |
| `$ELIANBOT_LOG` | this run's log file |
| `$ELIANBOT_DATA` | the data folder |

## AI remote control (MCP)

`mcp.js` is a zero-dependency MCP stdio server. Register it in any MCP client:

```json
{ "command": "node", "args": ["/path/to/elianbot/mcp.js"] }
```

Tools: `list_jobs · get_job · create_job · update_job · run_job · pause_job ·
resume_job · get_output · read_messages · send_message · delete_job`.

The AI can create a job from a plain script body (`create_job` with
`script_content`), set its schedule and webhook URL, hand a run input, and read
every outcome from the feed. Each job carries a **description** — the original
prompt that created it, shown read-only in the UI as a record (never executed).

**One brain rule:** the MCP only edits data files and queues run requests; the
open app is the only thing that ever executes a job.

## Included template: video brief

`templates/video-brief.sh` turns any text (typically another job's output, via
`@video-brief`) into a narrated MP4 — designed title cards, Ken Burns motion,
crossfades, per-slide narration — using only free native tools (`say`,
`qlmanage`, `sips`, `ffmpeg`). No AI at runtime.

## Safety model (small on purpose)

- A job runs as `spawn("/bin/bash", [script_path])` — the script path is argv
  and job values are env vars. **Nothing a job contains is ever parsed as shell
  source**, so there is no injection surface.
- All JSON writes are atomic (tmp + rename).
- AI-written scripts land in `scripts/` with unique names — never overwriting.
- `delete_job` requires `confirm:true` and never deletes script files.
- Secrets live only in a local gitignored file, referenced by name.

## Data layout

Everything lives in `data/` next to the app (the green tab in the header shows
the location — click it to move everything elsewhere; the choice persists):

```
jobs.json       job configs (the MCP edits this too)
state.json      run results, history (app-only)
messages.json   the feed: pings, @grok mentions, handoffs
secrets.json    Authorization values, by name (gitignored, local only)
scripts/        AI-written .sh files
runs/<id>/      one log per run
requests/       run-now queue (MCP → app)
videos/         rendered video briefs
```

## Stack

Electron + vanilla JS, zero runtime dependencies beyond Electron itself.
Engine, cron parser, MCP protocol: ~1,200 lines total, all readable in one
sitting. Tests run headless with no Electron.

## License

[MIT](LICENSE)
