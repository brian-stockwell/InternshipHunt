// ingest.js: the customs officer for delivery files.
//
// A delivery file from the Cowork researcher lands in inbox/. This file
// checks EVERYTHING about it before letting any of it in (all-or-nothing),
// then turns it into events on the log, refreshes the exports, and archives
// the file into inbox/processed/. A bad delivery gets a .error marker
// written next to it and is left in place for a human to fix.

const fs = require("fs");
const path = require("path");
const { isoNY, nyDate, atomicWriteFileSync, isCalendarDate } = require("./lib/util");
const { isValidKey } = require("./state");
const { DEFAULT_PREFS } = require("./lib/prefs");
const { backupBeforeIngest } = require("./backup");

// The delivery schema versions this app accepts. The spec's compatibility
// rule is "N and N-1"; we are at version 1, so the set is just {1}.
const SUPPORTED_DELIVERY_VERSIONS = [1];

// A file in inbox/ is a delivery if and only if its basename matches this.
const DELIVERY_RE = /^delivery-[0-9]{8}-[0-9]{6}-(weekly|session|manual)-[a-z0-9]{4}\.json$/;

const RUN_TYPES = ["weekly", "session", "manual"];
// Categories come from profile/preferences.json (store.prefs.categories), the
// same list the manual-add form uses, so the two can never drift apart.
const ATS_VALUES = ["workday", "greenhouse", "lever", "ashby", "smartrecruiters", "icims", "oraclecloud", "brassring", "talentlink", "avature", "eightfold", "usajobs", "other"];
const SUGGESTED_STATUSES = ["applied", "oa", "interview", "offer", "rejected", "withdrawn", "closed"];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;

// Shared with the manual-entry paths in state.js; see lib/util.js.
const isDate = isCalendarDate;
function isIso(s) { return typeof s === "string" && ISO_RE.test(s) && !isNaN(Date.parse(s)); }

