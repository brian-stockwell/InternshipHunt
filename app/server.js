// server.js: the front desk.
//
// Starts the local web app at http://localhost:4321 (or $PORT), serves the
// single-page UI from public/, and exposes a small JSON API for it. Binds to
// 127.0.0.1 only and never talks to the internet.

const fs = require("fs");
const path = require("path");
const express = require("express");
const { execFile, execFileSync, spawn } = require("child_process");
const { Store, ensureSkeleton, resolveRoot, makePaths } = require("./state");
const { InboxWatcher } = require("./watcher");
const { backupAtStartupIfNeeded } = require("./backup");
const { isoNY } = require("./lib/util");

const PORT = Number(process.env.PORT) || 4321;
const OPEN_BROWSER = process.argv.includes("--open");

// ---------------------------------------------------------------------------
// Boot: create the folder skeleton, replay the event log, refresh exports,
// take the daily backup if one is due, start watching the inbox.
// ---------------------------------------------------------------------------
const root = resolveRoot();
ensureSkeleton(makePaths(root));
const store = new Store(root);
store.replay();
store.regenerateExports();
backupAtStartupIfNeeded(store);

const watcher = new InboxWatcher(store);
watcher.start();


// ---------------------------------------------------------------------------
// Helpers for the API
// ---------------------------------------------------------------------------

// List the current .error markers in inbox/ with their contents.
function listErrorMarkers() {
  let entries = [];
  try { entries = fs.readdirSync(store.paths.inbox); } catch { return []; }
  const out = [];
  for (const name of entries.filter((n) => n.endsWith(".error")).sort()) {
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(store.paths.inbox, name), "utf8")); } catch { /* show as unreadable */ }
    out.push({ file: name.slice(0, -".error".length), marker });
  }
  return out;
}

// List markdown files in a Cowork-owned folder, ignoring dot-prefixed entries.
function listMarkdownFolder(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!name.endsWith(".md")) continue;
    try {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ name, mtime: st.mtimeMs, content: fs.readFileSync(full, "utf8") });
    } catch { /* skip unreadable entries */ }
  }
  return out;
}

// Header staleness math (spec section 10).
function deliveryFreshness() {
  if (!store.lastDeliveryProducedAt) {
    return { ever: false, message: "Waiting for the first delivery" };
  }
  const ageDays = (Date.now() - Date.parse(store.lastDeliveryProducedAt)) / 86400000;
  return {
    ever: true,
    lastProducedAt: store.lastDeliveryProducedAt,
    lastDeliveryId: store.lastDeliveryId,
    stale: ageDays > 8,
    message: ageDays > 8 ? `No delivery in ${Math.floor(ageDays)} days` : null,
  };
}

// ---------------------------------------------------------------------------
// On-demand research runs (the "Find more opportunities" button).
// The button launches the researcher as a headless Claude run on this Mac.
// The researcher follows cowork/PLAYBOOK.md and publishes a normal delivery
// into inbox/, which the watcher ingests like any other. The app itself still
// never touches the internet; the spawned researcher is the one browsing.
// ---------------------------------------------------------------------------

