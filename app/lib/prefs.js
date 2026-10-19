// prefs.js: what this person is hunting for, in their own words.
//
// The posting categories, the three location ranks, and the email addresses
// live in profile/preferences.json so each person tunes them during setup
// (START-HERE.md) without touching code. The app reads the file once at
// startup: restart the app after editing it (`ih restart`).

const fs = require("fs");
const path = require("path");

// Used only when profile/preferences.json is missing or unreadable.
const DEFAULT_PREFS = {
  email_addresses: [],
  categories: ["Finance", "Consulting", "Data", "Software", "Engineering", "Marketing", "Operations", "Other"],
  rank1_label: "top choice",
  rank1_cities: [],
  rank2_label: "good fit",
  rank2_states: [],
  remote_is_rank2: true,
};

function cleanList(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : null;
}

function loadPrefs(root) {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(path.join(root, "profile", "preferences.json"), "utf8")) || {};
  } catch { /* missing or unparseable: defaults below */ }
  const categories = cleanList(doc.categories);
  return {
    email_addresses: cleanList(doc.email_addresses) || [],
    categories: categories && categories.length ? categories : DEFAULT_PREFS.categories,
    rank1_label: String(doc.rank1_label || DEFAULT_PREFS.rank1_label),
    rank1_cities: (cleanList(doc.rank1_cities) || []).map((c) => c.toLowerCase()),
    rank2_label: String(doc.rank2_label || DEFAULT_PREFS.rank2_label),
    rank2_states: (cleanList(doc.rank2_states) || []).map((s) => s.toUpperCase()),
    remote_is_rank2: doc.remote_is_rank2 !== false,
  };
}

// The se_rank rules (spec section 2.1), driven by preferences.json:
// 1 = a top-choice city, 2 = a good-fit state (or "Remote (US)" when
// remote_is_rank2 is on), 3 = everything else including unknown. The best
// rank across all of a posting's locations wins.
function computeSeRank(locations, prefs = DEFAULT_PREFS) {
  let rank = 3;
  for (const loc of locations || []) {
    const text = String(loc);
    if (prefs.rank1_cities.some((c) => text.toLowerCase().includes(c))) return 1;
    const m = text.match(/,\s*([A-Z]{2})\s*$/);
    if ((m && prefs.rank2_states.includes(m[1])) ||
        (prefs.remote_is_rank2 && /^remote\s*\(us\)$/i.test(text.trim()))) rank = 2;
  }
  return rank;
}

module.exports = { DEFAULT_PREFS, loadPrefs, computeSeRank };