// ---------------------------------------------------------------------------
// Validation (spec section 4 step 3): check the ENTIRE delivery before
// applying ANY of it. Returns { errors, warnings }. Any error rejects the
// whole file; warnings only produce Log lines.
// ---------------------------------------------------------------------------
function validateDelivery(d, filename, categories = DEFAULT_PREFS.categories) {
  const errors = [];
  const warnings = [];
  const err = (code, message, p) => errors.push({ code, message, path: p });

  const reqString = (obj, field, p) => {
    if (obj[field] === undefined || obj[field] === null) { err("MISSING_FIELD", `${p} is required`, p); return false; }
    if (typeof obj[field] !== "string") { err("BAD_TYPE", `${p} must be a string`, p); return false; }
    return true;
  };
  const optStringOrNull = (obj, field, p) => {
    if (obj[field] !== undefined && obj[field] !== null && typeof obj[field] !== "string") {
      err("BAD_TYPE", `${p} must be a string or null`, p);
    }
  };

  // Top level
  if (!Number.isInteger(d.schema_version)) err("BAD_TYPE", "schema_version must be an integer", "schema_version");
  if (reqString(d, "delivery_id", "delivery_id")) {
    const expected = filename.replace(/\.json$/, "");
    if (d.delivery_id !== expected) {
      err("ID_FILENAME_MISMATCH", `delivery_id '${d.delivery_id}' does not match filename '${expected}'`, "delivery_id");
    }
  }
  if (reqString(d, "produced_at", "produced_at") && !isIso(d.produced_at)) {
    err("BAD_DATE", `produced_at '${d.produced_at}' is not ISO 8601 with offset`, "produced_at");
  }
  if (reqString(d, "run_type", "run_type") && !RUN_TYPES.includes(d.run_type)) {
    err("BAD_ENUM", `run_type is '${d.run_type}' (allowed: ${RUN_TYPES.join(", ")})`, "run_type");
  }
  reqString(d, "summary", "summary");
  if (!Array.isArray(d.postings)) err("BAD_TYPE", "postings must be an array", "postings");
  if (!Array.isArray(d.status_suggestions)) err("BAD_TYPE", "status_suggestions must be an array", "status_suggestions");
  if (!Array.isArray(d.source_health)) err("BAD_TYPE", "source_health must be an array", "source_health");
  if (!Array.isArray(d.outreach_files)) {
    err("BAD_TYPE", "outreach_files must be an array", "outreach_files");
  } else {
    d.outreach_files.forEach((f, i) => {
      if (typeof f !== "string") err("BAD_TYPE", `outreach_files[${i}] must be a string`, `outreach_files[${i}]`);
    });
  }

  // Postings
  const seenKeys = new Set();
  if (Array.isArray(d.postings)) {
    d.postings.forEach((p, i) => {
      const at = (f) => `postings[${i}].${f}`;
      if (typeof p !== "object" || p === null) { err("BAD_TYPE", `postings[${i}] must be an object`, `postings[${i}]`); return; }
      if (reqString(p, "key", at("key")) && !isValidKey(p.key)) {
        err("BAD_KEY_FORMAT", `${at("key")} '${p.key}' matches neither key format`, at("key"));
      }
      if (typeof p.key === "string") {
        if (seenKeys.has(p.key)) err("DUPLICATE_KEY_IN_DELIVERY", `key '${p.key}' appears more than once`, at("key"));
        seenKeys.add(p.key);
      }
      reqString(p, "company", at("company"));
      reqString(p, "role", at("role"));
      if (reqString(p, "category", at("category")) && !categories.includes(p.category)) {
        err("BAD_ENUM", `${at("category")} is '${p.category}' (allowed: ${categories.join(", ")})`, at("category"));
      }
      if (!Array.isArray(p.locations)) {
        err("BAD_TYPE", `${at("locations")} must be an array`, at("locations"));
      } else {
        p.locations.forEach((loc, j) => {
          if (typeof loc !== "string") err("BAD_TYPE", `${at("locations")}[${j}] must be a string`, `${at("locations")}[${j}]`);
        });
      }
      if (![1, 2, 3].includes(p.se_rank)) err("BAD_ENUM", `${at("se_rank")} is '${p.se_rank}' (allowed: 1, 2, 3)`, at("se_rank"));
      reqString(p, "source", at("source"));
      if (reqString(p, "ats", at("ats")) && !ATS_VALUES.includes(p.ats)) {
        err("BAD_ENUM", `${at("ats")} is '${p.ats}' (allowed: ${ATS_VALUES.join(", ")})`, at("ats"));
      }
      // URLs must actually be web links. Anything else (a javascript: string,
      // a bare word) would render as a clickable link in the app, which is a
      // link the user could click. Reject at the border instead.
      if (reqString(p, "posting_url", at("posting_url")) && !/^https?:\/\//i.test(p.posting_url)) {
        err("BAD_TYPE", `${at("posting_url")} must be an http(s) URL`, at("posting_url"));
      }
      optStringOrNull(p, "division", at("division"));
      optStringOrNull(p, "tenant", at("tenant"));
      optStringOrNull(p, "apply_url", at("apply_url"));
      if (typeof p.apply_url === "string" && !/^https?:\/\//i.test(p.apply_url)) {
        err("BAD_TYPE", `${at("apply_url")} must be an http(s) URL`, at("apply_url"));
      }
      optStringOrNull(p, "req_id", at("req_id"));
      optStringOrNull(p, "notes", at("notes"));
      for (const f of ["date_posted", "deadline"]) {
        if (p[f] !== undefined && p[f] !== null && !isDate(p[f])) {
          err("BAD_DATE", `${at(f)} '${p[f]}' is not YYYY-MM-DD`, at(f));
        }
      }
      // possible_repost_of is format-checked but a failure only DROPS the
      // pointer with a warning; the posting still ingests (spec section 4).
      if (p.possible_repost_of !== undefined && p.possible_repost_of !== null) {
        if (typeof p.possible_repost_of !== "string" || !isValidKey(p.possible_repost_of)) {
          warnings.push(`${at("possible_repost_of")} '${p.possible_repost_of}' is not a valid key; dropping the repost pointer, posting ingests normally`);
          p.possible_repost_of = null;
        }
      }
    });
  }

  // Status suggestions
  if (Array.isArray(d.status_suggestions)) {
    d.status_suggestions.forEach((s, i) => {
      const at = (f) => `status_suggestions[${i}].${f}`;
      if (typeof s !== "object" || s === null) { err("BAD_TYPE", `status_suggestions[${i}] must be an object`, `status_suggestions[${i}]`); return; }
      if (reqString(s, "posting_key", at("posting_key")) && !isValidKey(s.posting_key)) {
        err("BAD_KEY_FORMAT", `${at("posting_key")} '${s.posting_key}' matches neither key format`, at("posting_key"));
      }
      if (reqString(s, "suggested_status", at("suggested_status")) && !SUGGESTED_STATUSES.includes(s.suggested_status)) {
        err("BAD_ENUM", `${at("suggested_status")} is '${s.suggested_status}' (allowed: ${SUGGESTED_STATUSES.join(", ")})`, at("suggested_status"));
      }
      reqString(s, "evidence", at("evidence"));
      if (typeof s.explicit_user !== "boolean") err("BAD_TYPE", `${at("explicit_user")} must be true or false`, at("explicit_user"));
      if (s.observed_at !== undefined && s.observed_at !== null && !isIso(s.observed_at)) {
        err("BAD_DATE", `${at("observed_at")} '${s.observed_at}' is not ISO 8601 with offset`, at("observed_at"));
      }
      if (s.suggested_applied_date !== undefined && s.suggested_applied_date !== null && !isDate(s.suggested_applied_date)) {
        err("BAD_DATE", `${at("suggested_applied_date")} '${s.suggested_applied_date}' is not YYYY-MM-DD`, at("suggested_applied_date"));
      }
    });
  }

  // Source health
  if (Array.isArray(d.source_health)) {
    d.source_health.forEach((h, i) => {
      const at = (f) => `source_health[${i}].${f}`;
      if (typeof h !== "object" || h === null) { err("BAD_TYPE", `source_health[${i}] must be an object`, `source_health[${i}]`); return; }
      reqString(h, "source", at("source"));
      if (typeof h.tried !== "boolean") err("BAD_TYPE", `${at("tried")} must be true or false`, at("tried"));
      if (!Number.isInteger(h.yield) || h.yield < 0) err("BAD_TYPE", `${at("yield")} must be an integer >= 0`, at("yield"));
      if (h.note !== null && h.note !== undefined && typeof h.note !== "string") {
        err("BAD_TYPE", `${at("note")} must be a string or null`, at("note"));
      }
      if (h.note === undefined) err("MISSING_FIELD", `${at("note")} is required (may be null)`, at("note"));
    });
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Error markers (spec section 2.3). Written atomically next to the delivery,
// with a .error extension so the watcher can never mistake one for a delivery.
// ---------------------------------------------------------------------------
function writeErrorMarker(store, deliveryPath, stage, errors, appNote) {
  const file = path.basename(deliveryPath);
  const marker = {
    schema_version: 1,
    delivery_file: file,
    delivery_id: file.replace(/\.json$/, ""),
    failed_at: isoNY(),
    stage,
    errors,
    app_note: appNote,
    later_deliveries_processed: false,
  };
  // Even the marker write can fail on a sick disk; that must never take the
  // app down with it. The Log line below still records what happened.
  try {
    atomicWriteFileSync(deliveryPath + ".error", JSON.stringify(marker, null, 2) + "\n");
  } catch (e) {
    store.log("error", `Could not even write the error marker for ${file} (${e.message}).`);
  }
  store.log("error", `Delivery ${file} failed at stage '${stage}': ${errors.map((e) => e.code).join(", ")}. Marker written; file left in inbox for retry.`);
  return marker;
}

// After a successful ingest, warn any older error-marked delivery that a
// newer one already went through (spec section 4 step 9).
function flagEarlierMarkers(store, ingestedFilename) {
  let entries = [];
  try { entries = fs.readdirSync(store.paths.inbox); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith(".error")) continue;
    const deliveryName = name.slice(0, -".error".length);
    if (!(deliveryName < ingestedFilename)) continue;
    const markerPath = path.join(store.paths.inbox, name);
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.later_deliveries_processed !== true) {
        marker.later_deliveries_processed = true;
        atomicWriteFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");
        store.log("error", `Marked ${deliveryName} error marker: later deliveries have been processed (out-of-order retry is still safe).`);
      }
    } catch {
      // An unreadable marker is not worth crashing over.
    }
  }
}