// launchd starts this server with a nearly empty PATH, so find the claude
// binary by checking the usual homes rather than trusting PATH.
function findClaudeBinary() {
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(process.env.HOME || "", ".claude", "local", "claude"),
    path.join(process.env.HOME || "", ".local", "bin", "claude"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  try {
    return execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const RESEARCH_PROMPT = [
  "You are the InternshipHunt researcher on this Mac. This is an ON-DEMAND",
  "supplemental research run that the user just triggered from the app's 'Find more",
  "opportunities' button; they want fresh postings now.",
  "Read ~/InternshipHunt/INTERFACE-SPEC.md and ~/InternshipHunt/cowork/PLAYBOOK.md",
  "in full and follow them exactly, with these run-specific notes:",
  "- run_type is \"manual\".",
  "- Skip the Gmail pass (playbook step 3).",
  "- The goal is NEW postings the user does not already have: run the core sweep, at",
  "  least 3 variance experiments, and enumerate at least 2 starred-firm career",
  "  sites end to end (playbook step 2b).",
  "- Click-verify every link per playbook step 5 before delivering it. No",
  "  unverified links, ever.",
  "- Publish per playbook step 9: the delivery file is required; also write a",
  "  short report so the user can read what you tried.",
  "Work unattended. Never ask questions. Obey every safety rail in the playbook.",
].join("\n");

// The "Rescan email for applications" button under the applied group. This run
// hunts for nothing: it reads your mailboxes for applications the
// tracker does not know about, and for anything an employer is waiting on him
// to do. The rules it must follow (reachability gate, three dedup layers, the
// action-required disclaimer) live in the playbook so the button and a
// hand-asked rescan behave identically.
const APPLICATION_RESCAN_PROMPT = [
  "You are the InternshipHunt researcher on this Mac. The user just pressed",
  "'Rescan email for applications' under the applied group in the app.",
  "Read ~/InternshipHunt/INTERFACE-SPEC.md and ~/InternshipHunt/cowork/PLAYBOOK.md",
  "in full, then follow the 'Application rescan mode' section of the playbook",
  "exactly, start to finish. That section is the specification for this run.",
  "- run_type is \"manual\".",
  "- Do NOT hunt for new postings: skip playbook steps 2, 2b, 4, and 8.",
  "- Scan EVERY address in email_addresses in",
  "  ~/InternshipHunt/profile/preferences.json. If an application email is",
  "  addressed to some other address, deliver it",
  "  anyway and name that address in the report.",
  "- Rule R1 is the one that matters most: if you cannot actually search a",
  "  mailbox, report it as UNREACHABLE and name the reason. Never report 'no",
  "  new applications' for a mailbox you could not scan. A silent false",
  "  negative here can cost the user an assessment deadline.",
  "- Apply all three R4 dedup layers so nothing is counted twice.",
  "- Hunt explicitly for next-round and advancement emails per R3 and R3b:",
  "  interview invitations, assessment invitations, offers, and 'moving",
  "  forward' notes with no ask, which get the NEXT ROUND evidence prefix.",
  "- Apply the R6 disclaimer verbatim to every assessment, HireVue, or",
  "  interview action item you find. Report those links, never open them.",
  "- Publish per R7. The delivery file is required even when you found nothing,",
  "  so the run leaves a record in the Log tab.",
  "Work unattended. Never ask questions. Obey every safety rail in the playbook.",
].join("\n");

// Does the headless CLI we spawn have any way to read the user's mail?
//
// It does not, and that is not a bug we can paper over. The Gmail connector is
// authorized inside Cowork, and the `claude -p` process this server spawns is a
// different surface with its own MCP config (currently github only). A rescan
// launched here spends about three minutes and correctly concludes that every
// mailbox is unreachable, which is honest but useless. Check first and refuse
// to spawn instead, so the button tells the truth in a second rather than in
// three minutes. Reading the config directly keeps this fast; `claude mcp list`
// would mean a subprocess on every press.
// Rescan requests waiting for a Cowork run to pick them up. Surfaced in
// /api/view so the UI can show a queued state that survives its own redraw
// rather than a message that flashes and disappears.
function queuedRescans() {
  try {
    return fs.readdirSync(path.join(store.paths.cowork, "requests"))
      .filter((f) => /^rescan-.*\.json$/.test(f))
      .sort()
      .map((f) => {
        // Filename stamps are UTC ("2026-08-12T02-39-37-014Z"); turn them back
        // into a real instant so the UI can show the user a local time instead of
        // a confusing tomorrow-date.
        const m = /^rescan-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
        const at = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
        return { file: f, at };
      });
  } catch {
    return [];
  }
}

// Hand the rescan to Cowork, which is the only surface with the Gmail
// connector. Claude.app registers the `claude://` scheme (see its Info.plist)
// and `claude://cowork/new?q=<prompt>` opens a fresh Cowork session with the
// prompt already in place, so the button goes from "read this and go do it
// yourself" to one click.
const COWORK_RESCAN_PROMPT = [
  "Run the InternshipHunt application rescan.",
  "Read ~/InternshipHunt/cowork/PLAYBOOK.md and follow its 'Application rescan mode' section (R0 through R7) exactly.",
  "Scan every address in email_addresses in ~/InternshipHunt/profile/preferences.json for new applications, for next-round and advancement emails (R3b), and for anything an employer is waiting on the user to do (R6). Publish per R7.",
  "This was queued from the app's Rescan button; delete the matching file in ~/InternshipHunt/cowork/requests/ after the delivery rename.",
].join(" ");

function openCoworkRescan() {
  const url = `claude://cowork/new?q=${encodeURIComponent(COWORK_RESCAN_PROMPT)}`;
  try {
    // Detached and unref'd: the app must not wait on, or be killed with, the
    // GUI it just launched.
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false; // The queued request file is still the durable fallback.
  }
}

function localMailServers() {
  const names = new Set();
  const collect = (obj) => {
    for (const k of Object.keys(obj || {})) {
      if (/gmail|google|mail|imap/i.test(k)) names.add(k);
    }
  };
  for (const file of [path.join(process.env.HOME || "", ".claude.json"), path.join(store.paths.root, ".mcp.json")]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      collect(cfg.mcpServers);
      collect((cfg.projects || {})[store.paths.root]?.mcpServers);
    } catch { /* absent or unparseable config just means no servers from it */ }
  }
  return [...names];
}

const research = { running: false, pid: null, startedAt: null, lastExit: null, logFile: null, progress: [], label: null };

// Keep a rolling window of human-readable progress lines for the UI feed.
function pushProgress(text) {
  research.progress.push({ at: isoNY(), text: String(text).slice(0, 220) });
  if (research.progress.length > 60) research.progress.splice(0, research.progress.length - 60);
}

// Turn one streamed researcher event into a line a person would want to read.
// The researcher runs with --output-format stream-json, which emits one JSON
// object per line as it works; we narrate the interesting ones.
function describeResearchEvent(ev) {
  if (ev.type === "system" && ev.subtype === "init") {
    pushProgress("Researcher booted; reading the playbook and your current postings.");
    return;
  }
  if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === "tool_use") {
        const input = block.input || {};
        switch (block.name) {
          case "WebSearch": pushProgress(`Searching the web: ${input.query || ""}`); break;
          case "WebFetch": pushProgress(`Opening and reading: ${input.url || ""}`); break;
          case "Bash": pushProgress(`Working: ${(input.description || input.command || "").slice(0, 130)}`); break;
          case "Read": pushProgress(`Reading file: ${String(input.file_path || "").split("/").pop()}`); break;
          case "Write": pushProgress(`Writing file: ${String(input.file_path || "").split("/").pop()}`); break;
          case "TodoWrite": break; // internal bookkeeping; not interesting
          default: pushProgress(`Using tool: ${block.name}`);
        }
      } else if (block.type === "text" && block.text && block.text.trim()) {
        pushProgress(`Researcher: ${block.text.trim().replace(/\s+/g, " ").slice(0, 180)}`);
      }
    }
    return;
  }
  if (ev.type === "result") {
    pushProgress(ev.is_error ? "Run ended with an error; see the transcript in app/logs/." : "Run complete; findings published.");
  }
}

