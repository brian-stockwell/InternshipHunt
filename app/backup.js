// backup.js: safety copies of the event log.
//
// Before every ingest (and once per day at startup) we gzip data/events.jsonl
// into backups/. Restoring is one step: double-click the .gz in Finder to
// expand it, then copy it over data/events.jsonl while the app is stopped.
// Uses Node's built-in zlib; no extra dependencies.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { nyStamp } = require("./lib/util");

const KEEP_NEWEST = 60;

// Make one backup right now. Written to a temp name first, then renamed,
// so a half-written backup can never be mistaken for a real one.
function backupNow(store, reason) {
  let raw;
  try {
    raw = fs.readFileSync(store.paths.events);
  } catch {
    return null; // no event log yet; nothing to back up
  }
  const name = `events-${nyStamp()}.jsonl.gz`;
  const finalPath = path.join(store.paths.backups, name);
  const tmpPath = path.join(store.paths.backups, ".tmp-" + name);
  fs.writeFileSync(tmpPath, zlib.gzipSync(raw));
  fs.renameSync(tmpPath, finalPath);
  store.log("backup", `Backup created: backups/${name} (${reason})`);
  prune(store);
  return name;
}

// Called before every delivery ingest.
function backupBeforeIngest(store) {
  return backupNow(store, "before ingest");
}

// Called once at startup: at most one backup per calendar day from startups.
function backupAtStartupIfNeeded(store) {
  const today = nyStamp().slice(0, 8); // YYYYMMDD
  let names = [];
  try { names = fs.readdirSync(store.paths.backups); } catch { return null; }
  const haveToday = names.some((n) => n.startsWith(`events-${today}-`) && n.endsWith(".jsonl.gz"));
  if (haveToday) return null;
  return backupNow(store, "daily startup backup");
}

// Keep only the newest KEEP_NEWEST backups (names sort chronologically).
function prune(store) {
  let names = [];
  try { names = fs.readdirSync(store.paths.backups); } catch { return; }
  const backups = names.filter((n) => /^events-\d{8}-\d{6}\.jsonl\.gz$/.test(n)).sort();
  while (backups.length > KEEP_NEWEST) {
    const oldest = backups.shift();
    try { fs.unlinkSync(path.join(store.paths.backups, oldest)); } catch { /* ignore */ }
  }
}

module.exports = { backupNow, backupBeforeIngest, backupAtStartupIfNeeded };