// ---------------------------------------------------------------------------
// Suggestion resolution (spec section 6). Called per suggestion at ingest
// time, in order, AFTER this delivery's postings have been applied.
// Emits events via `emit` and returns one of:
// "orphan" | "noop" | "applied" | "pending".
// ---------------------------------------------------------------------------
function resolveSuggestion(store, emit, s, id, delivery) {
  const at = isoNY();
  const base = {
    key: s.posting_key,
    status: s.suggested_status,
    evidence: s.evidence,
    explicit_user: !!s.explicit_user,
    observed_at: s.observed_at || null,
    suggested_applied_date: s.suggested_applied_date || null,
    delivery_id: delivery.delivery_id,
    at,
  };
  const p = store.postings.get(s.posting_key);

  // Rule 1: unknown key -> orphan (stored, shown, never crashes anything).
  if (!p) {
    emit({ t: "orphan", id, ...base });
    return "orphan";
  }

  // Rule 2: already in that status -> logged no-op.
  // No-op resolutions deliberately carry no id: they refer to the incoming
  // suggestion (which never became pending), so they must not delete any
  // pending entry that happens to share the same delivery-derived id
  // (exactly what happens when a torn-write delivery is re-ingested).
  // They DO carry the evidence: an ACTION REQUIRED deadline inside a no-op
  // suggestion is still a deadline, and dropping it here was how an
  // assessment could vanish without the user ever seeing it.
  if (p.status === s.suggested_status) {
    emit({ t: "sugg_resolve", id: null, key: s.posting_key, status: s.suggested_status, resolution: "noop", reason: `already ${s.suggested_status}`, evidence: s.evidence, at });
    return "noop";
  }

  // Rule 3: duplicate of an existing pending suggestion, non-explicit only.
  const dupPendingId = store.findPendingId(s.posting_key, s.suggested_status);
  if (dupPendingId && !s.explicit_user) {
    emit({ t: "sugg_resolve", id: null, key: s.posting_key, status: s.suggested_status, resolution: "noop", reason: "duplicate of an existing pending suggestion", evidence: s.evidence, at });
    return "noop";
  }

  // Rule 4: explicit suggestions compare timestamps with the user's manual edits.
  if (s.explicit_user) {
    const ts = Date.parse(s.observed_at || delivery.produced_at);
    if (p.last_manual_status_at && Date.parse(p.last_manual_status_at) > ts) {
      emit({ t: "sugg_resolve", id: null, key: s.posting_key, status: s.suggested_status, resolution: "noop", reason: "manual change is newer", evidence: s.evidence, at });
      return "noop";
    }
    const statusEv = { t: "status", key: s.posting_key, status: s.suggested_status, actor: "cowork-session", delivery_id: delivery.delivery_id, at };
    if (s.suggested_status === "applied") {
      statusEv.applied_date = s.suggested_applied_date || nyDate(s.observed_at || delivery.produced_at);
    }
    emit(statusEv);
    if (dupPendingId) {
      emit({ t: "sugg_resolve", id: dupPendingId, key: s.posting_key, status: s.suggested_status, resolution: "superseded", reason: "explicit suggestion applied", at });
    }
    return "applied";
  }

  // Rule 5: non-explicit. "closed" auto-applies on an untouched posting;
  // everything else waits for the user's one-click confirm.
  if (s.suggested_status === "closed" && (p.status === "new" || p.status === "interested") && !p.hidden) {
    emit({ t: "status", key: s.posting_key, status: "closed", actor: "auto-closed", delivery_id: delivery.delivery_id, at });
    return "applied";
  }
  emit({ t: "sugg_pending", id, ...base });
  return "pending";
}