// `prompt` is the instruction set for this run; `label` is what the user sees in
// the Log tab so the two run kinds are told apart after the fact.
function startResearchRun(prompt = RESEARCH_PROMPT, label = "Find more opportunities") {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    return { error: "Could not find the claude command-line tool on this Mac. Install Claude Code, then try again." };
  }
  fs.mkdirSync(store.paths.appLogs, { recursive: true });
  const logName = `research-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  const logPath = path.join(store.paths.appLogs, logName);
  const logFd = fs.openSync(logPath, "a");

  // stream-json makes the researcher narrate as it works, one JSON event per
  // line on stdout. We read that stream live for the UI progress feed and
  // also append every line to the transcript file.
  const child = spawn(claudeBin, ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"], {
    cwd: store.paths.root,
    env: { ...process.env, PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    stdio: ["ignore", "pipe", logFd],
  });
  fs.closeSync(logFd);

  const rl = require("readline").createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try { fs.appendFileSync(logPath, line + "\n"); } catch { /* transcript is best effort */ }
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    try { describeResearchEvent(ev); } catch { /* a weird event must not kill the feed */ }
  });

  research.progress = [];
  research.running = true;
  research.pid = child.pid;
  research.startedAt = isoNY();
  research.logFile = logName;
  store.log("research", `Research run started (${label}). Findings will arrive as a normal delivery; transcript in app/logs/${logName}.`);

  child.on("exit", (code, signal) => {
    research.running = false;
    research.pid = null;
    research.lastExit = { code, signal, at: isoNY() };
    if (signal) {
      store.log("research", `Research run stopped (${signal}).`);
    } else if (code === 0) {
      store.log("research", "Research run finished. If it found anything, the delivery is ingesting now (or already did).");
    } else {
      store.log("research", `Research run exited with code ${code}; see app/logs/${logName} for what happened.`);
    }
  });
  child.on("error", (e) => {
    research.running = false;
    research.pid = null;
    store.log("research", `Research run failed to start: ${e.message}`);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// Only the user's own app page may call the write endpoints. Without this, any
// website open in his browser could quietly POST to localhost and, worst
// case, start a researcher run on his Mac. Browsers always send an Origin
// header on cross-site POSTs; requests without one (curl, tests, same-host
// tools) are fine.
app.use((req, res, next) => {
  if (req.method !== "POST") return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const ok = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin);
  if (!ok) return res.status(403).json({ error: "Requests are only accepted from the app's own page." });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Everything the UI needs, in one call. The frontend polls this.
app.get("/api/view", (req, res) => {
  const errors = listErrorMarkers();
  res.json({
    now: isoNY(),
    freshness: deliveryFreshness(),
    counts: store.counts(),
    badges: {
      pending: store.pending.size,
      errors: errors.length,
      sittingUnapplied: store.sittingUnapplied(),
    },
    postings: [...store.postings.values()],
    pending: [...store.pending.values()],
    orphans: [...store.orphans.values()],
    errors,
    log: store.logLines.slice(-200).reverse(),
    research: { running: research.running, startedAt: research.startedAt, lastExit: research.lastExit, progress: research.progress.slice(-12) },
    rescanQueued: queuedRescans(),
    // Action evidence survives the suggestion being confirmed, so the banner
    // keeps showing the real deadline instead of falling back to a generic
    // "assessment outstanding" the moment the user acknowledges it.
    actionEvidence: Object.fromEntries(store.actionEvidence),
    actionDone: Object.fromEntries(store.actionDone),
    // Next-round news survives its suggestion the same way (spec 2.10), so
    // the Moving forward strip keeps showing an advancement even after the
    // suggestion that carried it resolved as a no-op or a confirm.
    nextRound: Object.fromEntries(store.nextRound),
    nextRoundSeen: Object.fromEntries(store.nextRoundSeen),
    // Rows the user removed from Action required or Coming up. The ids are
    // content-addressed by the page, so a genuinely new deadline or action on
    // the same posting gets a new id and shows up again.
    dismissedNotices: Object.fromEntries(store.dismissedNotices),
    settings: store.readSettings(),
    // Categories, region rank labels, and email addresses from
    // profile/preferences.json, so the filters and forms match this person.
    prefs: store.prefs,
  });
});

// Flip a preference. Only macNotifications exists today; unknown keys are
// ignored rather than stored, so a stale page cannot write junk into the file.
app.post("/api/settings", (req, res) => {
  const { macNotifications } = req.body || {};
  if (typeof macNotifications !== "boolean") {
    return res.status(400).json({ error: "macNotifications must be true or false." });
  }
  const next = store.writeSettings({ macNotifications });
  store.log("app", macNotifications
    ? "Mac notifications turned back on."
    : "Mac notifications turned off. The in-app panel still shows every request.");
  res.json({ ok: true, settings: next });
});

// Start an on-demand research run. One at a time.
app.post("/api/research/start", (req, res) => {
  if (research.running) return res.status(409).json({ error: "A research run is already going." });
  const result = startResearchRun(RESEARCH_PROMPT, "Find more opportunities");
  if (result.error) return res.status(500).json(result);
  res.json({ ok: true });
});

// Rescan the user's mailboxes for applications the tracker does not know about.
// Shares the one-run-at-a-time guard and the stop button with the sweep.
app.post("/api/research/rescan-applications", (req, res) => {
  if (research.running) return res.status(409).json({ error: "A research run is already going." });
  // No mail connector on this Mac means a local run cannot succeed. Rather than
  // dead-end, queue the request: the next Cowork run (where the Gmail connector
  // actually lives) picks it up at playbook step 1 and fulfills it.
  if (localMailServers().length === 0) {
    // Already waiting? Say so rather than stacking duplicates. Clicking again
    // because nothing seemed to happen should not create a second job.
    const already = queuedRescans();
    if (already.length > 0) {
      const opened = openCoworkRescan();
      const since = already[0].at
        ? new Date(already[0].at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "earlier";
      return res.status(200).json({
        queued: true,
        error: opened
          ? "Already queued, so I reopened Cowork with the rescan ready to send. Press enter there."
          : `A rescan is already queued and waiting for Cowork (since ${since}), but Cowork would not open. Ask it to "run the application rescan".`,
      });
    }
    const dir = path.join(store.paths.cowork, "requests");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.rescan-${stamp}.json`);
      fs.writeFileSync(tmp, JSON.stringify({
        kind: "application-rescan",
        requested_at: isoNY(),
        reason: "You pressed 'Rescan email for applications'; this Mac's headless Claude has no mail connector.",
      }, null, 2) + "\n");
      fs.renameSync(tmp, path.join(dir, `rescan-${stamp}.json`));
    } catch (e) {
      return res.status(500).json({ error: `Could not queue the rescan: ${e.message}` });
    }
    const opened = openCoworkRescan();
    store.log("research", `Rescan queued for Cowork${opened ? " and Cowork opened with the prompt ready" : " (could not open Cowork automatically)"}.`);
    return res.status(202).json({
      queued: true,
      error: opened
        ? "Opening Cowork with the rescan ready to send. Press enter there. If you close it instead, the request stays queued and the weekly sweep picks it up."
        : "Queued for Cowork. Your Gmail connector lives there, not on this Mac, so this button cannot read mail itself. Cowork would not open automatically; ask it to \"run the application rescan\", or leave it for the weekly sweep.",
    });
  }
  const result = startResearchRun(APPLICATION_RESCAN_PROMPT, "Rescan email for applications");
  if (result.error) return res.status(500).json(result);
  res.json({ ok: true });
});

