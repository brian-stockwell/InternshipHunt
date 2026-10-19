// app.js: the whole frontend. Plain JavaScript, no frameworks.
// It polls GET /api/view every 3 seconds (and right after any action) and
// redraws whatever tab is visible, skipping the redraw when nothing changed
// so text selection, open dropdowns, and mid-click taps survive the poll.

"use strict";

let view = null;          // latest /api/view payload
let activeTab = "postings";
let openDetailKey = null; // posting key whose detail panel is open, if any
let detailDirty = false;  // unsaved edits in the detail panel
let modalDirty = false;   // unsaved edits in the apply/add dialog
let docsCache = { outreach: null, reports: null };
let expandedDocs = { outreach: null, reports: null }; // Set of doc names open
let attnExpanded = false; // Needs attention list expanded past its summary
let refreshFailures = 0;  // consecutive /api/view failures (offline strip)
// Posting keys the Action required banner is currently showing as live. Written
// by renderActionRequired (which render() always calls first) and read by
// renderAttention to decide what it may safely suppress. Cleared on every entry
// so an empty banner can never leave Needs attention hiding things.
let bannerKeys = [];
// Rows the user just triaged stay put, muted, with an Undo, instead of jumping
// to another group mid-click-run. key -> { action, prevStatus, at }
const recentTriage = new Map();
const TRIAGE_HOLD_MS = 5 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

// Today's date in New York, never UTC: toISOString() would date an 11pm
// application tomorrow.
function todayNY() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Region rank names from profile/preferences.json (the spec's se_rank).
function rankName(rank) {
  const p = (view && view.prefs) || {};
  return { 1: p.rank1_label || "top choice", 2: p.rank2_label || "good fit", 3: "elsewhere" }[rank] || "unknown";
}

// One of seven chip colors per category, by its position in preferences.json.
function catColor(category) {
  const cats = (view && view.prefs && view.prefs.categories) || [];
  const i = cats.indexOf(category);
  return i === -1 ? 6 : i % 7;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function refresh() {
  try {
    const res = await fetch("/api/view");
    view = await res.json();
    refreshFailures = 0;
    $("#offline-strip").classList.add("hidden");
    render();
  } catch {
    // Server briefly unreachable (restart); tell the user if it keeps happening.
    refreshFailures++;
    if (refreshFailures >= 2) {
      const strip = $("#offline-strip");
      strip.textContent = "Cannot reach the app right now. If this does not clear in a few seconds, the server may have stopped; it normally restarts itself.";
      strip.classList.remove("hidden");
    }
  }
}

let toastTimer = null;
// `undo`, when given, puts an Undo button in the toast. This is how removing a
// row can be instant and still be a mistake you can take back: the row leaves
// the screen immediately (no greyed-out corpse sitting there), and the way
// back is in the toast for as long as it is up.
function showToast(msg, kind = "error", undo = null) {
  const t = $("#toast");
  t.textContent = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (typeof undo === "function") {
    const b = document.createElement("button");
    b.className = "toast-undo";
    b.textContent = "Undo";
    b.onclick = async () => {
      b.disabled = true;
      clearTimeout(toastTimer);
      t.classList.add("hidden");
      await undo();
    };
    t.appendChild(b);
  }
  t.className = kind === "info" ? "info" : "";
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "info" ? 12000 : 6000);
}

// POST an action and surface failures instead of swallowing them. Returns the
// parsed body (or null), so callers can read server messages when they care.
async function post(url, body) {
  let parsed = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    try { parsed = await res.json(); } catch { parsed = null; }
    if (!res.ok) {
      showToast((parsed && parsed.error) || "That did not save. Try again in a moment.");
    }
  } catch {
    showToast("Could not reach the app. Is it still running?");
  }
  await refresh(); // immediate refresh after any action
  return parsed;
}

async function loadDocs(kind) {
  try {
    const res = await fetch(`/api/${kind}`);
    docsCache[kind] = await res.json();
  } catch { /* keep the stale cache; the poll will retry */ }
}

// ---------------------------------------------------------------------------
// Tiny markdown renderer for outreach and reports. Escapes HTML first so a
// document can never inject markup, then applies simple formatting.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Links render as links only when they are real web links; anything else
// stays inert text.
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || "")) ? u : null;
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  const out = [];
  let inCode = false, inList = false, inOl = false;
  const closeList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (inOl) closeList();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (inList) closeList();
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</pre>");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderHeader() {
  const f = view.freshness;
  const el = $("#freshness");
  if (!f.ever) {
    el.textContent = "Waiting for the first delivery";
    el.className = "freshness";
  } else if (f.stale) {
    el.textContent = f.message;
    el.className = "freshness warn";
  } else {
    el.textContent = `Last delivery: ${formatWhen(f.lastProducedAt)}`;
    el.className = "freshness";
  }
  const b = view.badges, c = view.counts;
  const suggCount = b.pending + view.orphans.length;
  setBadge("#badge-pending", `Suggestions: <b>${suggCount}</b>`, suggCount > 0 ? "notice" : "");
  // The badge is the way back after dismissing: the count never hides, so a
  // dismissed panel is always one click from returning.
  const badge = $("#badge-pending");
  if (badge) {
    const dismissed = !!localStorage.getItem(ATTENTION_DISMISS_KEY);
    badge.classList.toggle("clickable", suggCount > 0);
    badge.title = dismissed
      ? "Suggestions are hidden. Click to show them again."
      : "Pending suggestions waiting for your confirm";
    badge.onclick = suggCount > 0 ? () => { localStorage.removeItem(ATTENTION_DISMISS_KEY); render(); } : null;
  }
  setBadge("#badge-errors", `Errors: <b>${b.errors}</b>`, b.errors > 0 ? "alert" : "");
  setBadge("#badge-unapplied", `Unapplied: <b>${b.sittingUnapplied}</b>`, "");
  // Applications logged in the last 7 days.
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const week = view.postings.filter((p) => p.applied_date && p.applied_date >= weekAgo).length;
  setBadge("#badge-week", `This week: <b>${week}</b>`, "");
  setBadge("#badge-totals", `Total: <b>${c.total}</b> | Interested: <b>${c.interested}</b> | Applied: <b>${c.applied}</b>`, "");
}

function setBadge(sel, html, extra) {
  const el = $(sel);
  el.innerHTML = html;
  el.className = "badge" + (extra ? " " + extra : "");
}

function formatWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Removing a row from Action required or Coming up
//
// "Remove" means gone from the screen, not greyed out with a line through it.
// The undo lives in the toast instead, so a mis-click is still recoverable
// without leaving a dead row sitting in a banner the user is trying to clear.
//
// The trick that makes permanent removal safe is the id: it is built from the
// thing the row is ABOUT (the action text and its due date, or the deadline
// date), not just the posting. Remove "HireVue due Sep 5" and a later "Final
// interview due Sep 20" on the same company is a different id, so it appears
// normally. Nothing here ever mutes a posting for good.
// ---------------------------------------------------------------------------
function noticeHash(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function noticeId(kind, key, defining) {
  return `${kind}:${noticeHash(`${key} ${defining}`)}`;
}

function isNoticeDismissed(id) {
  return Object.prototype.hasOwnProperty.call(view.dismissedNotices || {}, id);
}

// Remove a row and offer the way back in the toast. `also` runs first for rows
// that have a second thing to clear (a pending suggestion behind an action, or
// a localStorage flag behind an "opened to apply" row), so Remove really does
// clear the row everywhere instead of leaving it to reappear elsewhere.
async function removeNotice({ id, kind, key, label, also = null, undoAlso = null, undoable = true }) {
  if (also) await also();
  await post("/api/notice/dismiss", { id, kind, key });
  const what = `Removed${label ? `: ${label}` : ""}.`;
  if (!undoable) {
    // Said out loud rather than offering an Undo button that would only half
    // work. This is the orphan case: clearing the suggestion behind the row
    // resolves it in an append-only log with no way back.
    showToast(`${what} That one cannot be brought back.`, "info");
    return;
  }
  showToast(what, "info", async () => {
    if (undoAlso) await undoAlso();
    await post("/api/notice/dismiss", { id, kind, key, dismissed: false });
  });
}

// ---------------------------------------------------------------------------
// Action required banner
//
// The one thing in this app that must never be missed: an employer is waiting
// on the user and there is usually a clock. The researcher writes these into a
// suggestion's evidence in a fixed shape (playbook R6):
//   ACTION REQUIRED: <what> | DUE: <YYYY-MM-DD|not stated> | <disclaimer> | <src>
// Parsing is deliberately forgiving: if the shape drifts, show the raw text
// rather than swallow the item.
// ---------------------------------------------------------------------------
// The spec's status enum is stored verbatim, but "oa" is recruiting jargon and
// has no business being the label a person reads. Display only: the underlying
// value in events.jsonl and every delivery is unchanged.
const STATUS_LABEL = {
  new: "new",
  interested: "interested",
  applied: "applied",
  oa: "online assessment",
  interview: "interview",
  offer: "offer",
  rejected: "rejected",
  withdrawn: "withdrawn",
  closed: "closed",
};
const statusLabel = (s) => STATUS_LABEL[s] || s;

function parseAction(evidence) {
  if (!evidence || !/^ACTION REQUIRED:/i.test(evidence.trim())) return null;
  const parts = evidence.split("|").map((s) => s.trim());
  const what = (parts[0] || "").replace(/^ACTION REQUIRED:\s*/i, "").trim();
  const dueRaw = (parts.find((s) => /^DUE:/i.test(s)) || "").replace(/^DUE:\s*/i, "").trim();
  const due = dueRaw && !/^not stated$/i.test(dueRaw) ? dueRaw : null;
  return { what: what || evidence, due, raw: evidence };
}

// Calendar days from today to an ISO date, or null when it will not parse.
// Deliberately date-only on both sides: comparing a due date against the
// current clock time makes "due Aug 14" read as 4 days left on the evening of
// Aug 11, which is wrong and, on a deadline banner, wrong in the dangerous
// direction.
function daysUntil(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const due = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const [ty, tm, td] = todayNY().split("-").map(Number);
  const today = Date.UTC(ty, tm - 1, td);
  return Math.round((due - today) / 86400000);
}

function renderActionRequired() {
  const box = $("#action-required");
  bannerKeys = [];
  const items = [];

  // Suggestions carrying an action, pending or orphaned. Orphans matter most:
  // an action nobody could attach to a posting is the easiest one to lose.
  for (const s of [...view.pending, ...view.orphans]) {
    const act = parseAction(s.evidence);
    if (!act) continue;
    const p = view.postings.find((x) => x.key === s.posting_key);
    items.push({
      key: s.posting_key,
      label: p ? `${p.company}: ${p.role}` : null,
      orphanKey: p ? null : s.posting_key,
      what: act.what,
      due: act.due,
      suggestionId: view.pending.includes(s) ? s.id : null,
      // Remove has to clear the underlying suggestion too, orphan or not, or
      // the row just reappears in Needs attention. "Set to ..." still only
      // makes sense for a pending one, hence the two separate fields.
      dismissId: s.id,
      status: s.suggested_status,
    });
  }

  // Standing reminders: any posting whose remembered ACTION REQUIRED evidence
  // has not been marked done keeps its banner row, whatever its status. The
  // old rule (only postings sitting in "oa") let a reminder vanish the moment
  // a suggestion was consumed or a status moved on, with the assessment still
  // undone.
  const remembered = view.actionEvidence || {};
  for (const p of view.postings) {
    if (p.hidden) continue;
    const rec = remembered[p.key];
    const act = rec ? parseAction(rec.evidence) : null;
    if (!act && p.status !== "oa") continue;
    if (items.some((i) => i.key === p.key)) continue;
    items.push({
      key: p.key,
      label: `${p.company}: ${p.role}`,
      orphanKey: null,
      what: act ? act.what : "Assessment or questionnaire outstanding",
      due: act ? act.due : null,
      suggestionId: null,
      status: p.status,
    });
  }

  // Every row gets a stable id built from what it is about, so Remove can take
  // it off the screen for good without muting the next action on that posting.
  for (const i of items) i.id = noticeId("action", i.key, `${i.what}|${i.due || ""}`);

  // Drop what the user removed by hand, and what he has already done. "Done" is
  // compared by timestamp rather than treated as a permanent mute: if a NEW
  // action lands on the same posting after he marked the old one done, it
  // comes back. Neither case leaves a greyed-out row behind; both offer their
  // undo in the toast instead.
  const done = view.actionDone || {};
  const live = items.filter((i) => {
    if (isNoticeDismissed(i.id)) return false;
    const doneAt = done[i.key];
    if (!doneAt) return true;
    const seenAt = (remembered[i.key] || {}).at;
    return seenAt ? String(seenAt) > String(doneAt) : false;
  });

  if (live.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  // Soonest deadline first; undated items sink below dated ones.
  live.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due).localeCompare(String(b.due)));

  const parts = [`<h3>Action required (${live.length})</h3>`,
    `<details><summary>What this list is (and is not)</summary>
      <p class="action-note">Someone is waiting on you. This app does not track, remind about, or complete any of these. The employer email is the only authority on the deadline. Marking one done records that you finished it; it does not change the posting's status, because finishing an assessment does not tell us what the employer decided.</p>
    </details>`];
  for (const i of live) {
    const d = i.due ? daysUntil(i.due) : null;
    let when = `<span class="action-due none">No deadline stated</span>`;
    if (i.due) {
      const cls = d === null ? "" : d < 0 ? "overdue" : d <= 3 ? "urgent" : "";
      const rel = d === null ? "" : d < 0 ? ` (${Math.abs(d)}d overdue)` : d === 0 ? " (today)" : ` (${d}d left)`;
      when = `<span class="action-due ${cls}">Due ${escapeHtml(i.due)}${rel}</span>`;
    }
    const who = i.label
      ? `<a href="#" data-open="${escapeHtml(i.key)}">${escapeHtml(i.label)}</a>`
      : `<span class="action-unmatched">Not matched to a posting yet (${escapeHtml(i.orphanKey || "unknown")})</span>`;
    parts.push(`<div class="action-row">
      <div class="action-main"><strong>${escapeHtml(i.what)}</strong><br>${who}</div>
      ${when}
      ${i.suggestionId ? `<button class="small" data-confirm-action="${escapeHtml(i.suggestionId)}">Set to ${escapeHtml(statusLabel(i.status))}</button>` : ""}
      <button class="primary" data-action-done="${escapeHtml(i.key)}">I did this</button>
      <button class="small remove" data-action-remove="${escapeHtml(i.id)}" title="Take this row off the list. It does not change the posting.">Remove</button>
    </div>`);
  }
  // Record what the banner is actually displaying so Needs attention knows what
  // it may safely suppress. Live rows only: a "done" row is on its way out.
  bannerKeys = live.map((i) => i.key);
  box.innerHTML = parts.join("");
  box.classList.remove("hidden");
  box.querySelectorAll("[data-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openDetail(a.dataset.open); });
  box.querySelectorAll("[data-confirm-action]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/suggestion/confirm", { id: b.dataset.confirmAction }); });
  // "I did this" records action completion and NOTHING else. Status changes go
  // through the explicit "Set to ..." button only. The row disappears on the
  // refresh that follows; the undo is in the toast.
  box.querySelectorAll("[data-action-done]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const key = b.dataset.actionDone;
    const row = live.find((i) => i.key === key);
    await post("/api/action/done", { key });
    showToast(`Marked done${row ? `: ${row.what}` : ""}.`, "info",
      () => post("/api/action/done", { key, done: false }));
  });
  // Remove takes the row off the list without claiming the user did anything. If
  // a pending suggestion was feeding the row, that goes too, otherwise the
  // same item just reappears down in Needs attention and nothing was removed.
  box.querySelectorAll("[data-action-remove]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const row = live.find((i) => i.id === b.dataset.actionRemove);
    if (!row) return;
    await removeNotice({
      id: row.id,
      kind: "action",
      key: row.key,
      label: row.what,
      also: row.dismissId ? () => post("/api/suggestion/dismiss", { id: row.dismissId }) : null,
      // A matched row comes back from remembered action evidence if the user
      // undoes. An orphan has no posting to come back from, so do not pretend.
      undoable: !!row.label,
    });
  });
}

// ---------------------------------------------------------------------------
// Moving forward strip (spec 2.10): emails saying the user advanced to the next
// round. Two sources feed it: pending suggestions for oa/interview/offer that
// are not already in the Action required banner (an invitation with an ask
// belongs up there, where the deadline is), and remembered NEXT ROUND
// evidence, which survives its suggestion resolving so a rule-2 no-op can
// never swallow good news. Parsing is forgiving like parseAction: if the
// shape drifts, show the raw text rather than lose the item.
// ---------------------------------------------------------------------------
let nextRoundShownIds = []; // suggestion ids the strip displays this render

function parseNextRound(evidence) {
  if (!evidence || !/^NEXT ROUND:/i.test(String(evidence).trim())) return null;
  const parts = String(evidence).split("|").map((s) => s.trim());
  const what = (parts[0] || "").replace(/^NEXT ROUND:\s*/i, "").trim();
  return { what: what || evidence, src: parts.slice(1).join(" | "), raw: evidence };
}

const NEXT_ROUND_HEADLINE = {
  oa: "Invited to an online assessment",
  interview: "Interview invitation",
  offer: "Offer received",
};