// ---------------------------------------------------------------------------
// The full pipeline for one delivery file (spec section 4).
// Synchronous on purpose: deliveries are processed strictly one at a time.
// Returns a small result object for the caller (watcher / tests / Retry).
// ---------------------------------------------------------------------------
function processDeliveryFile(store, deliveryPath) {
  const started = Date.now();
  const filename = path.basename(deliveryPath);

  // A retry (button or file-changed-on-disk) means any old marker is stale.
  const markerPath = deliveryPath + ".error";
  if (fs.existsSync(markerPath)) {
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
  }

  // Step 1: read.
  let raw;
  try {
    raw = fs.readFileSync(deliveryPath, "utf8");
  } catch (e) {
    writeErrorMarker(store, deliveryPath, "read", [{ code: "IO_ERROR", message: String(e.message || e), path: null }], "Could not read the delivery file. Nothing was ingested.");
    return { ok: false, stage: "read" };
  }

  // Step 1b: parse. (The watcher already gave a failed parse one 2-second
  // second chance before calling us again; by here a failure is final.)
  let delivery;
  try {
    delivery = JSON.parse(raw);
  } catch (e) {
    writeErrorMarker(store, deliveryPath, "parse", [{ code: "NOT_JSON", message: String(e.message || e), path: null }], "Delivery is not valid JSON. Nothing was ingested.");
    return { ok: false, stage: "parse" };
  }

  // Step 2: schema version gate.
  if (!SUPPORTED_DELIVERY_VERSIONS.includes(delivery.schema_version)) {
    writeErrorMarker(store, deliveryPath, "validate",
      [{ code: "SCHEMA_VERSION_UNSUPPORTED", message: `schema_version is ${JSON.stringify(delivery.schema_version)} (supported: ${SUPPORTED_DELIVERY_VERSIONS.join(", ")})`, path: "schema_version" }],
      `This delivery uses schema version ${delivery.schema_version}; the app supports ${SUPPORTED_DELIVERY_VERSIONS.join(", ")}. Update the app, then retry.`);
    return { ok: false, stage: "validate" };
  }

  // Step 3: validate everything before applying anything.
  const { errors, warnings } = validateDelivery(delivery, filename, store.prefs.categories);
  for (const w of warnings) store.log("warn", `${filename}: ${w}`);
  if (errors.length > 0) {
    writeErrorMarker(store, deliveryPath, "validate", errors, "Delivery rejected before any data was applied. Nothing was ingested.");
    return { ok: false, stage: "validate" };
  }

  // Warn (never fail) about outreach files the delivery references but that
  // do not exist on disk; outreach is display-only.
  for (const f of delivery.outreach_files || []) {
    if (!fs.existsSync(path.join(store.paths.outreach, f))) {
      store.log("warn", `${filename}: outreach file '${f}' referenced by the delivery does not exist in outreach/`);
    }
  }

  // Step 4: idempotency. Already ingested? Log it and just archive the file.
  if (store.ingested.has(delivery.delivery_id)) {
    store.log("ingest", `Duplicate delivery skipped: ${delivery.delivery_id} was already ingested. File archived, nothing re-applied.`);
    archiveDelivery(store, deliveryPath);
    return { ok: true, skipped: true };
  }

  // Step 5: backup the event log before any mutation. A backup failure means
  // something is wrong with the disk, which is exactly when mutating without
  // a safety copy is a bad idea: mark the delivery and stop.
  try {
    backupBeforeIngest(store);
  } catch (e) {
    writeErrorMarker(store, deliveryPath, "apply", [{ code: "IO_ERROR", message: `backup failed: ${String(e.message || e)}`, path: null }], "Could not take the pre-ingest backup, so nothing was applied. Check disk space, then retry.");
    return { ok: false, stage: "apply" };
  }

  // Step 6: apply, all-or-nothing. Build every event in memory (applying each
  // to the in-memory state as we go so later suggestions see earlier postings)
  // and append them to disk in ONE write, with the ingest commit event LAST.
  // If that write tears partway, the commit record is missing, the delivery
  // never enters the idempotency registry, and a re-ingest converges safely.
  const events = [];
  const emit = (ev) => { events.push(ev); store.applyEvent(ev); };
  const counts = { added: 0, updated: 0, sugg_applied: 0, sugg_pending: 0, sugg_noop: 0, sugg_orphaned: 0 };

  try {
    // Postings first.
    for (const p of delivery.postings) {
      const fields = {
        company: p.company, division: p.division ?? null, role: p.role,
        category: p.category, locations: p.locations, se_rank: p.se_rank,
        source: p.source, ats: p.ats, tenant: p.tenant ?? null,
        posting_url: p.posting_url, apply_url: p.apply_url ?? null,
        req_id: p.req_id ?? null, date_posted: p.date_posted ?? null,
        deadline: p.deadline ?? null, notes: p.notes ?? null,
        possible_repost_of: p.possible_repost_of ?? null,
      };
      const existing = store.postings.get(p.key);
      if (!existing) {
        emit({ t: "posting_add", key: p.key, fields, delivery_id: delivery.delivery_id, produced_at: delivery.produced_at, first_seen: nyDate(), at: isoNY() });
        counts.added++;
      } else {
        // Stale-update guard: an older delivery must not regress newer values.
        if (existing.last_delivery_produced_at &&
            Date.parse(delivery.produced_at) < Date.parse(existing.last_delivery_produced_at)) {
          store.log("warn", `${filename}: skipped stale update for ${p.key} (delivery is older than the last one that touched it)`);
        } else {
          const mutable = {
            deadline: fields.deadline, notes: fields.notes, posting_url: fields.posting_url,
            apply_url: fields.apply_url, locations: fields.locations, se_rank: fields.se_rank,
            division: fields.division, date_posted: fields.date_posted, tenant: fields.tenant,
          };
          emit({ t: "posting_update", key: p.key, fields: mutable, delivery_id: delivery.delivery_id, produced_at: delivery.produced_at, at: isoNY() });
          counts.updated++;
        }
      }
    }

    // Orphan re-attachment: any stored orphan whose posting now exists becomes
    // a normal pending suggestion (spec section 4 step 6 and section 6 rule 1).
    for (const [id, o] of [...store.orphans]) {
      if (store.postings.has(o.posting_key)) {
        emit({ t: "orphan_attach", id, at: isoNY() });
      }
    }

    // Then suggestions, in delivery order, through the section 6 rules.
    delivery.status_suggestions.forEach((s, i) => {
      const id = `${delivery.delivery_id}#s${i}`;
      const outcome = resolveSuggestion(store, emit, s, id, delivery);
      if (outcome === "applied") counts.sugg_applied++;
      else if (outcome === "pending") counts.sugg_pending++;
      else if (outcome === "noop") counts.sugg_noop++;
      else if (outcome === "orphan") counts.sugg_orphaned++;
    });

    // The commit record, deliberately LAST.
    emit({
      t: "ingest",
      delivery_id: delivery.delivery_id,
      produced_at: delivery.produced_at,
      run_type: delivery.run_type,
      counts,
      duration_ms: Date.now() - started,
      at: isoNY(),
    });

    store.appendEvents(events);
  } catch (e) {
    // An I/O failure mid-apply: in-memory state may be ahead of disk, so
    // rebuild from disk (the torn-write recovery path) and mark the delivery.
    // The Log tab's session lines are runtime-only, so carry them across the
    // recovery replay instead of erasing the whole session's history.
    const savedLog = store.logLines;
    store.replay();
    store.logLines = savedLog;
    store.log("error", "Recovered in-memory state from disk after a failed apply; the log above is intact.");
    writeErrorMarker(store, deliveryPath, "apply", [{ code: "IO_ERROR", message: String(e.message || e), path: null }], "Writing events failed partway. The event log's commit-last rule makes a retry safe.");
    return { ok: false, stage: "apply" };
  }

  // Step 7: refresh the derived exports. The events are already committed, so
  // a failure here must not undo the ingest or crash the app: log it loudly
  // and move on. The next successful action regenerates both exports anyway.
  try {
    store.regenerateExports();
  } catch (e) {
    store.log("error", `The delivery ingested fine, but refreshing state.json/tracker.csv failed (${e.message}). They will refresh on the next action or restart.`);
  }

  // Step 8: archive the delivery.
  archiveDelivery(store, deliveryPath);

  // Step 9: warn older error-marked deliveries that they are now out of order.
  try {
    flagEarlierMarkers(store, filename);
  } catch (e) {
    store.log("warn", `Could not update older error markers (${e.message}).`);
  }

  return { ok: true, counts };
}

// Move an ingested delivery into inbox/processed/, keeping its name.
// A failed move is only logged: the idempotency registry makes the retry a
// harmless no-op next time the watcher sees the file.
function archiveDelivery(store, deliveryPath) {
  try {
    fs.mkdirSync(store.paths.processed, { recursive: true });
    fs.renameSync(deliveryPath, path.join(store.paths.processed, path.basename(deliveryPath)));
  } catch (e) {
    store.log("warn", `Could not move ${path.basename(deliveryPath)} to inbox/processed/ (${e.message}); it will be retried and safely skipped as a duplicate.`);
  }
}

module.exports = {
  SUPPORTED_DELIVERY_VERSIONS, DELIVERY_RE,
  validateDelivery, processDeliveryFile, writeErrorMarker, resolveSuggestion,
};