// Stop a running research run (it costs money; the user gets a kill switch).
app.post("/api/research/stop", (req, res) => {
  if (!research.running || !research.pid) return res.status(409).json({ error: "No research run is going." });
  try { process.kill(research.pid, "SIGTERM"); } catch { /* already gone */ }
  res.json({ ok: true });
});

app.get("/api/reports", (req, res) => {
  res.json(listMarkdownFolder(store.paths.reports).sort((a, b) => b.name.localeCompare(a.name)));
});

// ----- the user's actions -----

const USER_STATUSES = ["new", "interested", "applied", "oa", "interview", "offer", "rejected", "withdrawn", "closed"];

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

app.post("/api/posting/status", (req, res) => {
  const { key, status, applied_date } = req.body || {};
  if (!store.postings.has(key)) return res.status(404).json({ error: "unknown posting" });
  if (!USER_STATUSES.includes(status)) return res.status(400).json({ error: "bad status" });
  // state.json promises the researcher a real YYYY-MM-DD or null; never let a
  // freehand string through into the contract file.
  if (applied_date !== undefined && applied_date !== null && !DATE_ONLY_RE.test(String(applied_date))) {
    return res.status(400).json({ error: "The applied date must look like 2026-08-11 (YYYY-MM-DD)." });
  }
  store.userSetStatus(key, status, applied_date);
  res.json({ ok: true });
});

