#!/usr/bin/env node
// helpers.mjs: Cowork researcher utilities for InternshipHunt.
// Interface schema_version 1. See ~/InternshipHunt/INTERFACE-SPEC.md (v1.1, authoritative).
// Subcommands: newname <weekly|session|manual> | now | key "<company>" "<role>" "<loc1;loc2>" | validate <path>

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Key algorithm: copied EXACTLY from INTERFACE-SPEC.md section 9 reference code.
// Do not "improve" this. Changing it is a breaking schema change.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
function norm(s) {
  return s.normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hashKey(company, role, locations) {
  const l = locations.map(norm).sort()[0] || "";
  const input = `${norm(company)}|${norm(role)}|${l}`;
  return "hash|" + crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}
// ---------------------------------------------------------------------------

const STRUCTURED_KEY_RE = /^(workday|greenhouse|lever|ashby|smartrecruiters|icims|oraclecloud|brassring|talentlink|avature|eightfold|usajobs)\|[a-z0-9][a-z0-9._-]*\|[a-z0-9][a-z0-9._-]*$/;
const HASH_KEY_RE = /^hash\|[0-9a-f]{16}$/;
const FILENAME_RE = /^delivery-[0-9]{8}-[0-9]{6}-(weekly|session|manual)-[a-z0-9]{4}\.json$/;
// The category list lives in profile/preferences.json (the same file the app
// reads), so the validator and the app always agree on what is allowed.
const PREFS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "profile", "preferences.json");
const CATEGORIES = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")).categories;
    if (Array.isArray(list) && list.length) return list.map((c) => String(c).trim()).filter(Boolean);
  } catch { /* fall through to the app's defaults */ }
  return ["Finance", "Consulting", "Data", "Software", "Engineering", "Marketing", "Operations", "Other"];
})();
const ATS_ENUM = ["workday", "greenhouse", "lever", "ashby", "smartrecruiters", "icims", "oraclecloud", "brassring", "talentlink", "avature", "eightfold", "usajobs", "other"];
const RUN_TYPES = ["weekly", "session", "manual"];
const SUGGESTED_STATUSES = ["applied", "oa", "interview", "offer", "rejected", "withdrawn", "closed"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 with an explicit numeric UTC offset (Z not allowed; spec requires America/New_York offsets).
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;

function nyParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return p;
}

function nyOffset(date) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" });
  const tz = fmt.formatToParts(date).find((p) => p.type === "timeZoneName").value; // e.g. GMT-04:00
  const m = tz.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-05:00";
}

