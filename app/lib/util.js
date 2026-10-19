// Small shared helpers used by every other file.
// Nothing clever in here: time formatting, safe file writes, CSV escaping.

const fs = require("fs");
const path = require("path");

// ---------- Time helpers ----------
// Every timestamp in this system is ISO 8601 in America/New_York with an
// explicit offset, like "2026-08-17T19:30:02-04:00". The spec requires this.

// Figure out New York's UTC offset (in minutes) for a given moment.
// Handles daylight saving automatically because we ask the Intl library
// what the wall clock in New York reads at that moment.
function nyOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Current (or given) moment as an ISO string with the New York offset.
function isoNY(date = new Date()) {
  const off = nyOffsetMinutes(date);
  const shifted = new Date(date.getTime() + off * 60000);
  const p = (n) => String(n).padStart(2, "0");
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

// The New York calendar date ("YYYY-MM-DD") for a given moment.
function nyDate(dateOrIso = new Date()) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  // en-CA locale formats dates as YYYY-MM-DD, which is exactly what we need.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// Compact timestamp for backup filenames: YYYYMMDD-HHMMSS in New York time.
function nyStamp(date = new Date()) {
  const iso = isoNY(date); // "2026-08-17T19:30:02-04:00"
  return iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");
}

// ---------- Atomic file writes ----------
// Rule from the spec: no reader may ever see a half-written file.
// So we always write to a dot-prefixed temp name in the SAME directory,
// then rename it over the destination. On macOS that rename is atomic.
function atomicWriteFileSync(finalPath, content) {
  const dir = path.dirname(finalPath);
  const tmp = path.join(dir, ".tmp-" + path.basename(finalPath));
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, finalPath);
}

// ---------- CSV ----------
// Quote a value if it contains anything that would confuse a CSV parser.
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// A real calendar date, not just date-shaped: Date.parse would happily roll
// "2026-02-31" over to March, so parse and compare the components back. Lives
// here because both the delivery validator and the manual-entry paths need it.
function isCalendarDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = { isoNY, nyDate, nyStamp, atomicWriteFileSync, csvEscape, isCalendarDate };