// Add a posting the user found himself (title, company, link, etc.).
app.post("/api/posting/add", (req, res) => {
  const result = store.userAddPosting(req.body || {});
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post("/api/posting/hidden", (req, res) => {
  const { key, hidden } = req.body || {};
  if (!store.postings.has(key)) return res.status(404).json({ error: "unknown posting" });
  store.userSetHidden(key, !!hidden);
  res.json({ ok: true });
});

app.post("/api/posting/edit", (req, res) => {
  const { key, fields } = req.body || {};
  if (!store.postings.has(key)) return res.status(404).json({ error: "unknown posting" });
  if (typeof fields !== "object" || fields === null) return res.status(400).json({ error: "bad fields" });
  if (fields.next_followup && !DATE_ONLY_RE.test(String(fields.next_followup))) {
    return res.status(400).json({ error: "The follow-up date must look like 2026-08-11 (YYYY-MM-DD)." });
  }
  store.userEditFields(key, fields);
  res.json({ ok: true });
});

// The user finished an assessment or interview. Records action completion only;
// the posting's status is untouched, since finishing a HireVue says nothing
// about what the employer decided next.
app.post("/api/action/done", (req, res) => {
  const key = String(req.body?.key || "");
  if (!key) return res.status(400).json({ error: "A posting key is required." });
  store.markActionDone(key, req.body?.done !== false);
  res.json({ ok: true });
});

// The user removed a row from Action required or Coming up, or pressed Undo in
// the toast. Records the removal only: no status, deadline or follow-up date
// is touched, because hiding a reminder says nothing about the job itself.
app.post("/api/notice/dismiss", (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ error: "A notice id is required." });
  if (id.length > 200) return res.status(400).json({ error: "That notice id is too long." });
  const kind = req.body?.kind === "upcoming" ? "upcoming" : "action";
  const key = req.body?.key ? String(req.body.key).slice(0, 200) : null;
  store.dismissNotice(id, req.body?.dismissed !== false, kind, key);
  res.json({ ok: true });
});