function renderNextRound() {
  const box = $("#next-round");
  nextRoundShownIds = [];
  const items = [];

  // Pending suggestions announcing a next stage. Action items stay in the
  // banner above; explicit-user suggestions were applied at ingest already.
  for (const s of view.pending) {
    if (parseAction(s.evidence)) continue;
    const nr = parseNextRound(s.evidence);
    if (!nr && !(["oa", "interview", "offer"].includes(s.suggested_status) && !s.explicit_user)) continue;
    const p = view.postings.find((x) => x.key === s.posting_key);
    if (p && p.hidden) continue;
    items.push({
      key: s.posting_key,
      label: p ? `${p.company}: ${p.role}` : s.posting_key,
      what: nr ? nr.what : NEXT_ROUND_HEADLINE[s.suggested_status] || `Moving to ${statusLabel(s.suggested_status)}`,
      src: nr ? nr.src : String(s.evidence || ""),
      suggestionId: s.id,
      status: s.suggested_status,
      at: s.at,
    });
  }

  // Remembered NEXT ROUND evidence whose suggestion already resolved. Hidden
  // once acknowledged, but a NEWER piece of news on the same posting returns.
  const remembered = view.nextRound || {};
  const seen = view.nextRoundSeen || {};
  const recentlySeen = [];
  for (const [key, rec] of Object.entries(remembered)) {
    if (items.some((i) => i.key === key)) continue;
    const p = view.postings.find((x) => x.key === key);
    if (p && p.hidden) continue;
    const nr = parseNextRound(rec.evidence);
    const item = {
      key,
      label: p ? `${p.company}: ${p.role}` : key,
      what: nr ? nr.what : String(rec.evidence || ""),
      src: nr ? nr.src : "",
      suggestionId: null,
      status: null,
      at: rec.at,
    };
    const seenAt = seen[key];
    if (seenAt && !(String(rec.at) > String(seenAt))) {
      // Acknowledged. Keep it listed, muted, with an Undo for a day, so a
      // mis-click on Got it cannot silently erase real news.
      const ms = Date.now() - new Date(seenAt).getTime();
      if (isFinite(ms) && ms < 24 * 3600 * 1000) recentlySeen.push(item);
      continue;
    }
    items.push(item);
  }

  if (items.length === 0 && recentlySeen.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const parts = [`<h3>Moving forward (${items.length})</h3>`];
  const srcLine = (t) => {
    const s = String(t || "").trim();
    if (!s) return "";
    return s.length > 170 ? `<span class="nr-src" title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 170))}...</span>` : `<span class="nr-src">${escapeHtml(s)}</span>`;
  };
  for (const i of items) {
    parts.push(`<div class="nr-row">
      <div class="nr-main"><strong>${escapeHtml(i.what)}</strong><br><a href="#" data-open="${escapeHtml(i.key)}">${escapeHtml(i.label)}</a> ${srcLine(i.src)}</div>
      ${i.suggestionId
        ? `<button class="primary" data-nr-confirm="${escapeHtml(i.suggestionId)}">Set to ${escapeHtml(statusLabel(i.status))}</button>
           <button class="small" data-nr-dismiss="${escapeHtml(i.suggestionId)}">Dismiss</button>`
        : `<button class="primary" data-nr-seen="${escapeHtml(i.key)}">Got it</button>`}
    </div>`);
  }
  for (const i of recentlySeen) {
    parts.push(`<div class="nr-row done">
      <div class="nr-main"><s>${escapeHtml(i.what)}</s><br>${escapeHtml(i.label)}</div>
      <span class="nr-src">Acknowledged</span>
      <button class="small" data-nr-unseen="${escapeHtml(i.key)}">Undo</button>
    </div>`);
  }
  nextRoundShownIds = items.filter((i) => i.suggestionId).map((i) => i.suggestionId);
  box.innerHTML = parts.join("");
  box.classList.remove("hidden");
  box.querySelectorAll("[data-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openDetail(a.dataset.open); });
  box.querySelectorAll("[data-nr-confirm]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/suggestion/confirm", { id: b.dataset.nrConfirm }); });
  box.querySelectorAll("[data-nr-dismiss]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/suggestion/dismiss", { id: b.dataset.nrDismiss }); });
  box.querySelectorAll("[data-nr-seen]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/nextround/seen", { key: b.dataset.nrSeen }); });
  box.querySelectorAll("[data-nr-unseen]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/nextround/seen", { key: b.dataset.nrUnseen, seen: false }); });
}

// ---------------------------------------------------------------------------
// Needs attention area (pending suggestions + orphans)
//
// Dismissal is keyed to exactly which items are showing, not to a boolean.
// A plain "hidden" flag would mean a suggestion that lands tomorrow stays
// invisible because the user dismissed a different one today, which is the same
// silent-miss failure the Action required banner exists to prevent.
const ATTENTION_DISMISS_KEY = "internshiphunt.attentionDismissed";

function attentionSignature(pending, orphans) {
  return [...pending.map((s) => s.id), ...orphans.map((o) => o.id)].sort().join(",");
}

function renderAttention() {
  const box = $("#attention");
  // Action items are already shown, better, in the banner above, and
  // next-round suggestions in the Moving forward strip. Repeating them here
  // just buries the ordinary suggestions under a wall of raw evidence. Hide
  // an item here only while one of those surfaces is actually showing it.
  const shownInBanner = new Set(bannerKeys);
  const shownInStrip = new Set(nextRoundShownIds);
  const suppressed = (x) => (parseAction(x.evidence) && shownInBanner.has(x.posting_key)) || shownInStrip.has(x.id);
  const pending = view.pending.filter((s) => !suppressed(s));
  const orphans = view.orphans.filter((o) => !suppressed(o));
  if (pending.length === 0 && orphans.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  // Dismissing hides the CURRENT set only. The moment a new suggestion or
  // orphan arrives the signature changes and the panel comes back on its own,
  // so dismissing can never silently swallow something that arrives later.
  if (localStorage.getItem(ATTENTION_DISMISS_KEY) === attentionSignature(pending, orphans)) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");

  const total = pending.length + orphans.length;
  const parts = [];
  // A big pile collapses to one line so the postings stay near the top of the
  // page; a small pile just shows itself.
  const collapsed = total > 3 && !attnExpanded;
  parts.push(`<h3>Needs attention (${total})
    ${collapsed ? `<button class="small attention-expand" id="attention-expand">Show all</button>` : total > 3 ? `<button class="small attention-expand" id="attention-collapse">Collapse</button>` : ""}
    <button class="attention-dismiss" id="attention-dismiss" title="Hide these until something new arrives">Dismiss all</button></h3>`);

  const trimEvidence = (t) => {
    const s = String(t || "");
    return s.length > 170 ? `<span title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 170))}...</span>` : escapeHtml(s);
  };

  if (!collapsed) {
    const closedCount = pending.filter((s) => s.suggested_status === "closed").length;
    for (const s of pending) {
      const p = view.postings.find((x) => x.key === s.posting_key);
      const label = p ? `${p.company}: ${p.role}` : s.posting_key;
      parts.push(`<div class="suggestion">
        <span><strong>${escapeHtml(label)}</strong> suggested <strong>${escapeHtml(statusLabel(s.suggested_status))}</strong></span>
        <span class="evidence">${trimEvidence(s.evidence)}</span>
        <button class="primary" data-confirm="${escapeHtml(s.id)}">Confirm</button>
        <button class="small" data-dismiss="${escapeHtml(s.id)}">Dismiss</button>
      </div>`);
    }
    if (closedCount > 1) {
      parts.push(`<div class="suggestion"><button class="small" id="bulk-closed">Confirm all ${closedCount} closed suggestions</button></div>`);
    }
    for (const o of orphans) {
      parts.push(`<div class="suggestion">
        <span class="orphan-note">You appear to have applied to <code>${escapeHtml(o.posting_key)}</code> (${trimEvidence(o.evidence)}), but that posting is not in the tracker yet.</span>
        <button class="primary" data-orphan-add="${escapeHtml(o.id)}">Add this posting</button>
        <button class="small" data-dismiss="${escapeHtml(o.id)}">Dismiss</button>
      </div>`);
    }
  } else {
    const bits = [];
    if (pending.length) bits.push(`${pending.length} suggestion${pending.length > 1 ? "s" : ""} to confirm`);
    if (orphans.length) bits.push(`${orphans.length} application${orphans.length > 1 ? "s" : ""} waiting for their postings`);
    parts.push(`<div class="suggestion"><span class="evidence">${bits.join(", ")}.</span></div>`);
  }

  box.innerHTML = parts.join("");
  const expand = $("#attention-expand");
  if (expand) expand.onclick = () => { attnExpanded = true; renderAttention(); };
  const collapse = $("#attention-collapse");
  if (collapse) collapse.onclick = () => { attnExpanded = false; renderAttention(); };
  $("#attention-dismiss").onclick = () => {
    localStorage.setItem(ATTENTION_DISMISS_KEY, attentionSignature(pending, orphans));
    renderAttention();
    renderHeader();
  };
  box.querySelectorAll("[data-confirm]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/suggestion/confirm", { id: b.dataset.confirm }); });
  box.querySelectorAll("[data-dismiss]").forEach((b) => b.onclick = () => { b.disabled = true; post("/api/suggestion/dismiss", { id: b.dataset.dismiss }); });
  box.querySelectorAll("[data-orphan-add]").forEach((b) => b.onclick = () => {
    const o = view.orphans.find((x) => x.id === b.dataset.orphanAdd);
    if (o) openAddDialog({
      key: o.posting_key,
      status: o.suggested_status === "applied" ? "applied" : "interested",
      applied_date: o.suggested_applied_date || null,
      hint: `This fills the gap for ${o.posting_key}. Company, title, and link come from the posting or the email.`,
    });
  });
  const bulk = $("#bulk-closed");
  if (bulk) bulk.onclick = () => post("/api/suggestion/bulk-confirm-closed");
}

// ---------------------------------------------------------------------------
// Coming up strip: deadlines inside 14 days, follow-ups due, and postings
// The user opened to apply to but never marked. The things that rot silently.
// ---------------------------------------------------------------------------
const OPENED_KEY = "internshiphunt.openedToApply";

