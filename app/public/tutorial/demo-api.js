// demo-api.js: a pretend back end for the tutorial.
//
// Loaded before app.js. It answers every /api/ request the real app makes
// from an in-memory copy of the store, filled with a made-up student's
// internship search, so the real tracker screens run with no server behind
// them. Nothing here reads or writes anyone's real tracker: every /api/ call
// is answered on this page and never reaches a network, and the app's saved
// filters live in a throwaway storage instead of the browser's real one.
// Reloading the page starts over with fresh data.
//
// The rules below mirror app/state.js (status changes, suggestion confirms,
// action reminders) closely enough for practice. If the app's behavior
// changes, update the matching handler here.

(function () {
  "use strict";

  const realFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------------------
  // Storage. The app remembers filters and dismissals in localStorage. On
  // http://localhost:4321/tutorial/ that is the SAME storage as the person's
  // real tracker, so the practice copy gets an in-memory stand-in instead.
  // The tutorial keeps its own progress in the real one (realStorage).
  // ---------------------------------------------------------------------------
  let realStorage = null;
  try { realStorage = window.localStorage; } catch { realStorage = null; }
  const mem = new Map();
  const appStorage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(String(k)); },
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  try {
    Object.defineProperty(window, "localStorage", { value: appStorage, configurable: true });
  } catch { /* the app falls back gracefully if storage misbehaves */ }

  // ---------------------------------------------------------------------------
  // Time, in New York like the real app (app/lib/util.js).
  // ---------------------------------------------------------------------------
  function nyOffsetMinutes(date) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
    const hour = parts.hour === "24" ? "00" : parts.hour;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hour, +parts.minute, +parts.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  }

  function isoNY(date = new Date()) {
    const off = nyOffsetMinutes(date);
    const s = new Date(date.getTime() + off * 60000);
    const p = (n) => String(n).padStart(2, "0");
    const abs = Math.abs(off);
    return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}` +
      `T${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())}` +
      `${off < 0 ? "-" : "+"}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  }

  function nyDate(d = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d instanceof Date ? d : new Date(d));
  }

  const TODAY = nyDate();
  const OFFSET = isoNY().slice(19);
  // A calendar date n days from today ("YYYY-MM-DD").
  function day(n) {
    const [y, m, d] = TODAY.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  // A timestamp n days from today at a New York wall-clock time.
  function at(n, time = "19:40:00") {
    return `${day(n)}T${time}${OFFSET}`;
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isCalendarDate(s) {
    if (!DATE_RE.test(String(s))) return false;
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  // ---------------------------------------------------------------------------
  // The made-up student's settings (what profile/preferences.json holds).
  // ---------------------------------------------------------------------------
  const PREFS = {
    email_addresses: ["alex.demo@example.com"],
    categories: ["Data", "Software", "Finance", "Consulting", "Operations", "Other"],
    rank1_label: "top choice",
    rank1_cities: ["chicago", "new york"],
    rank2_label: "good fit",
    rank2_states: ["IL", "NY", "NJ", "WI", "MN"],
    remote_is_rank2: true,
  };

  // Same rules as computeSeRank in app/lib/prefs.js.
  function seRank(locations) {
    let rank = 3;
    for (const loc of locations || []) {
      const text = String(loc);
      if (PREFS.rank1_cities.some((c) => text.toLowerCase().includes(c))) return 1;
      const m = text.match(/,\s*([A-Z]{2})\s*$/);
      if ((m && PREFS.rank2_states.includes(m[1])) ||
          (PREFS.remote_is_rank2 && /^remote\s*\(us\)$/i.test(text.trim()))) rank = 2;
    }
    return rank;
  }

  // A stand-in for the real key hash: same "hash|" + 16 hex shape.
  function fakeHashKey(text) {
    const fnv = (s, seed) => {
      let h = seed;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16).padStart(8, "0");
    };
    return "hash|" + fnv(text, 2166136261) + fnv(text, 2246822519);
  }

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // ---------------------------------------------------------------------------
  // The store
  // ---------------------------------------------------------------------------
  const S = {
    postings: new Map(),
    pending: new Map(),
    orphans: new Map(),
    actionEvidence: new Map(),
    actionDone: new Map(),
    nextRound: new Map(),
    nextRoundSeen: new Map(),
    dismissedNotices: new Map(),
    logLines: [],
    research: { running: false, startedAt: null, lastExit: null, progress: [] },
    lastProducedAt: null,
    lastDeliveryId: null,
  };

  function log(kind, text, when = isoNY()) {
    S.logLines.push({ at: when, kind, text });
  }

  function addPosting(o) {
    const locations = o.locations || [];
    const p = {
      key: o.key,
      company: o.company,
      division: o.division ?? null,
      role: o.role,
      category: o.category,
      locations,
      se_rank: seRank(locations),
      source: o.source || "greenhouse-api",
      ats: o.ats || "greenhouse",
      tenant: o.tenant ?? null,
      posting_url: o.posting_url || `https://example.com/jobs/${slug(o.company)}/${slug(o.role)}`,
      apply_url: null,
      req_id: o.req_id ?? null,
      date_posted: o.date_posted ?? null,
      deadline: o.deadline ?? null,
      notes: o.notes ?? null,
      possible_repost_of: null,
      first_seen: o.first_seen || day(-1),
      status: o.status || "new",
      hidden: false,
      applied_date: o.applied_date ?? null,
      portal_email: PREFS.email_addresses[0],
      portal_note: o.portal_note ?? null,
      contact_referral: o.contact_referral ?? null,
      next_followup: o.next_followup ?? null,
      user_notes: o.user_notes ?? null,
      status_updated: o.status_updated ?? null,
      status_actor: o.status_actor ?? null,
      last_delivery_produced_at: null,
      last_manual_status_at: o.status_actor === "user" ? o.status_updated : null,
    };
    S.postings.set(p.key, p);
    return p;
  }

  // Remember the evidence conventions that outlive a suggestion (state.js).
  function rememberEvidence(key, evidence, when) {
    const text = String(evidence || "").trim();
    if (/^ACTION REQUIRED:/i.test(text)) S.actionEvidence.set(key, { evidence, at: when });
    if (/^NEXT ROUND:/i.test(text)) {
      const prev = S.nextRound.get(key);
      S.nextRound.set(key, { evidence, at: when });
      if (!prev || prev.evidence !== evidence) S.nextRoundSeen.delete(key);
    }
  }

  function addSuggestion(o) {
    const s = {
      id: o.id,
      posting_key: o.key,
      suggested_status: o.status,
      evidence: o.evidence,
      explicit_user: false,
      observed_at: o.observed_at || null,
      suggested_applied_date: o.suggested_applied_date || null,
      delivery_id: S.lastDeliveryId,
      at: o.at,
    };
    S.pending.set(s.id, s);
    rememberEvidence(s.posting_key, s.evidence, s.at);
    log("suggestion", `Pending suggestion: mark ${s.posting_key} ${s.suggested_status} (${s.evidence})`, s.at);
  }

  // One status change, exactly like the "status" event in state.js.
  function setStatus(key, status, actor, appliedDate) {
    const p = S.postings.get(key);
    if (!p) return;
    const when = isoNY();
    p.status = status;
    p.status_updated = when;
    p.status_actor = actor;
    if (status === "applied" && appliedDate) p.applied_date = appliedDate;
    if (actor === "user" || actor === "dashboard-confirm") p.last_manual_status_at = when;
    if (["oa", "interview", "offer"].includes(status) && S.nextRound.has(key)) S.nextRoundSeen.set(key, when);
    for (const [id, s] of [...S.pending]) {
      if (s.posting_key === key && s.suggested_status === status) {
        S.pending.delete(id);
        log("suggestion", `Suggestion resolved by the status change above: ${key} is now ${status}`, when);
      }
    }
    log("status", `${p.company}: status set to ${status}${status === "applied" && appliedDate ? ` (applied ${appliedDate})` : ""} by ${actor}`, when);
  }

  // ---------------------------------------------------------------------------
  // Alex's search. Every company, person, and address here is invented.
  // ---------------------------------------------------------------------------
  function seed() {
    S.lastProducedAt = at(-1, "19:41:02");
    S.lastDeliveryId = `${day(-1)}-weekly-003`;

    log("ingest", `Ingested ${day(-15)}-weekly-001 (weekly): 7 added, 0 updated, suggestions 0 applied / 0 pending / 0 no-op / 0 orphaned, 214 ms`, at(-15, "19:38:12"));
    log("status", `Bluebird Bank: status set to applied (applied ${day(-12)}) by user`, at(-12, "21:05:44"));
    log("status", `Harbor Health: status set to applied (applied ${day(-16)}) by user`, at(-12, "21:07:03"));
    log("status", `Lumen Robotics: status set to applied (applied ${day(-9)}) by user`, at(-9, "16:22:19"));
    log("ingest", `Ingested ${day(-8)}-weekly-002 (weekly): 5 added, 2 updated, suggestions 1 applied / 0 pending / 0 no-op / 0 orphaned, 196 ms`, at(-8, "19:44:51"));
    log("status", "Juniper Software: status set to interview by dashboard-confirm", at(-6, "08:12:30"));
    log("status", "Summit Capital: status set to interested by user", at(-4, "12:48:05"));

    const P = (o) => addPosting(o);

    // In progress
    const bluebird = P({
      key: "workday|bluebirdbank|r-20417", company: "Bluebird Bank", role: "Data Analytics Summer Intern",
      category: "Data", locations: ["Chicago, IL"], source: "workday-cxs", ats: "workday", tenant: "bluebirdbank",
      req_id: "R-20417", deadline: null, date_posted: day(-30), first_seen: day(-15),
      status: "applied", applied_date: day(-12), status_updated: at(-12, "21:05:44"), status_actor: "user",
      notes: "Analytics rotation across consumer lending and fraud teams. SQL required, Python a plus.",
    });
    const lumen = P({
      key: "greenhouse|lumenrobotics|5522081", company: "Lumen Robotics", role: "Software Engineering Intern",
      category: "Software", locations: ["Pittsburgh, PA", "Remote (US)"], source: "greenhouse-api", tenant: "lumenrobotics",
      req_id: "5522081", date_posted: day(-20), first_seen: day(-15),
      status: "applied", applied_date: day(-9), status_updated: at(-9, "16:22:19"), status_actor: "user",
      notes: "Robotics software team. Remote allowed for interns.",
    });
    P({
      key: "lever|harborhealth|bi-intern-2027", company: "Harbor Health", role: "Business Intelligence Intern",
      category: "Data", locations: ["Minneapolis, MN"], source: "lever-api", ats: "lever", tenant: "harborhealth",
      req_id: "bi-intern-2027", first_seen: day(-15),
      status: "applied", applied_date: day(-16), status_updated: at(-12, "21:07:03"), status_actor: "user",
      contact_referral: "Jordan Lee (alum on the BI team)", next_followup: day(0),
      user_notes: "Jordan said the team takes 3 interns. Send a short thank-you and ask about timing.",
    });
    P({
      key: "greenhouse|junipersoftware|4910337", company: "Juniper Software", role: "Data Engineering Intern",
      category: "Software", locations: ["New York, NY"], source: "starred-firm-site", tenant: "junipersoftware",
      req_id: "4910337", date_posted: day(-35), first_seen: day(-15),
      status: "interview", applied_date: day(-24), status_updated: at(-6, "08:12:30"), status_actor: "dashboard-confirm",
      user_notes: "First round done. Final round is a 45-minute SQL and Python screen.",
    });

    // Interested
    P({
      key: "workday|summitcapital|jr-8812", company: "Summit Capital", role: "Investment Banking Summer Analyst",
      category: "Finance", locations: ["New York, NY"], source: "starred-firm-site", ats: "workday", tenant: "summitcapital",
      req_id: "JR-8812", deadline: day(5), date_posted: day(-21), first_seen: day(-15),
      status: "interested", status_updated: at(-4, "12:48:05"), status_actor: "user",
      notes: "Starred firm. Resume plus one short essay. Rolling interviews start before the deadline.",
    });
    P({
      key: "ashby|foxglove|pa-intern-27", company: "Foxglove Fintech", role: "Product Analyst Intern",
      category: "Finance", locations: ["Chicago, IL"], source: "ashby-api", ats: "ashby", tenant: "foxglove",
      req_id: "pa-intern-27", first_seen: day(-8),
      status: "interested", status_updated: at(-4, "12:51:40"), status_actor: "user",
      notes: "Small team, posted on the company's own board only.",
    });

    // New this week
    P({
      key: "greenhouse|northwindanalytics|4471203", company: "Northwind Analytics", role: "Data Analyst Intern (Summer 2027)",
      category: "Data", locations: ["Chicago, IL"], source: "greenhouse-api", tenant: "northwindanalytics",
      req_id: "4471203", deadline: day(19), date_posted: day(-3),
      notes: "Sophomores and juniors eligible. SQL and Python listed as pluses. Link opened and verified.",
    });
    P({
      key: "hash|" + "3fa1c09e5d7b2a44", company: "Cedar & Pine Consulting", role: "Summer Consulting Intern",
      category: "Consulting", locations: ["New York, NY"], source: "starred-firm-site", ats: "other",
      date_posted: day(-2),
      notes: "Starred firm. Reviewed on a rolling basis, so earlier is better.",
    });
    P({
      key: "workday|pioneeraero|req-77310", company: "Pioneer Aerospace", role: "Software Intern, Flight Systems",
      category: "Software", locations: ["Denver, CO"], source: "dork-myworkdayjobs", ats: "workday", tenant: "pioneeraero",
      req_id: "REQ-77310", deadline: day(30), date_posted: day(-6),
      notes: "Requires U.S. citizenship (export-controlled work).",
    });
    P({
      key: "lever|orchardfoods|scdata-2027", company: "Orchard Foods", role: "Supply Chain Data Intern",
      category: "Operations", locations: ["Madison, WI"], source: "lever-api", ats: "lever", tenant: "orchardfoods",
      req_id: "scdata-2027", deadline: day(26), date_posted: day(-4),
    });
    P({
      key: "ashby|lanternlabs|ml-intern", company: "Lantern Labs", role: "Machine Learning Intern",
      category: "Software", locations: ["Remote (US)"], source: "ashby-api", ats: "ashby", tenant: "lanternlabs",
      req_id: "ml-intern", date_posted: day(-1),
      notes: "Remote anywhere in the US. Posted this week.",
    });
    P({
      key: "workday|granitemutual|r-3391", company: "Granite Mutual", role: "Actuarial Intern",
      category: "Finance", locations: ["Milwaukee, WI"], source: "simplifyjobs-github", ats: "workday", tenant: "granitemutual",
      req_id: "R-3391", deadline: day(40), date_posted: day(-5),
    });
    const atlas = P({
      key: "smartrecruiters|atlasfreight|744190", company: "Atlas Freight", role: "Operations Analytics Intern",
      category: "Operations", locations: ["Chicago, IL"], source: "smartrecruiters-api", ats: "smartrecruiters", tenant: "atlasfreight",
      req_id: "744190", deadline: day(22), first_seen: day(-8), date_posted: day(-10),
    });
    const kestrel = P({
      key: "greenhouse|kestrelenergy|3301958", company: "Kestrel Energy", role: "Data Science Intern",
      category: "Data", locations: ["Houston, TX"], source: "greenhouse-api", tenant: "kestrelenergy",
      req_id: "3301958", first_seen: day(-15), date_posted: day(-25),
    });

    // Archived
    P({
      key: "greenhouse|meridianmedia|2209914", company: "Meridian Media", role: "Marketing Analytics Intern",
      category: "Other", locations: ["New York, NY"], source: "greenhouse-api", tenant: "meridianmedia",
      req_id: "2209914", first_seen: day(-15), status: "rejected", applied_date: day(-30),
      status_updated: at(-3, "10:15:00"), status_actor: "user",
    });
    P({
      key: "lever|willowretail|pricing-intern", company: "Willow Retail", role: "Pricing Analyst Intern",
      category: "Data", locations: ["Minneapolis, MN"], source: "lever-api", ats: "lever", tenant: "willowretail",
      req_id: "pricing-intern", first_seen: day(-15), status: "closed",
      status_updated: at(-1, "19:41:02"), status_actor: "auto-closed",
    });

    log("ingest", `Ingested ${S.lastDeliveryId} (weekly): 9 added, 1 updated, suggestions 0 applied / 4 pending / 0 no-op / 0 orphaned, 187 ms`, at(-1, "19:41:02"));
    log("status", "Willow Retail: status set to closed by auto-closed", at(-1, "19:41:02"));

    addSuggestion({
      id: "sugg-demo-1", key: bluebird.key, status: "oa", at: at(-1, "19:41:02"), observed_at: at(-1, "09:14:00"),
      evidence: `ACTION REQUIRED: Complete the online assessment (HireVue) | DUE: ${day(3)} | Reported from email; the link was not opened. The employer email is the only authority on this deadline. | recruiting@bluebird.example, subject "Next step: online assessment", received ${day(-1)}`,
    });
    addSuggestion({
      id: "sugg-demo-2", key: lumen.key, status: "interview", at: at(-1, "19:41:02"), observed_at: at(-1, "13:02:00"),
      evidence: `NEXT ROUND: Lumen Robotics invited you to a first-round interview | talent@lumen.example, subject "Next steps with Lumen", received ${day(-1)}`,
    });
    addSuggestion({
      id: "sugg-demo-3", key: atlas.key, status: "applied", at: at(-1, "19:41:02"), observed_at: at(-2, "22:31:00"),
      suggested_applied_date: day(-2),
      evidence: `Application confirmation: "Thanks for applying, Alex" from careers@atlas.example, received ${day(-2)}`,
    });
    addSuggestion({
      id: "sugg-demo-4", key: kestrel.key, status: "closed", at: at(-1, "19:41:02"), observed_at: at(-1, "18:55:00"),
      evidence: `The posting link now says "This job is no longer accepting applications" (checked ${day(-1)})`,
    });

  }

  // ---------------------------------------------------------------------------
  // Reports (what the weekly search writes into reports/)
  // ---------------------------------------------------------------------------
  function reports() {
    const pretty = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    const latest = [
      `# Weekly sweep, ${pretty(day(-1))}`,
      "",
      "## The short version",
      "- 9 new postings added. Every link was opened and checked before it was delivered.",
      `- 2 emails need you: Bluebird Bank sent an online assessment (due ${pretty(day(3))}), and Lumen Robotics wants to interview you.`,
      "- 1 application found in your email that the tracker did not have yet: Atlas Freight.",
      "- 1 posting looks closed: Kestrel Energy.",
      "",
      "## Top picks this week",
      `1. **Northwind Analytics, Data Analyst Intern** (Chicago). Closes ${pretty(day(19))}. Strong match for SQL and Python.`,
      "2. **Cedar & Pine Consulting, Summer Consulting Intern** (New York). Starred firm with rolling review, so apply early.",
      "3. **Lantern Labs, Machine Learning Intern** (Remote). Small team, posted this week.",
      "",
      "## Starred firms checked",
      "- Cedar & Pine Consulting: 1 new posting.",
      `- Summit Capital: no change. The posting on your shortlist closes ${pretty(day(5))}.`,
      "- Juniper Software: no new internships.",
      "",
      "## Where the postings came from",
      "- Company job boards (Greenhouse, Lever, Ashby, Workday): 6",
      "- Starred-firm career pages: 1",
      "- Internship tracker lists: 1",
      "- New idea tried this week: a search for analytics internships on Workday sites (1 posting)",
      "",
      "## Email",
      "- Scanned alex.demo@example.com for the past 7 days.",
      "- Found: Bluebird Bank (assessment), Lumen Robotics (interview), Atlas Freight (application confirmation).",
      "",
      "## Next week",
      "- Recheck Kestrel Energy in case it reopens.",
      `- Summit Capital's deadline is ${pretty(day(5))}.`,
    ].join("\n");
    const older = [
      `# Weekly sweep, ${pretty(day(-8))}`,
      "",
      "## The short version",
      "- 5 new postings added, 2 updated.",
      "- Juniper Software moved you to the interview round (you confirmed it).",
      "- No deadlines in the next two weeks.",
    ].join("\n");
    return [
      { name: `${day(-1)}-weekly-report.md`, mtime: Date.parse(at(-1, "19:41:05")), content: latest },
      { name: `${day(-8)}-weekly-report.md`, mtime: Date.parse(at(-8, "19:44:55")), content: older },
    ];
  }

  // ---------------------------------------------------------------------------
  // A pretend "Find more opportunities" run: a few progress lines, then a
  // small delivery of two new postings.
  // ---------------------------------------------------------------------------
  const RUN_LINES = [
    "Researcher booted; reading the playbook and your current postings.",
    'Searching the web: site:boards.greenhouse.io "2027" intern data analyst chicago',
    "Opening and reading: https://example.com/jobs/birch-street-analytics/data-science-intern",
    'Searching the web: site:jobs.ashbyhq.com "2027" software intern remote',
    "Opening and reading: https://example.com/jobs/quarry-labs/software-engineering-intern",
    "Working: checking every link opens a live posting",
    "Researcher: Found 2 new postings that fit, both verified. Skipped 3 duplicates you already have.",
    "Writing file: delivery file for the tracker",
    "Run complete; findings published.",
  ];
  let runTimer = null;

  function startRun() {
    const r = S.research;
    r.running = true;
    r.startedAt = isoNY();
    r.progress = [];
    log("research", "Research run started (Find more opportunities). Findings will arrive as a normal delivery.");
    let i = 0;
    runTimer = setInterval(() => {
      r.progress.push({ at: isoNY(), text: RUN_LINES[i] });
      i++;
      if (i >= RUN_LINES.length) {
        clearInterval(runTimer);
        runTimer = null;
        finishRun();
      }
    }, 1100);
  }

  function finishRun() {
    const r = S.research;
    const id = `${TODAY}-manual-001`;
    const added = [
      {
        key: "greenhouse|birchstreet|6120044", company: "Birch Street Analytics", role: "Data Science Intern",
        category: "Data", locations: ["Chicago, IL"], source: "greenhouse-api", tenant: "birchstreet",
        req_id: "6120044", deadline: day(24), date_posted: day(0), first_seen: TODAY,
        notes: "Found by the extra search you just ran. Link opened and verified.",
      },
      {
        key: "ashby|quarrylabs|swe-intern-2027", company: "Quarry Labs", role: "Software Engineering Intern",
        category: "Software", locations: ["Remote (US)"], source: "ashby-api", ats: "ashby", tenant: "quarrylabs",
        req_id: "swe-intern-2027", date_posted: day(-1), first_seen: TODAY,
        notes: "Found by the extra search you just ran. Link opened and verified.",
      },
    ];
    for (const o of added) if (!S.postings.has(o.key)) addPosting(o);
    S.lastProducedAt = isoNY();
    S.lastDeliveryId = id;
    log("ingest", `Ingested ${id} (manual): 2 added, 0 updated, suggestions 0 applied / 0 pending / 0 no-op / 0 orphaned, 41 ms`);
    r.running = false;
    r.lastExit = { code: 0, signal: null, at: isoNY() };
    log("research", "Research run finished. If it found anything, the delivery is ingesting now (or already did).");
    changed("research-done");
  }

  // ---------------------------------------------------------------------------
  // The API, endpoint by endpoint (app/server.js)
  // ---------------------------------------------------------------------------
  const USER_STATUSES = ["new", "interested", "applied", "oa", "interview", "offer", "rejected", "withdrawn", "closed"];
  const USER_EDIT_FIELDS = ["portal_email", "portal_note", "contact_referral", "next_followup", "user_notes"];

  function counts() {
    let nNew = 0, interested = 0, applied = 0, hidden = 0;
    for (const p of S.postings.values()) {
      if (p.status === "new") nNew++;
      if (p.status === "interested") interested++;
      if (p.status === "applied") applied++;
      if (p.hidden) hidden++;
    }
    return { total: S.postings.size, new: nNew, interested, applied, hidden };
  }

  function sittingUnapplied() {
    let n = 0;
    for (const p of S.postings.values()) {
      if ((p.status === "new" || p.status === "interested") && !p.hidden) n++;
    }
    return n;
  }

  function view() {
    return {
      now: isoNY(),
      freshness: { ever: true, lastProducedAt: S.lastProducedAt, lastDeliveryId: S.lastDeliveryId, stale: false, message: null },
      counts: counts(),
      badges: { pending: S.pending.size, errors: 0, sittingUnapplied: sittingUnapplied() },
      postings: [...S.postings.values()],
      pending: [...S.pending.values()],
      orphans: [...S.orphans.values()],
      errors: [],
      log: S.logLines.slice(-200).reverse(),
      research: { ...S.research, progress: S.research.progress.slice(-12) },
      rescanQueued: [],
      actionEvidence: Object.fromEntries(S.actionEvidence),
      actionDone: Object.fromEntries(S.actionDone),
      nextRound: Object.fromEntries(S.nextRound),
      nextRoundSeen: Object.fromEntries(S.nextRoundSeen),
      dismissedNotices: Object.fromEntries(S.dismissedNotices),
      settings: { macNotifications: true },
      prefs: PREFS,
    };
  }

  function confirmSuggestion(id) {
    const s = S.pending.get(id);
    if (!s) return false;
    const when = isoNY();
    const p = S.postings.get(s.posting_key);
    const resolve = (resolution, reason) => {
      S.pending.delete(id);
      rememberEvidence(s.posting_key, s.evidence, when);
      log("suggestion", `Suggestion ${resolution}: ${s.posting_key} -> ${s.suggested_status}${reason ? ` (${reason})` : ""}`, when);
    };
    if (p) {
      if (p.status === s.suggested_status) { resolve("noop", `already ${s.suggested_status}`); return true; }
      const ts = Date.parse(s.observed_at || s.at || 0);
      if (p.last_manual_status_at && Date.parse(p.last_manual_status_at) > ts) { resolve("noop", "manual change is newer"); return true; }
    }
    const applied = s.suggested_status === "applied"
      ? (s.suggested_applied_date || (s.observed_at ? nyDate(s.observed_at) : nyDate()))
      : null;
    setStatus(s.posting_key, s.suggested_status, "dashboard-confirm", applied);
    resolve("confirmed");
    return true;
  }

  function addPostingByHand(input) {
    const company = String(input.company || "").trim();
    const role = String(input.role || "").trim();
    const posting_url = String(input.posting_url || "").trim();
    const locations = (Array.isArray(input.locations) ? input.locations : []).map((s) => String(s).trim()).filter(Boolean);
    if (!company || !role || !posting_url) return { error: "Company, title, and link are all required." };
    if (!/^https?:\/\//i.test(posting_url)) return { error: "The link must start with http:// or https://." };
    if (!PREFS.categories.includes(input.category)) return { error: "Pick a category." };
    const deadline = input.deadline || null;
    if (deadline !== null && !DATE_RE.test(deadline)) return { error: "Deadline must be a date (YYYY-MM-DD)." };
    const key = input.key ? String(input.key) : fakeHashKey(`${company}|${role}|${locations[0] || ""}`.toLowerCase());
    if (S.postings.has(key)) {
      const ex = S.postings.get(key);
      return { error: `Already tracked: ${ex.company}, ${ex.role} (status: ${ex.status}).` };
    }
    addPosting({
      key, company, role, category: input.category, locations, source: "manual-add", ats: "other",
      posting_url, deadline, first_seen: TODAY,
    });
    for (const [oid, o] of [...S.orphans]) {
      if (o.posting_key === key) { S.orphans.delete(oid); S.pending.set(oid, o); }
    }
    if (input.status === "interested" || input.status === "applied") {
      setStatus(key, input.status, "user", input.status === "applied" ? (input.applied_date || TODAY) : null);
    }
    if (input.user_notes && String(input.user_notes).trim()) S.postings.get(key).user_notes = String(input.user_notes).trim();
    log("ingest", `${company}: posting added manually by you (${role})`);
    return { ok: true, key };
  }

  function addActionByHand(input) {
    const key = String(input.key || "").trim();
    const what = String(input.what || "").trim();
    const due = input.due ? String(input.due).trim() : null;
    const note = String(input.note || "").trim();
    if (!S.postings.has(key)) return { error: "Pick which posting this action belongs to." };
    if (!what) return { error: "Say what you need to do." };
    if (what.length > 300) return { error: "Keep the action under 300 characters." };
    if (due !== null && !isCalendarDate(due)) return { error: "The due date has to be a real date (YYYY-MM-DD)." };
    if (note.length > 500) return { error: "Keep the note under 500 characters." };
    const clean = (t) => t.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    const evidence = [`ACTION REQUIRED: ${clean(what)}`, `DUE: ${due || "not stated"}`,
      note ? clean(note) : "Added by hand in the app; not from a delivery."].join(" | ");
    const when = isoNY();
    S.actionDone.delete(key);
    S.actionEvidence.set(key, { evidence, at: when });
    log("suggestion", `Action added by hand: ${key} (${evidence})`, when);
    return { ok: true };
  }

  function handle(method, route, body) {
    const ok = (extra = {}) => [200, { ok: true, ...extra }];
    const missing = () => [404, { error: "unknown posting" }];

    if (method === "GET" && route === "view") return [200, view()];
    if (method === "GET" && route === "reports") return [200, reports()];
    if (method !== "POST") return [404, { error: "Not part of the practice copy." }];

    switch (route) {
      case "posting/status": {
        const { key, status, applied_date } = body;
        if (!S.postings.has(key)) return missing();
        if (!USER_STATUSES.includes(status)) return [400, { error: "bad status" }];
        if (applied_date != null && !DATE_RE.test(String(applied_date))) {
          return [400, { error: "The applied date must look like 2026-08-11 (YYYY-MM-DD)." }];
        }
        setStatus(key, status, "user", status === "applied" ? (applied_date || nyDate()) : null);
        return ok();
      }
      case "posting/hidden": {
        const p = S.postings.get(body.key);
        if (!p) return missing();
        p.hidden = !!body.hidden;
        log("hidden", `${p.company}: ${p.hidden ? "hidden" : "un-hidden"}`);
        return ok();
      }
      case "posting/edit": {
        const p = S.postings.get(body.key);
        if (!p) return missing();
        const fields = body.fields || {};
        if (fields.next_followup && !DATE_RE.test(String(fields.next_followup))) {
          return [400, { error: "The follow-up date must look like 2026-08-11 (YYYY-MM-DD)." }];
        }
        for (const f of USER_EDIT_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, f)) p[f] = fields[f];
        return ok();
      }
      case "posting/add": {
        const result = addPostingByHand(body);
        if (result.error) return [400, result];
        return [200, result];
      }
      case "action/add": {
        const result = addActionByHand(body);
        if (result.error) return [400, result];
        return ok();
      }
      case "action/done": {
        const key = String(body.key || "");
        if (!key) return [400, { error: "A posting key is required." }];
        if (body.done === false) S.actionDone.delete(key); else S.actionDone.set(key, isoNY());
        log("suggestion", `Action ${body.done === false ? "un-marked" : "marked"} done: ${key}`);
        return ok();
      }
      case "notice/dismiss": {
        const id = String(body.id || "").trim();
        if (!id) return [400, { error: "A notice id is required." }];
        if (body.dismissed === false) S.dismissedNotices.delete(id); else S.dismissedNotices.set(id, isoNY());
        const where = body.kind === "upcoming" ? "Coming up" : "Action required";
        log("suggestion", `${where} row ${body.dismissed === false ? "restored" : "removed"}: ${body.key || id}`);
        return ok();
      }
      case "nextround/seen": {
        const key = String(body.key || "");
        if (!key) return [400, { error: "A posting key is required." }];
        if (body.seen === false) S.nextRoundSeen.delete(key); else S.nextRoundSeen.set(key, isoNY());
        log("suggestion", `Next-round news ${body.seen === false ? "un-acknowledged" : "acknowledged"}: ${key}`);
        return ok();
      }
      case "suggestion/confirm": {
        if (!confirmSuggestion(body.id)) return [404, { error: "unknown suggestion" }];
        return ok();
      }
      case "suggestion/dismiss": {
        const s = S.pending.get(body.id);
        if (s) {
          S.pending.delete(body.id);
          rememberEvidence(s.posting_key, s.evidence, isoNY());
          log("suggestion", `Suggestion dismissed: ${s.posting_key} -> ${s.suggested_status}`);
        } else if (S.orphans.has(body.id)) {
          S.orphans.delete(body.id);
          log("suggestion", `Orphan suggestion dismissed: ${body.id}`);
        } else {
          return [404, { error: "unknown suggestion" }];
        }
        return ok();
      }
      case "suggestion/bulk-confirm-closed": {
        const ids = [...S.pending.values()].filter((s) => s.suggested_status === "closed").map((s) => s.id);
        for (const id of ids) confirmSuggestion(id);
        return ok({ confirmed: ids.length });
      }
      case "research/start": {
        if (S.research.running) return [409, { error: "A research run is already going." }];
        startRun();
        return ok();
      }
      case "research/stop": {
        if (!S.research.running) return [409, { error: "No research run is going." }];
        clearInterval(runTimer);
        runTimer = null;
        S.research.running = false;
        S.research.lastExit = { code: null, signal: "SIGTERM", at: isoNY() };
        log("research", "Research run stopped (SIGTERM).");
        return ok();
      }
      case "research/rescan-applications":
        return [202, {
          queued: true,
          error: "Practice copy: in your real tracker this opens Claude's Cowork with the email rescan ready to send. Press enter there and it reads your job email. Nothing was sent anywhere from here.",
        }];
      case "settings":
        return ok({ settings: { macNotifications: body.macNotifications !== false } });
      default:
        return [404, { error: "Not part of the practice copy." }];
    }
  }

  // Tell the tutorial something changed so it can check off the current task.
  function changed(what, key = null) {
    try { window.dispatchEvent(new CustomEvent("demo:change", { detail: { what, key } })); } catch { /* old browser */ }
  }

  window.fetch = async function demoFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    let path = url;
    try { path = new URL(url, window.location.href).pathname; } catch { /* keep the raw string */ }
    const m = /\/api\/(.+)$/.exec(path);
    if (!m) return realFetch(input, init);
    const method = String((init && init.method) || "GET").toUpperCase();
    let body = {};
    if (init && typeof init.body === "string") {
      try { body = JSON.parse(init.body) || {}; } catch { body = {}; }
    }
    // A short pause, so the screens behave like they do against a real server.
    await new Promise((r) => setTimeout(r, 30));
    let status, payload;
    try {
      [status, payload] = handle(method, m[1], body);
      if (method === "POST" && status < 300) changed(m[1], body.key || null);
    } catch (e) {
      status = 500;
      payload = { error: `Practice copy hiccup: ${e && e.message ? e.message : e}` };
    }
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };

  seed();

  // What the tutorial reads to check off tasks.
  window.__demo = {
    store: S,
    realStorage,
    appStorage,
    today: TODAY,
    day,
    find: (company) => [...S.postings.values()].find((p) => p.company === company) || null,
  };
})();