function nowIso(date = new Date()) {
  const p = nyParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${nyOffset(date)}`;
}

function newName(runType) {
  if (!RUN_TYPES.includes(runType)) {
    die(`newname: run type must be one of ${RUN_TYPES.join(", ")}; got "${runType}"`);
  }
  const p = nyParts(new Date());
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (let i = 0; i < 4; i++) rand += alphabet[crypto.randomInt(alphabet.length)];
  return `delivery-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${runType}-${rand}.json`;
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// validate: the full INTERFACE-SPEC section 4 step 3 checklist.
// ---------------------------------------------------------------------------
function validateDelivery(filePath) {
  const errors = [];
  const err = (path_, msg) => errors.push(`${path_}: ${msg}`);

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [`(read): cannot read ${filePath}: ${e.message}`];
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    return [`(parse): not valid JSON: ${e.message}`];
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return ["(root): not a JSON object"];

  const base = path.basename(filePath).replace(/^\.tmp-/, "");
  if (!FILENAME_RE.test(base)) err("(filename)", `"${base}" does not match the delivery filename pattern`);

  // Top-level required fields and types
  if (!Number.isInteger(d.schema_version)) err("schema_version", "required integer");
  else if (d.schema_version !== 1) err("schema_version", `must be 1 for this playbook; got ${d.schema_version}`);
  if (typeof d.delivery_id !== "string") err("delivery_id", "required string");
  else if (d.delivery_id !== base.replace(/\.json$/, "")) {
    err("delivery_id", `ID_FILENAME_MISMATCH: "${d.delivery_id}" vs filename "${base}"`);
  }
  if (typeof d.produced_at !== "string" || !ISO_OFFSET_RE.test(d.produced_at)) {
    err("produced_at", "required ISO 8601 string with explicit numeric offset");
  }
  if (!RUN_TYPES.includes(d.run_type)) err("run_type", `required, one of ${RUN_TYPES.join("|")}`);
  else if (FILENAME_RE.test(base) && base.split("-")[3] !== d.run_type) {
    err("run_type", `"${d.run_type}" does not match run type in filename "${base}"`);
  }
  if (!Array.isArray(d.postings)) err("postings", "required array");
  if (!Array.isArray(d.status_suggestions)) err("status_suggestions", "required array");
  if (!Array.isArray(d.source_health)) err("source_health", "required array");
  if (typeof d.summary !== "string" || d.summary.length === 0) err("summary", "required non-empty string");
  if (!Array.isArray(d.outreach_files)) err("outreach_files", "required array");
  else d.outreach_files.forEach((f, i) => {
    if (typeof f !== "string") err(`outreach_files[${i}]`, "must be a string basename");
    else if (f.includes("/")) err(`outreach_files[${i}]`, "must be a basename with no path");
  });
  if (d.state_read !== undefined) {
    if (typeof d.state_read !== "object" || d.state_read === null || Array.isArray(d.state_read)) {
      err("state_read", "must be an object when present");
    } else if (typeof d.state_read.stale !== "boolean") {
      err("state_read.stale", "required boolean when state_read present");
    }
  }

  const isKey = (k) => STRUCTURED_KEY_RE.test(k) || HASH_KEY_RE.test(k);
  const optStr = (v) => v === undefined || v === null || typeof v === "string";
  const optDate = (v) => v === undefined || v === null || (typeof v === "string" && DATE_RE.test(v));

  const seenKeys = new Set();
  if (Array.isArray(d.postings)) d.postings.forEach((p, i) => {
    const at = `postings[${i}]`;
    if (typeof p !== "object" || p === null) return err(at, "must be an object");
    if (typeof p.key !== "string" || !isKey(p.key)) err(`${at}.key`, "BAD_KEY_FORMAT: must match structured or hash key regex");
    else {
      if (seenKeys.has(p.key)) err(`${at}.key`, `DUPLICATE_KEY_IN_DELIVERY: ${p.key}`);
      seenKeys.add(p.key);
      if (STRUCTURED_KEY_RE.test(p.key)) {
        if (typeof p.req_id !== "string" || p.req_id.length === 0) err(`${at}.req_id`, "required non-null when key is structured");
        if (p.ats === "other") err(`${at}.ats`, "structured keys are forbidden for ats \"other\"");
      }
    }
    if (typeof p.company !== "string" || !p.company) err(`${at}.company`, "required string");
    if (!optStr(p.division)) err(`${at}.division`, "string or null");
    if (typeof p.role !== "string" || !p.role) err(`${at}.role`, "required string");
    if (!CATEGORIES.includes(p.category)) err(`${at}.category`, `BAD_ENUM: "${p.category}" (allowed: ${CATEGORIES.join(", ")})`);
    if (!Array.isArray(p.locations) || p.locations.some((l) => typeof l !== "string")) {
      err(`${at}.locations`, "required array of strings (may be empty)");
    }
    if (![1, 2, 3].includes(p.se_rank)) err(`${at}.se_rank`, "BAD_ENUM: must be integer 1, 2, or 3");
    if (typeof p.source !== "string" || !p.source) err(`${at}.source`, "required string");
    if (!ATS_ENUM.includes(p.ats)) err(`${at}.ats`, `BAD_ENUM: "${p.ats}" (allowed: ${ATS_ENUM.join(", ")})`);
    if (!optStr(p.tenant)) err(`${at}.tenant`, "string or null");
    if (typeof p.posting_url !== "string" || !/^https?:\/\//.test(p.posting_url)) err(`${at}.posting_url`, "required URL string");
    if (!(p.apply_url === undefined || p.apply_url === null || (typeof p.apply_url === "string" && /^https?:\/\//.test(p.apply_url)))) {
      err(`${at}.apply_url`, "URL string or null");
    }
    if (!optStr(p.req_id)) err(`${at}.req_id`, "string or null");
    if (!optDate(p.date_posted)) err(`${at}.date_posted`, "BAD_DATE: YYYY-MM-DD or null");
    if (!optDate(p.deadline)) err(`${at}.deadline`, "BAD_DATE: YYYY-MM-DD or null");
    if (!optStr(p.notes)) err(`${at}.notes`, "string or null");
    if (!(p.possible_repost_of === undefined || p.possible_repost_of === null || (typeof p.possible_repost_of === "string" && isKey(p.possible_repost_of)))) {
      err(`${at}.possible_repost_of`, "BAD_KEY_FORMAT: must be a valid posting key or null");
    }
  });

  if (Array.isArray(d.status_suggestions)) d.status_suggestions.forEach((s, i) => {
    const at = `status_suggestions[${i}]`;
    if (typeof s !== "object" || s === null) return err(at, "must be an object");
    if (typeof s.posting_key !== "string" || !isKey(s.posting_key)) err(`${at}.posting_key`, "BAD_KEY_FORMAT: must match structured or hash key regex");
    if (!SUGGESTED_STATUSES.includes(s.suggested_status)) {
      err(`${at}.suggested_status`, `BAD_ENUM: "${s.suggested_status}" (allowed: ${SUGGESTED_STATUSES.join(", ")})`);
    }
    if (typeof s.evidence !== "string" || !s.evidence) err(`${at}.evidence`, "required string");
    if (typeof s.explicit_user !== "boolean") err(`${at}.explicit_user`, "required boolean");
    if (!(s.observed_at === undefined || (typeof s.observed_at === "string" && ISO_OFFSET_RE.test(s.observed_at)))) {
      err(`${at}.observed_at`, "ISO 8601 with explicit offset when present");
    }
    if (!(s.suggested_applied_date === undefined || (typeof s.suggested_applied_date === "string" && DATE_RE.test(s.suggested_applied_date)))) {
      err(`${at}.suggested_applied_date`, "BAD_DATE: YYYY-MM-DD when present");
    }
  });

  if (Array.isArray(d.source_health)) d.source_health.forEach((h, i) => {
    const at = `source_health[${i}]`;
    if (typeof h !== "object" || h === null) return err(at, "must be an object");
    if (typeof h.source !== "string" || !h.source) err(`${at}.source`, "required string");
    if (typeof h.tried !== "boolean") err(`${at}.tried`, "required boolean");
    if (!Number.isInteger(h.yield) || h.yield < 0) err(`${at}.yield`, "required integer >= 0");
    if (!(h.note === null || typeof h.note === "string")) err(`${at}.note`, "required, string or null");
  });

  return errors;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case "newname":
    process.stdout.write(newName(args[0]) + "\n");
    break;
  case "now":
    process.stdout.write(nowIso() + "\n");
    break;
  case "key": {
    if (args.length < 3) die('usage: helpers.mjs key "<company>" "<role>" "<loc1;loc2>" (empty string for no locations)');
    const locations = args[2] === "" ? [] : args[2].split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    process.stdout.write(hashKey(args[0], args[1], locations) + "\n");
    break;
  }
  case "validate": {
    if (!args[0]) die("usage: helpers.mjs validate <path-to-delivery.json>");
    const errors = validateDelivery(args[0]);
    if (errors.length === 0) {
      process.stdout.write(`VALID: ${path.basename(args[0])}\n`);
    } else {
      process.stderr.write(`INVALID: ${path.basename(args[0])} (${errors.length} error${errors.length === 1 ? "" : "s"})\n`);
      for (const e of errors) process.stderr.write("  - " + e + "\n");
      process.exit(1);
    }
    break;
  }
  default:
    die("usage: helpers.mjs <newname|now|key|validate> ...");
}