function openedToApply() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPENED_KEY));
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function markOpened(key) {
  const map = openedToApply();
  map[key] = new Date().toISOString();
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

function clearOpened(key) {
  const map = openedToApply();
  delete map[key];
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

function renderUpcoming() {
  const box = $("#upcoming");
  const rows = [];
  const today = todayNY();

  // Deadlines within 14 days on postings the user has not applied to or closed.
  const OPEN_STATUSES = ["new", "interested"];
  for (const p of view.postings) {
    if (p.hidden || !p.deadline || !OPEN_STATUSES.includes(p.status)) continue;
    const d = daysUntil(p.deadline);
    if (d === null || d > 14) continue;
    rows.push({
      sort: d,
      when: d < 0 ? `${Math.abs(d)}d past due` : d === 0 ? "due today" : `${d}d left`,
      overdue: d < 0,
      key: p.key,
      label: `${p.company}: ${p.role}`,
      kind: `closes ${p.deadline}`,
      // Keyed to the deadline date itself, so removing this row does not mute
      // the posting: if the employer moves the closing date, it comes back.
      id: noticeId("upcoming", p.key, `deadline|${p.deadline}`),
    });
  }
  // Follow-ups the user scheduled that are due.
  for (const p of view.postings) {
    if (p.hidden || !p.next_followup) continue;
    if (["rejected", "withdrawn", "closed"].includes(p.status)) continue;
    if (p.next_followup > today) continue;
    const d = daysUntil(p.next_followup);
    rows.push({
      sort: d === null ? 0 : d,
      when: d < 0 ? `${Math.abs(d)}d overdue` : "follow up today",
      overdue: d < 0,
      key: p.key,
      label: `${p.company}: ${p.role}`,
      kind: "your follow-up reminder",
      // Keyed to the date he set. Pick a new follow-up date and the reminder
      // is a new row again; removing this one only clears this one.
      id: noticeId("upcoming", p.key, `followup|${p.next_followup}`),
      followup: true,
    });
  }
  // Opened to apply, then never marked. Only recent ones (36 hours).
  const opened = openedToApply();
  for (const [key, at] of Object.entries(opened)) {
    const p = view.postings.find((x) => x.key === key);
    const age = Date.now() - Date.parse(at);
    if (!p || p.hidden || !isFinite(age) || age > 36 * 3600 * 1000 ||
        !["new", "interested"].includes(p.status)) {
      clearOpened(key);
      continue;
    }
    rows.push({
      sort: -0.5,
      when: "opened to apply",
      overdue: false,
      key,
      label: `${p.company}: ${p.role}`,
      kind: `opened ${formatWhen(at)}. Did you finish applying?`,
      openedExtra: true,
    });
  }

  // Rows the user removed by hand are gone, not greyed out. The ids are tied to
  // the deadline or follow-up date behind the row, so this never mutes the
  // posting: change the date and the reminder is a new row again.
  const shown = rows.filter((r) => !(r.id && isNoticeDismissed(r.id)));

  if (shown.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  shown.sort((a, b) => a.sort - b.sort);
  const parts = [`<h3>Coming up</h3>`];
  for (const r of shown.slice(0, 8)) {
    parts.push(`<div class="up-row">
      <span class="up-when${r.overdue ? " overdue" : ""}">${escapeHtml(r.when)}</span>
      <a href="#" data-open="${escapeHtml(r.key)}"><strong>${escapeHtml(r.label)}</strong></a>
      <span class="up-kind">${escapeHtml(r.kind)}</span>
      ${r.openedExtra ? `<button class="small" data-mark-applied="${escapeHtml(r.key)}">Mark applied</button><button class="small" data-opened-clear="${escapeHtml(r.key)}">Not yet</button>` : ""}
      ${r.id ? `<button class="small remove" data-up-remove="${escapeHtml(r.id)}" title="Take this row off the list. The posting and its dates are unchanged.">Remove</button>` : ""}
    </div>`);
  }
  if (shown.length > 8) parts.push(`<div class="up-kind">and ${shown.length - 8} more</div>`);
  box.innerHTML = parts.join("");
  box.classList.remove("hidden");
  box.querySelectorAll("[data-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openDetail(a.dataset.open); });
  box.querySelectorAll("[data-mark-applied]").forEach((b) => b.onclick = () => {
    const p = view.postings.find((x) => x.key === b.dataset.markApplied);
    if (p) { clearOpened(p.key); openApplyDialog(p); }
  });
  box.querySelectorAll("[data-opened-clear]").forEach((b) => b.onclick = () => { clearOpened(b.dataset.openedClear); render(); });
  // Remove hides this one reminder and nothing else. The follow-up date and
  // the posting's deadline stay exactly as they are, so the Postings tab and
  // the detail panel still tell the truth about the job.
  box.querySelectorAll("[data-up-remove]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const r = shown.find((x) => x.id === b.dataset.upRemove);
    if (!r) return;
    await removeNotice({ id: r.id, kind: "upcoming", key: r.key, label: r.label });
  });
}

// ---------------------------------------------------------------------------
// Postings tab
// ---------------------------------------------------------------------------
const IN_PROGRESS = ["applied", "oa", "interview", "offer"];
const ARCHIVED_STATUSES = ["rejected", "withdrawn", "closed"];

// Filter persistence: the dropdowns and toggles survive a reload; the free
// text search deliberately does not (a stale search is invisible confusion).
const FILTERS_KEY = "internshiphunt.filters";

function saveFilters() {
  const f = {
    category: $("#f-category").value,
    status: $("#f-status").value,
    rank: $("#f-rank").value,
    source: $("#f-source").value,
    sort: $("#f-sort").value,
    showHidden: $("#f-hidden").checked,
  };
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* private mode */ }
}

function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (!f) return;
    if (f.category !== undefined) $("#f-category").value = f.category;
    if (f.status !== undefined) $("#f-status").value = f.status;
    if (f.rank !== undefined) $("#f-rank").value = f.rank;
    if (f.sort !== undefined) $("#f-sort").value = f.sort;
    if (f.showHidden !== undefined) $("#f-hidden").checked = !!f.showHidden;
    // f-source options are rebuilt from data; remember the wish and let
    // updateSourceOptions apply it once the options exist.
    pendingSourceValue = f.source || "";
  } catch { /* ignore */ }
}
let pendingSourceValue = null;

function currentFilters() {
  return {
    search: $("#f-search").value.trim().toLowerCase(),
    category: $("#f-category").value,
    status: $("#f-status").value,
    rank: $("#f-rank").value,
    source: $("#f-source").value,
    sort: $("#f-sort").value,
    showHidden: $("#f-hidden").checked,
  };
}

function anyFilterActive(f) {
  return !!(f.search || f.category || f.status || f.rank || f.source);
}

function clearFilters() {
  $("#f-search").value = "";
  $("#f-category").value = "";
  $("#f-status").value = "";
  $("#f-rank").value = "";
  $("#f-source").value = "";
  saveFilters();
  renderPostings(true);
}

// Every term must match somewhere: "wells charlotte" finds the Wells Fargo
// Charlotte posting instead of nothing.
function matchesFilters(p, f) {
  if (f.category && p.category !== f.category) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.rank && String(p.se_rank) !== f.rank) return false;
  if (f.source && p.source !== f.source) return false;
  if (f.search) {
    const hay = [p.company, p.division, p.role, p.notes, p.user_notes,
      p.req_id, p.key, p.portal_email, p.portal_note, p.contact_referral,
      (p.locations || []).join(" ")]
      .filter(Boolean).join(" ").toLowerCase();
    for (const term of f.search.split(/\s+/)) {
      if (term && !hay.includes(term)) return false;
    }
  }
  return true;
}

// Which groups the user has collapsed. Kept in localStorage rather than in a
// variable because the postings tab redraws, and kept out of the DOM for the
// same reason.
const COLLAPSE_KEY = "internshiphunt.collapsedGroups";

function collapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function setGroupCollapsed(title, isCollapsed) {
  const set = collapsedGroups();
  if (isCollapsed) set.add(title); else set.delete(title);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

// Sort within a group. "fit": se_rank, then deadline, then newest.
function groupSort(sortMode) {
  return (a, b) => {
    if (sortMode === "deadline") {
      if (a.deadline !== b.deadline) {
        if (a.deadline === null) return 1;
        if (b.deadline === null) return -1;
        return a.deadline < b.deadline ? -1 : 1;
      }
      return a.se_rank - b.se_rank;
    }
    if (sortMode === "newest") {
      if (a.first_seen !== b.first_seen) return a.first_seen > b.first_seen ? -1 : 1;
      return a.se_rank - b.se_rank;
    }
    if (sortMode === "company") {
      const c = a.company.localeCompare(b.company);
      if (c !== 0) return c;
      return a.role.localeCompare(b.role);
    }
    // "fit", the default
    if (a.se_rank !== b.se_rank) return a.se_rank - b.se_rank;
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    if (a.first_seen !== b.first_seen) return a.first_seen > b.first_seen ? -1 : 1;
    return a.company.localeCompare(b.company);
  };
}

// Skip the whole DOM rebuild when nothing visible changed: rebuilding every
// 3 seconds wipes text selection, closes open dropdowns, and can swallow the
// click the user is halfway through.
let lastPostingsSig = "";

function renderPostings(force = false) {
  const f = currentFilters();
  updateSourceOptions();

  // Expire stale triage holds.
  for (const [key, t] of [...recentTriage]) {
    if (Date.now() - t.at > TRIAGE_HOLD_MS) recentTriage.delete(key);
  }

  const sig = JSON.stringify([view.postings, f, [...collapsedGroups()], [...recentTriage.keys()], openedToApply()]);
  if (!force && sig === lastPostingsSig) return;
  lastPostingsSig = sig;

  const groups = { new: [], interested: [], reposts: [], progress: [], archived: [] };
  const groupOf = (p, status, hidden) => {
    if (hidden) return f.showHidden ? "archived" : null;
    if (ARCHIVED_STATUSES.includes(status)) return "archived";
    if (IN_PROGRESS.includes(status)) return "progress";
    if (p.possible_repost_of && status === "new") return "reposts";
    if (status === "interested") return "interested";
    return "new";
  };

  let hiddenMatches = 0;
  for (const p of view.postings) {
    if (!matchesFilters(p, f)) continue;
    if (p.hidden && !f.showHidden && !recentTriage.has(p.key)) {
      if (f.search) hiddenMatches++;
      continue;
    }
    // A freshly triaged posting renders where it WAS, muted, with an Undo,
    // so the list does not shuffle under the cursor mid-run.
    const t = recentTriage.get(p.key);
    if (t) {
      const expected = t.action === "hidden" ? p.hidden : p.status === "interested";
      if (!expected) { recentTriage.delete(p.key); }
    }
    const held = recentTriage.get(p.key);
    const g = held
      ? groupOf(p, held.prevStatus, false)
      : groupOf(p, p.status, p.hidden);
    if (g) groups[g].push(p);
  }
  for (const k of Object.keys(groups)) groups[k].sort(groupSort(f.sort));

  const box = $("#groups");
  box.innerHTML = "";
  // Pipeline order, most committed first: the applications the user is actually
  // running sit on top, the weekly triage pile below the shortlist.
  const defs = [
    ["In progress", groups.progress],
    ["Interested", groups.interested],
    ["New", groups.new],
    ["Possible reposts", groups.reposts],
    ["Archived", groups.archived],
  ];
  const collapsed = collapsedGroups();
  let any = false;
  for (const [title, list] of defs) {
    // The applied group always renders, even when empty: an empty pipeline is
    // exactly when the user most needs the pointer to the email rescan below.
    const isApplied = title === "In progress";
    if (list.length === 0 && !isApplied) continue;
    if (list.length > 0) any = true;
    const realCount = list.filter((p) => !recentTriage.has(p.key)).length;
    const isShut = collapsed.has(title);
    const div = document.createElement("div");
    div.className = "group" + (isShut ? " collapsed" : "");
    div.innerHTML = `<h2><button class="group-toggle" aria-expanded="${!isShut}">
        <span class="caret">${isShut ? "▸" : "▾"}</span>
        <span>${title}</span> <span class="group-count">${realCount}</span>
      </button></h2><div class="group-body"></div>`;
    const body = div.querySelector(".group-body");
    if (isShut) body.classList.add("hidden");
    if (list.length === 0) {
      body.innerHTML = `<div class="empty-note">Nothing in progress yet. If you have applied somewhere and it is not showing here, use "Rescan email for applications" in the Research and scans panel at the bottom of this page.</div>`;
    } else {
      for (const p of list) body.appendChild(postingRow(p, title));
    }
    div.querySelector(".group-toggle").onclick = () => {
      setGroupCollapsed(title, !collapsedGroups().has(title));
      renderPostings(true);
    };
    box.appendChild(div);
  }

  // Count line: how much of the universe the current filters are showing.
  const shown = Object.values(groups).reduce((n, l) => n + l.length, 0);
  $("#filter-count").textContent = anyFilterActive(f) ? `Showing ${shown} of ${view.postings.length}` : "";

  if (!any) {
    const note = document.createElement("div");
    note.className = "group";
    const filtered = anyFilterActive(f);
    note.innerHTML = `<div class="group-body"><div class="empty-note">${
      filtered
        ? `No postings match these filters.<button class="small" id="clear-filters">Clear filters</button>`
        : "No postings yet. When the weekly researcher delivers its first findings, they will appear here."
    }</div></div>`;
    box.prepend(note);
    const cf = note.querySelector("#clear-filters");
    if (cf) cf.onclick = clearFilters;
  }

  if (hiddenMatches > 0) {
    const note = document.createElement("div");
    note.className = "group";
    note.innerHTML = `<div class="group-body"><div class="empty-note">${hiddenMatches} hidden posting${hiddenMatches > 1 ? "s" : ""} also match${hiddenMatches > 1 ? "" : "es"} your search.<button class="small" id="show-hidden-hint">Show hidden</button></div></div>`;
    box.appendChild(note);
    note.querySelector("#show-hidden-hint").onclick = () => {
      $("#f-hidden").checked = true;
      saveFilters();
      renderPostings(true);
    };
  }
}

// The email-rescan button in the Research and scans panel. It shares the
// one-run-at-a-time guard with "Find more opportunities", so whichever is
// running disables both. A server message from the last press (the refusal
// explanation is the whole point of the refusal) shows in the note briefly.
let rescanMsg = null; // { text, at }

async function startRescan() {
  const btn = $("#rescan-email");
  btn.disabled = true;
  let msg = null;
  try {
    const res = await fetch("/api/research/rescan-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok || res.status === 202) msg = (await res.json()).error;
  } catch {
    msg = "Could not reach the app server. Is it still running?";
  }
  rescanMsg = msg ? { text: msg, at: Date.now() } : null;
  await refresh();
}

// Rebuild the source dropdown only when the set of sources actually changed,
// so the poll cannot slam it shut while the user has it open.
let lastSourceOptions = "";

function updateSourceOptions() {
  const sel = $("#f-source");
  const sources = [...new Set(view.postings.map((p) => p.source))].sort();
  const sig = sources.join("|");
  if (sig === lastSourceOptions && pendingSourceValue === null) return;
  lastSourceOptions = sig;
  const current = pendingSourceValue !== null ? pendingSourceValue : sel.value;
  pendingSourceValue = null;
  sel.innerHTML = '<option value="">All sources</option>' +
    sources.map((s) => `<option${s === current ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
}

// The next sensible stages from each in-progress status, for one-click
// advancing without opening the detail panel.
const STAGE_NEXT = {
  applied: [["oa", "Got assessment"], ["interview", "Got interview"], ["rejected", "Rejected"]],
  oa: [["interview", "Got interview"], ["rejected", "Rejected"]],
  interview: [["offer", "Got offer"], ["rejected", "Rejected"]],
  offer: [],
};

function postingRow(p, groupTitle) {
  const row = document.createElement("div");
  row.className = "row";
  const held = recentTriage.get(p.key);
  if (held) row.classList.add("triaged");

  const rankLabel = `${p.se_rank} ${rankName(p.se_rank)}`;
  const chips = [
    `<span class="chip cat cat-c${catColor(p.category)}">${escapeHtml(p.category)}</span>`,
    `<span class="chip rank${p.se_rank}">${rankLabel}</span>`,
  ];
  const locs = p.locations || [];
  if (locs.length) {
    const shown = locs[0] + (locs.length > 1 ? ` +${locs.length - 1}` : "");
    chips.push(`<span class="chip" title="${escapeHtml(locs.join(" / "))}">${escapeHtml(shown)}</span>`);
  }
  chips.push(`<span class="chip">${escapeHtml(p.source)}</span>`);
  if (groupTitle === "In progress") chips.push(`<span class="chip stage">${escapeHtml(statusLabel(p.status))}</span>`);
  if (groupTitle === "Archived") {
    const auto = p.status === "closed" && p.status_actor === "auto-closed";
    chips.push(`<span class="chip">${p.hidden ? "hidden" : auto ? "closed automatically" : escapeHtml(statusLabel(p.status))}</span>`);
  }

  let repostNote = "";
  if (groupTitle === "Possible reposts") {
    const orig = view.postings.find((x) => x.key === p.possible_repost_of);
    repostNote = orig
      ? `<div class="repost-link">Possible repost of: ${escapeHtml(orig.company)}, ${escapeHtml(orig.role)} <a href="#" data-open="${escapeHtml(orig.key)}">view original</a></div>`
      : `<div class="repost-link">References an unknown posting (<code>${escapeHtml(p.possible_repost_of)}</code>); the original has not been ingested.</div>`;
  }

  // The deadline column: one fixed place for the eye to sweep.
  const d = p.deadline ? daysUntil(p.deadline) : null;
  const dueCls = d === null ? "" : d < 0 ? " due-past" : d <= 14 ? " due-soon" : "";
  const dueHtml = p.deadline
    ? `<span class="due-date">${escapeHtml(p.deadline)}</span>${d === null ? "" : d < 0 ? `${Math.abs(d)}d past` : d === 0 ? "today" : `${d}d left`}`
    : `<span class="due-date">rolling</span>`;

  row.innerHTML = `
    <div class="main-col">
      <span class="company">${escapeHtml(p.company)}</span>
      <span class="role">${escapeHtml(p.role)}</span>
      <div class="meta">${chips.join("")}</div>
      ${repostNote}
    </div>
    <div class="due-col${dueCls}">${dueHtml}</div>
    <div class="actions"></div>`;

  // Rows stay clean: all the action buttons live in the detail panel that
  // opens on click (The user's request). The one exception is Undo on a row he
  // just triaged, which only exists because of that action.
  const actions = row.querySelector(".actions");
  if (held) {
    const note = document.createElement("span");
    note.className = "triaged-note";
    note.textContent = held.action === "hidden" ? "Hidden" : "Marked interested";
    actions.appendChild(note);
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = "Undo";
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      recentTriage.delete(p.key);
      if (held.action === "hidden") await post("/api/posting/hidden", { key: p.key, hidden: false });
      else await post("/api/posting/status", { key: p.key, status: held.prevStatus });
    };
    actions.appendChild(b);
    row.onclick = null;
    return row;
  }

  const chev = document.createElement("span");
  chev.className = "chevron";
  chev.textContent = "›";
  actions.appendChild(chev);

  row.onclick = () => openDetail(p.key);
  row.querySelectorAll("[data-open]").forEach((a) => a.onclick = (e) => {
    e.preventDefault(); e.stopPropagation(); openDetail(a.dataset.open);
  });
  return row;
}

// ---------------------------------------------------------------------------
// Apply dialog: pressing an Applied button opens this small form so the user
// can set the date, the portal email that autofilled, a portal note, and
// free notes in ONE step, because those facts only exist during the apply.
// ---------------------------------------------------------------------------
// Suggestions for the portal email field: the addresses in
// profile/preferences.json.
function portalEmails() {
  return (view && view.prefs && view.prefs.email_addresses) || [];
}

function closeModal() {
  $("#apply-modal").classList.add("hidden");
  $("#apply-backdrop").classList.add("hidden");
  modalDirty = false;
}

function modalBackdropClose() {
  if (modalDirty && !confirm("Discard what you typed here?")) return;
  closeModal();
}

function watchModalDirty() {
  modalDirty = false;
  $("#apply-modal").querySelectorAll("input, textarea, select").forEach((el) => {
    el.addEventListener("input", () => { modalDirty = true; });
  });
}

function openApplyDialog(p) {
  const modal = $("#apply-modal");
  const backdrop = $("#apply-backdrop");
  const today = todayNY();
  modal.innerHTML = `
    <h3>Mark as applied</h3>
    <div class="apply-sub">${escapeHtml(p.company)}: ${escapeHtml(p.role)}</div>
    <label>Applied on
      <input id="ap-date" type="date" value="${escapeHtml(p.applied_date || today)}">
    </label>
    <label>Portal email (which address the portal used)
      <input id="ap-portal-email" list="portal-emails" value="${escapeHtml(p.portal_email || "")}">
      <datalist id="portal-emails">${portalEmails().map((e) => `<option value="${escapeHtml(e)}">`).join("")}</datalist>
    </label>
    <label>Portal note (password quirks, SSO, anything odd)
      <input id="ap-portal-note" value="${escapeHtml(p.portal_note || "")}" placeholder="e.g. forced a different password">
    </label>
    <label>Notes (optional)
      <textarea id="ap-notes" rows="3" placeholder="Resume version used, who referred you, anything future you will want to know...">${escapeHtml(p.user_notes || "")}</textarea>
    </label>
    <div class="apply-actions">
      <span class="form-error hidden" id="ap-error"></span>
      <button class="small" id="ap-cancel">Cancel</button>
      <button class="primary" id="ap-save">Save</button>
    </div>`;
  modal.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  watchModalDirty();

  backdrop.onclick = modalBackdropClose;
  $("#ap-cancel").onclick = closeModal;
  $("#ap-save").onclick = async () => {
    const date = $("#ap-date").value || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = $("#ap-error");
      err.textContent = "Pick a date.";
      err.classList.remove("hidden");
      return;
    }
    const fields = {};
    const notes = $("#ap-notes").value.trim();
    const pe = $("#ap-portal-email").value.trim();
    const pn = $("#ap-portal-note").value.trim();
    if (notes !== (p.user_notes || "")) fields.user_notes = notes || null;
    if (pe !== (p.portal_email || "")) fields.portal_email = pe || null;
    if (pn !== (p.portal_note || "")) fields.portal_note = pn || null;
    closeModal();
    clearOpened(p.key);
    await post("/api/posting/status", { key: p.key, status: "applied", applied_date: date });
    if (Object.keys(fields).length > 0) {
      await post("/api/posting/edit", { key: p.key, fields });
    }
  };
  $("#ap-date").focus();
}

// ---------------------------------------------------------------------------
// Add-posting dialog: for applications the user found himself. The server mints
// the key with the same algorithm the researcher uses, so a later delivery
// of the same job merges instead of duplicating. When opened from an orphan
// suggestion, the orphan's own key rides along and the waiting suggestion
// attaches the moment the posting exists.
// ---------------------------------------------------------------------------
// Add an action the user heard about somewhere the weekly scan cannot reach: a
// text message, a phone call, a recruiter in person. Everything after this
// point is identical to a delivered action, because it writes into the same
// actionEvidence map the banner reads.
function openAddActionDialog(prefillKey = null) {
  const modal = $("#apply-modal");
  const backdrop = $("#apply-backdrop");

  // Only postings he can actually act on. Hidden ones are hidden for a reason,
  // and a closed or rejected posting almost never has a live action on it.
  const choices = view.postings
    .filter((p) => !p.hidden && !["closed", "rejected", "withdrawn"].includes(p.status))
    .sort((a, b) => a.company.localeCompare(b.company) || a.role.localeCompare(b.role));

  if (choices.length === 0) {
    showToast("There are no open postings to attach an action to yet.");
    return;
  }

  modal.innerHTML = `
    <h3>Add an action required</h3>
    <div class="apply-sub">For something you heard by text, phone, or in person. The weekly scan only reads email, so it will never find these on its own.</div>
    <label>Which posting *
      <select id="aa-key">
        <option value="">Choose...</option>
        ${choices.map((p) => `<option value="${escapeHtml(p.key)}"${p.key === prefillKey ? " selected" : ""}>${escapeHtml(p.company)}: ${escapeHtml(p.role)}</option>`).join("")}
      </select>
    </label>
    <label>What do you need to do? *
      <input id="aa-what" placeholder="e.g. Complete the HireVue for the Acme internship" maxlength="300">
    </label>
    <label>Due date (leave empty if none was given)
      <input id="aa-due" type="date">
    </label>
    <label>Where did this come from? (optional)
      <textarea id="aa-note" rows="2" maxlength="500" placeholder="e.g. Text from a 704 number on Aug 24 saying I moved forward"></textarea>
    </label>
    <div class="apply-actions">
      <span class="form-error hidden" id="aa-error"></span>
      <button class="small" id="aa-cancel">Cancel</button>
      <button class="primary" id="aa-save">Add to the banner</button>
    </div>`;
  modal.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  watchModalDirty();

  backdrop.onclick = modalBackdropClose;
  $("#aa-cancel").onclick = closeModal;
  $("#aa-save").onclick = async () => {
    const save = $("#aa-save");
    save.disabled = true;
    let result = null;
    try {
      const res = await fetch("/api/action/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: $("#aa-key").value,
          what: $("#aa-what").value,
          due: $("#aa-due").value || null,
          note: $("#aa-note").value,
        }),
      });
      result = await res.json();
    } catch {
      result = { error: "Could not reach the app. Is it still running?" };
    }
    if (result && result.error) {
      const err = $("#aa-error");
      err.textContent = result.error;
      err.classList.remove("hidden");
      save.disabled = false;
      return;
    }
    modalDirty = false;
    closeModal();
    await refresh();
    showToast("Added to Action required.", "info");
  };
}

function openAddDialog(prefill = {}) {
  const modal = $("#apply-modal");
  const backdrop = $("#apply-backdrop");
  const today = todayNY();
  const cats = (view && view.prefs && view.prefs.categories) || [];
  const startStatus = prefill.status || "interested";
  modal.innerHTML = `
    <h3>Add a posting</h3>
    <div class="apply-sub">${prefill.hint ? escapeHtml(prefill.hint) : "For a job you found yourself. Fields marked * are required."}</div>
    <label>Company *
      <input id="ad-company" placeholder="e.g. Acme Corp" value="${escapeHtml(prefill.company || "")}">
    </label>
    <label>Title / role *
      <input id="ad-role" placeholder="e.g. Summer Analyst Intern" value="${escapeHtml(prefill.role || "")}">
    </label>
    <label>Link to the posting *
      <input id="ad-url" type="url" placeholder="https://...">
    </label>
    <label>Category *
      <select id="ad-category">
        <option value="">Choose...</option>
        ${cats.map((c) => `<option>${c}</option>`).join("")}
      </select>
    </label>
    <label>Locations (separate several with semicolons)
      <input id="ad-locations" placeholder="e.g. Tampa, FL; Charlotte, NC">
    </label>
    <label>Deadline (leave empty if rolling or unknown)
      <input id="ad-deadline" type="date">
    </label>
    <label>Starting status
      <select id="ad-status">
        <option value="new"${startStatus === "new" ? " selected" : ""}>New (just tracking it)</option>
        <option value="interested"${startStatus === "interested" ? " selected" : ""}>Interested</option>
        <option value="applied"${startStatus === "applied" ? " selected" : ""}>Applied already</option>
      </select>
    </label>
    <label id="ad-date-row" class="${startStatus === "applied" ? "" : "hidden"}">Applied on
      <input id="ad-date" type="date" value="${escapeHtml(prefill.applied_date || today)}">
    </label>
    <label>Notes (optional)
      <textarea id="ad-notes" rows="3" placeholder="Anything worth remembering about this one..."></textarea>
    </label>
    <div class="apply-actions">
      <span class="form-error hidden" id="ad-error"></span>
      <button class="small" id="ad-cancel">Cancel</button>
      <button class="primary" id="ad-save">Add posting</button>
    </div>`;
  modal.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  watchModalDirty();

  backdrop.onclick = modalBackdropClose;
  $("#ad-cancel").onclick = closeModal;
  $("#ad-status").onchange = () => {
    $("#ad-date-row").classList.toggle("hidden", $("#ad-status").value !== "applied");
  };
  $("#ad-save").onclick = async () => {
    const body = {
      company: $("#ad-company").value,
      role: $("#ad-role").value,
      posting_url: $("#ad-url").value,
      category: $("#ad-category").value,
      locations: $("#ad-locations").value.split(";").map((s) => s.trim()).filter(Boolean),
      deadline: $("#ad-deadline").value || null,
      status: $("#ad-status").value,
      applied_date: $("#ad-date").value || today,
      user_notes: $("#ad-notes").value,
    };
    if (prefill.key) body.key = prefill.key;
    const save = $("#ad-save");
    save.disabled = true;
    let result = null;
    try {
      const res = await fetch("/api/posting/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      result = await res.json();
    } catch {
      result = { error: "Could not reach the app. Is it still running?" };
    }
    if (result && result.error) {
      const err = $("#ad-error");
      err.textContent = result.error;
      err.classList.remove("hidden");
      save.disabled = false;
      return;
    }
    closeModal();
    await refresh();
  };
  $("#ad-company").focus();
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
function openDetail(key) {
  openDetailKey = key;
  renderDetail();
}

function closeDetail(force = false) {
  if (!force && detailDirty && !confirm("Discard your edits?")) return;
  openDetailKey = null;
  detailDirty = false;
  $("#detail").classList.add("hidden");
  $("#detail-backdrop").classList.add("hidden");
}

function renderDetail() {
  const p = view.postings.find((x) => x.key === openDetailKey);
  const panel = $("#detail");
  if (!p) { closeDetail(true); return; }
  detailDirty = false;
  panel.classList.remove("hidden");
  $("#detail-backdrop").classList.remove("hidden");

  const dl = [
    ["Status", statusLabel(p.status) + (p.hidden ? " (hidden)" : "") + (p.status_actor === "auto-closed" ? ", closed automatically" : "")],
    ["Applied date", p.applied_date],
    ["Last status change", p.status_updated ? formatWhen(p.status_updated) : null],
    ["Category", p.category],
    ["Division", p.division],
    ["Locations", (p.locations || []).join("; ")],
    ["Region rank", `${p.se_rank} (${rankName(p.se_rank)})`],
    ["Deadline", p.deadline || "rolling / unknown"],
    ["Date posted", p.date_posted],
    ["First seen", p.first_seen],
    ["Source", p.source],
    ["ATS", p.ats + (p.tenant ? ` (${p.tenant})` : "")],
    ["Req ID", p.req_id],
    ["Key", p.key],
    ["Researcher notes", p.notes],
    ["Repost of", p.possible_repost_of],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const postingHref = safeUrl(p.posting_url);
  const applyHref = safeUrl(p.apply_url);
  panel.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(p.company)}</h2>
      <button class="small" id="detail-close">Close</button>
    </div>
    <div class="subtitle">${escapeHtml(p.role)}</div>
    ${postingHref ? `<a class="open-link" id="detail-open-posting" href="${escapeHtml(postingHref)}" target="_blank" rel="noopener">Open posting</a>` : `<div class="subtitle">No usable link on this posting.</div>`}
    ${applyHref ? `<a class="open-link" style="margin-left:8px" href="${escapeHtml(applyHref)}" target="_blank" rel="noopener">Apply link</a>` : ""}
    <div class="detail-actions" id="detail-actions"></div>
    <dl>${dl.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("")}</dl>
    <div class="edit-form">
      <label>Status
        <select id="d-status">
          ${["new", "interested", "applied", "oa", "interview", "offer", "rejected", "withdrawn", "closed"]
            .map((s) => `<option value="${s}"${s === p.status ? " selected" : ""}>${statusLabel(s)}</option>`).join("")}
        </select>
      </label>
      <label id="d-date-row" class="hidden">Applied on
        <input id="d-applied-date" type="date" value="${escapeHtml(p.applied_date || todayNY())}">
      </label>
      <label>Portal email <input id="d-portal_email" list="d-portal-emails" value="${escapeHtml(p.portal_email || "")}">
        <datalist id="d-portal-emails">${portalEmails().map((e) => `<option value="${escapeHtml(e)}">`).join("")}</datalist>
      </label>
      <label>Portal note (password quirks, SSO, etc.) <input id="d-portal_note" value="${escapeHtml(p.portal_note || "")}"></label>
      <label>Contact / referral <input id="d-contact_referral" value="${escapeHtml(p.contact_referral || "")}"></label>
      <label>Next follow-up <input id="d-next_followup" type="date" value="${escapeHtml(p.next_followup || "")}"></label>
      <label>Notes <textarea id="d-user_notes" rows="4">${escapeHtml(p.user_notes || "")}</textarea></label>
      <div class="form-actions">
        <button class="primary" id="d-save">Save</button>
        <button class="small" id="d-${p.hidden ? "unhide" : "hide"}">${p.hidden ? "Un-hide" : "Hide"}</button>
        <span class="form-error hidden" id="d-error"></span>
      </div>
    </div>`;

  // Any edit marks the panel dirty, so a stray backdrop click cannot eat it.
  panel.querySelectorAll("input, textarea, select").forEach((el) => {
    el.addEventListener("input", () => { detailDirty = true; });
  });
  const openLink = panel.querySelector("#detail-open-posting");
  if (openLink) openLink.onclick = () => { if (!IN_PROGRESS.includes(p.status)) markOpened(p.key); };

  // The status action buttons that used to crowd every row now live here.
  const actionsBar = panel.querySelector("#detail-actions");
  const act = (label, cls, fn, confirmText) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.onclick = async () => {
      if (confirmText && !confirm(confirmText)) return;
      b.disabled = true;
      try { await fn(); } finally { b.disabled = false; }
    };
    actionsBar.appendChild(b);
  };
  if (p.hidden) {
    act("Un-hide", "small", async () => {
      await post("/api/posting/hidden", { key: p.key, hidden: false });
      closeDetail(true);
    });
  } else if (IN_PROGRESS.includes(p.status)) {
    for (const [next, label] of STAGE_NEXT[p.status] || []) {
      act(label, "small", async () => {
        await post("/api/posting/status", { key: p.key, status: next });
        closeDetail(true);
      }, next === "rejected" ? `Mark ${p.company} as rejected?` : null);
    }
    act("Hide", "small", async () => {
      await post("/api/posting/hidden", { key: p.key, hidden: true });
      closeDetail(true);
    });
  } else {
    if (p.status !== "interested") {
      act("Interested", "small", async () => {
        recentTriage.set(p.key, { action: "interested", prevStatus: p.status, at: Date.now() });
        await post("/api/posting/status", { key: p.key, status: "interested" });
        closeDetail(true);
      });
    }
    act("Applied", "accent-outline", () => {
      closeDetail(true);
      openApplyDialog(p);
    });
    act("Hide", "small", async () => {
      recentTriage.set(p.key, { action: "hidden", prevStatus: p.status, at: Date.now() });
      await post("/api/posting/hidden", { key: p.key, hidden: true });
      closeDetail(true);
    });
  }

  // The applied-date field appears exactly when the chosen status needs one.
  const statusSel = $("#d-status");
  const syncDateRow = () => $("#d-date-row").classList.toggle("hidden", statusSel.value !== "applied");
  statusSel.addEventListener("change", syncDateRow);
  syncDateRow();

  $("#detail-close").onclick = () => closeDetail();
  $("#d-save").onclick = async () => {
    const newStatus = statusSel.value;
    if (newStatus !== p.status) {
      const body = { key: p.key, status: newStatus };
      if (newStatus === "applied") {
        const date = $("#d-applied-date").value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          const err = $("#d-error");
          err.textContent = "Pick an applied date.";
          err.classList.remove("hidden");
          return;
        }
        body.applied_date = date;
      }
      await post("/api/posting/status", body);
    }
    // Send only what changed; an untouched field can never overwrite anything.
    const fields = {};
    const read = (id) => $(id).value.trim();
    if (read("#d-portal_email") !== (p.portal_email || "")) fields.portal_email = read("#d-portal_email") || null;
    if (read("#d-portal_note") !== (p.portal_note || "")) fields.portal_note = read("#d-portal_note") || null;
    if (read("#d-contact_referral") !== (p.contact_referral || "")) fields.contact_referral = read("#d-contact_referral") || null;
    if (read("#d-next_followup") !== (p.next_followup || "")) fields.next_followup = read("#d-next_followup") || null;
    if ($("#d-user_notes").value !== (p.user_notes || "")) fields.user_notes = $("#d-user_notes").value || null;
    if (Object.keys(fields).length > 0) {
      await post("/api/posting/edit", { key: p.key, fields });
    }
    detailDirty = false;
    closeDetail(true);
  };
  const hideBtn = $("#d-hide") || $("#d-unhide");
  hideBtn.onclick = async () => {
    await post("/api/posting/hidden", { key: p.key, hidden: !p.hidden });
    closeDetail(true);
  };
}

// ---------------------------------------------------------------------------
// Reports tab (renderDocs also handles outreach-style drafts)
// ---------------------------------------------------------------------------

// Split an outreach draft into the researcher's notes and the sendable email
// (from the "Subject:" line down). Returns null when there is no Subject line.
function splitEmail(content) {
  const idx = content.search(/^Subject:/im);
  if (idx === -1) return null;
  const subjectLine = content.slice(idx).split("\n")[0];
  return {
    notes: content.slice(0, idx).trim(),
    subject: subjectLine.replace(/^Subject:\s*/i, "").trim(),
    body: content.slice(idx + subjectLine.length).trim(),
  };
}

let lastDocsSig = { outreach: "", reports: "" };

function renderDocs(kind, containerSel, isOutreach) {
  const docs = docsCache[kind];
  const box = $(containerSel);
  if (!docs) { box.innerHTML = ""; return; }

  // First sight of the list: open the newest, collapse the rest (reports).
  if (expandedDocs[kind] === null) {
    expandedDocs[kind] = new Set(docs.length && !isOutreach ? [docs[0].name] : docs.map((d) => d.name));
  }

  const sig = JSON.stringify([docs.map((d) => [d.name, d.mtime]), [...expandedDocs[kind]]]);
  if (sig === lastDocsSig[kind]) return;
  lastDocsSig[kind] = sig;

  if (docs.length === 0) {
    box.innerHTML = `<div class="doc"><div class="empty-note">Nothing here yet. The weekly researcher writes these files.</div></div>`;
    return;
  }
  box.innerHTML = "";
  for (const d of docs) {
    const card = document.createElement("div");
    card.className = "doc";
    const isOpen = expandedDocs[kind].has(d.name);
    const email = isOutreach ? splitEmail(d.content) : null;

    let bodyHtml = "";
    if (isOpen) {
      if (email) {
        bodyHtml = `<div class="markdown">${renderMarkdown(email.notes)}</div>
          <div class="email-block"><div class="markdown"><p><strong>Subject: ${escapeHtml(email.subject)}</strong></p>${renderMarkdown(email.body)}</div></div>`;
      } else {
        bodyHtml = `<div class="markdown">${renderMarkdown(d.content)}</div>`;
      }
    }

    card.innerHTML = `
      <div class="doc-head">
        <span class="doc-name">${escapeHtml(d.name)}</span>
        ${isOutreach && email ? '<button class="small copy-btn" data-what="subject">Copy subject</button><button class="small copy-btn" data-what="email">Copy email</button>' : isOutreach ? '<button class="small copy-btn" data-what="all">Copy to clipboard</button>' : ""}
        <button class="small doc-toggle">${isOpen ? "Collapse" : "Expand"}</button>
      </div>
      ${bodyHtml}`;

    card.querySelector(".doc-toggle").onclick = () => {
      if (expandedDocs[kind].has(d.name)) expandedDocs[kind].delete(d.name);
      else expandedDocs[kind].add(d.name);
      renderDocs(kind, containerSel, isOutreach);
    };
    card.querySelectorAll(".copy-btn").forEach((b) => {
      b.onclick = async (e) => {
        const what = b.dataset.what;
        const text = what === "subject" ? email.subject : what === "email" ? email.body : d.content;
        try {
          await navigator.clipboard.writeText(text);
          e.target.textContent = "Copied";
          setTimeout(() => { e.target.textContent = what === "subject" ? "Copy subject" : what === "email" ? "Copy email" : "Copy to clipboard"; }, 1500);
        } catch {
          e.target.textContent = "Copy failed";
        }
      };
    });
    box.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Log tab
// ---------------------------------------------------------------------------
function renderLog() {
  const errBox = $("#error-list");
  errBox.innerHTML = "";
  for (const e of view.errors) {
    const card = document.createElement("div");
    card.className = "error-card";
    card.innerHTML = `
      <div class="error-head">
        <span class="error-title">Failed delivery: ${escapeHtml(e.file)}</span>
        <button class="primary retry-btn">Retry</button>
        <button class="small clear-btn" title="Remove this marker if the delivery file itself is gone">Clear</button>
      </div>
      <pre>${escapeHtml(e.marker ? JSON.stringify(e.marker, null, 2) : "(marker file unreadable)")}</pre>`;
    card.querySelector(".retry-btn").onclick = () => post("/api/retry", { file: e.file });
    card.querySelector(".clear-btn").onclick = () => post("/api/error-marker/clear", { file: e.file });
    errBox.appendChild(card);
  }
  const q = ($("#log-search").value || "").trim().toLowerCase();
  const entries = view.log.filter((l) => !q || l.text.toLowerCase().includes(q));
  const logBox = $("#log-list");
  logBox.innerHTML = entries.map((l) => `
    <div class="log-entry kind-${escapeHtml(l.kind)}">
      <span class="log-time">${escapeHtml(formatWhen(l.at))}</span>
      <span class="log-text">${escapeHtml(l.text)}</span>
    </div>`).join("") || `<div class="empty-note">${q ? "Nothing in the log matches that." : "No activity yet."}</div>`;
}

// ---------------------------------------------------------------------------
// Research and scans panel: both scan buttons, their shared status line and
// live feed, and the standing note about what the weekly sweep covers.
// ---------------------------------------------------------------------------
function renderScans() {
  const r = view.research || {};
  const btn = $("#find-more");
  const status = $("#research-status");
  const stop = $("#research-stop");
  const feed = $("#research-feed");
  if (r.running) {
    btn.disabled = true;
    status.textContent = `Researcher running since ${formatWhen(r.startedAt)}. New postings will appear here when its delivery lands.`;
    status.className = "research-status running";
    stop.classList.remove("hidden");
  } else {
    btn.disabled = false;
    status.className = "research-status";
    status.textContent = r.lastExit ? `Last run ended ${formatWhen(r.lastExit.at)}. Check the Log tab for what it found.` : "";
    stop.classList.add("hidden");
  }

  // The email rescan: state comes from the server on every poll, so a queued
  // request survives reloads and shows the same way in every tab.
  const rescanBtn = $("#rescan-email");
  const note = $("#rescan-note");
  const queuedList = view.rescanQueued || [];
  const queued = queuedList.length > 0;
  rescanBtn.textContent = queued ? "Reopen rescan in Cowork" : "Rescan email for applications";
  rescanBtn.disabled = !!r.running;
  const freshMsg = rescanMsg && Date.now() - rescanMsg.at < 60000 ? rescanMsg.text : null;
  const queuedSince = queued && queuedList[0].at ? ` Queued since ${formatWhen(queuedList[0].at)}.` : "";
  note.textContent = freshMsg
    ? freshMsg
    : r.running
      ? "A run is already going. This becomes available when it finishes."
      : queued
        ? `Queued and waiting for Cowork.${queuedSince} Press this again to reopen Cowork with the rescan ready, or leave it and the weekly sweep will pick it up.`
        : "Opens Cowork with the rescan ready to send, since your Gmail connector lives there. It reads every email address in your preferences for applications this tracker does not have, for emails saying you moved to the next round, and for any assessment or interview waiting on you. Findings arrive as suggestions you confirm. Assessment links are reported, never opened.";
  note.classList.toggle("blocked", !!freshMsg || queued);

  // Standing note: the weekly sweep already does everything on this panel.
  const standing = $("#scan-standing");
  const f = view.freshness || {};
  const lastWeekly = f.ever && f.lastDeliveryId && f.lastDeliveryId.includes("-weekly-")
    ? ` Its last delivery arrived ${formatWhen(f.lastProducedAt)}.`
    : "";
  standing.textContent = `The weekly sweep does all of this automatically: new postings, your email for new applications and next-round updates, and anything an employer is waiting on you to do.${lastWeekly}`;
  // Live activity feed: what the researcher is doing right now, newest last.
  const lines = r.progress || [];
  if (lines.length > 0 && (r.running || feedRecentlyEnded(r))) {
    feed.classList.remove("hidden");
    feed.innerHTML = lines.map((l) => `
      <div class="feed-line"><span class="feed-time">${escapeHtml(l.at.slice(11, 19))}</span>${escapeHtml(l.text)}</div>`).join("");
  } else {
    feed.classList.add("hidden");
    feed.innerHTML = "";
  }
}

// Keep the finished run's last lines on screen for a few minutes so the user
// can see how it ended, then tidy up.
function feedRecentlyEnded(r) {
  return r.lastExit && (Date.now() - Date.parse(r.lastExit.at)) < 5 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Tab switching and the render loop
// ---------------------------------------------------------------------------
function render() {
  if (!view) return;
  renderHeader();
  if (activeTab === "postings") { renderActionRequired(); renderNextRound(); renderAttention(); renderUpcoming(); renderPostings(); renderScans(); }
  if (activeTab === "reports") renderDocs("reports", "#reports-list", false);
  if (activeTab === "log") renderLog();
  // The detail panel is deliberately NOT re-rendered here: redrawing it on
  // every poll would wipe half-typed edits. It renders once when opened.
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = async () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    activeTab = btn.dataset.tab;
    $(`#tab-${activeTab}`).classList.remove("hidden");
    if (activeTab === "reports") await loadDocs("reports");
    render();
  };
});

["#f-search", "#f-category", "#f-status", "#f-rank", "#f-source", "#f-sort", "#f-hidden"].forEach((sel) => {
  $(sel).addEventListener("input", () => { saveFilters(); renderPostings(true); });
});
$("#log-search").addEventListener("input", () => renderLog());

$("#detail-backdrop").onclick = () => closeDetail();
$("#add-posting").onclick = () => openAddDialog();
$("#add-action").onclick = () => openAddActionDialog();
$("#find-more").onclick = async () => {
  const btn = $("#find-more");
  btn.disabled = true;
  const result = await post("/api/research/start", {});
  if (result && result.error) btn.disabled = false;
};
$("#research-stop").onclick = async () => {
  if (confirm("Stop the research run? Anything it already published stays.")) {
    await post("/api/research/stop", {});
  }
};
$("#rescan-email").onclick = startRescan;

// Keyboard basics: Escape closes the topmost layer, "/" jumps to search.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#apply-modal").classList.contains("hidden")) { modalBackdropClose(); return; }
    if (!$("#detail").classList.contains("hidden")) { closeDetail(); return; }
  }
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("#f-search").focus();
  }
});

// The category and region filters come from profile/preferences.json, so
// fill them before restoring the saved filters (a remembered category needs
// its option to exist).
function fillPrefOptions() {
  const p = view && view.prefs;
  if (!p) return;
  $("#f-category").innerHTML = `<option value="">All categories</option>` +
    p.categories.map((c) => `<option>${escapeHtml(c)}</option>`).join("");
  $("#f-rank").innerHTML = `<option value="">All regions</option>` +
    [1, 2, 3].map((r) => `<option value="${r}">${r} (${escapeHtml(rankName(r))})</option>`).join("");
}

fetch("/api/view").then((r) => r.json()).then((v) => { view = v; }).catch(() => {}).finally(() => {
  fillPrefOptions();
  restoreFilters();
  refresh();
});
setInterval(async () => {
  await refresh();
  // Keep doc tabs fresh too while they are open.
  if (activeTab === "reports") { await loadDocs("reports"); render(); }
}, 3000);