// The user acknowledged a Moving forward row ("Got it"), or undid one. Records
// the acknowledgment only; the posting's status is untouched.
app.post("/api/nextround/seen", (req, res) => {
  const key = String(req.body?.key || "");
  if (!key) return res.status(400).json({ error: "A posting key is required." });
  store.markNextRoundSeen(key, req.body?.seen !== false);
  res.json({ ok: true });
});

// Add an action the user heard about somewhere the researcher cannot look: a
// text, a phone call, a recruiter telling him face to face. It lands in the
// same banner as a delivered action and is marked done the same way.
app.post("/api/action/add", (req, res) => {
  const result = store.userAddAction(req.body || {});
  if (result.error) return res.status(400).json(result);
  res.json({ ok: true });
});

app.post("/api/suggestion/confirm", (req, res) => {
  const ok = store.confirmSuggestion((req.body || {}).id);
  if (!ok) return res.status(404).json({ error: "unknown suggestion" });
  res.json({ ok: true });
});

app.post("/api/suggestion/dismiss", (req, res) => {
  const id = (req.body || {}).id;
  // Pending first, then orphans: the UI has one Dismiss control per row and
  // should not need to know which map the suggestion lives in.
  const ok = store.dismissSuggestion(id) || store.dismissOrphan(id);
  if (!ok) return res.status(404).json({ error: "unknown suggestion" });
  res.json({ ok: true });
});

app.post("/api/suggestion/bulk-confirm-closed", (req, res) => {
  const n = store.bulkConfirmClosed();
  res.json({ ok: true, confirmed: n });
});

// Retry an error-marked delivery: delete the marker and re-run the pipeline.
app.post("/api/retry", (req, res) => {
  const { file } = req.body || {};
  if (typeof file !== "string" || file.includes("/") || file.includes("..")) {
    return res.status(400).json({ error: "bad file name" });
  }
  const deliveryPath = path.join(store.paths.inbox, file);
  if (!fs.existsSync(deliveryPath)) {
    return res.status(404).json({ error: "That delivery file is no longer in the inbox. If the failure was fixed by a newer delivery, use Clear instead." });
  }
  const markerPath = deliveryPath + ".error";
  if (fs.existsSync(markerPath)) { try { fs.unlinkSync(markerPath); } catch { /* ignore */ } }
  watcher.forget(file);
  store.log("ingest", `Retry requested for ${file}`);
  watcher.scan();
  res.json({ ok: true });
});

// Clear a stale error marker whose delivery file is gone (superseded by a
// corrected delivery, or removed by hand). Refuses while the delivery still
// exists, because then the honest actions are fixing the file or Retry.
app.post("/api/error-marker/clear", (req, res) => {
  const { file } = req.body || {};
  if (typeof file !== "string" || file.includes("/") || file.includes("..")) {
    return res.status(400).json({ error: "bad file name" });
  }
  const deliveryPath = path.join(store.paths.inbox, file);
  const markerPath = deliveryPath + ".error";
  if (!fs.existsSync(markerPath)) return res.status(404).json({ error: "marker not found" });
  if (fs.existsSync(deliveryPath)) {
    return res.status(409).json({ error: "The failed delivery file is still in the inbox. Fix it and press Retry, or remove the file first if it was superseded." });
  }
  try { fs.unlinkSync(markerPath); } catch (e) {
    return res.status(500).json({ error: `Could not remove the marker: ${e.message}` });
  }
  store.log("error", `Cleared the error marker for ${file} (its delivery file was already gone).`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Listen (127.0.0.1 only) with a friendly port-conflict message.
// ---------------------------------------------------------------------------
const server = app.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`InternshipHunt is running at ${url}`);
  console.log(`Data lives in ${root}`);
  if (OPEN_BROWSER && process.platform === "darwin") {
    execFile("open", [url], () => { /* best effort */ });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is in use. Start with PORT=${PORT + 1} npm start (or stop the other program).`);
    process.exit(1);
  }
  throw e;
});

// Last-resort safety nets. A stray error in a background corner (a watcher
// event, a research stream line) must not take the whole app down; under
// launchd's KeepAlive that becomes a crash-restart loop that churns backups.
// Log it loudly and keep serving; the event log on disk is always the truth.
process.on("unhandledRejection", (e) => {
  console.error("Unhandled rejection:", e);
  try { store.log("error", `Internal error (survived): ${e && e.message ? e.message : e}`); } catch { /* logging must not throw */ }
});
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", e);
  try { store.log("error", `Internal error (survived): ${e && e.message ? e.message : e}`); } catch { /* logging must not throw */ }
});
