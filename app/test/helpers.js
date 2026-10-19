// Shared test scaffolding: build a throwaway InternshipHunt root folder in
// the system temp directory so tests never touch real data.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store, ensureSkeleton, makePaths } = require("../state");

const FIXTURE_NAME = "delivery-20260812-100000-manual-a1b2.json";
const FIXTURE_PATH = path.join(__dirname, "fixture-delivery.json");

// Preferences every temp root gets, so the fixtures' categories and cities
// stay valid no matter what the real profile/preferences.json says.
const TEST_PREFS = {
  email_addresses: ["me@example.com"],
  categories: ["WM", "PWM", "CommBank", "CorpFin", "Data", "Insight", "Federal"],
  rank1_label: "priority city",
  rank1_cities: ["tampa", "charlotte", "nashville", "miami", "fort lauderdale", "palm beach", "boca raton"],
  rank2_label: "Southeast",
  rank2_states: ["FL", "GA", "AL", "MS", "LA", "SC", "NC", "TN", "KY", "VA"],
  remote_is_rank2: true,
};

// Create a fresh temp root with the full folder skeleton and a replayed Store.
function makeTempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internshiphunt-test-"));
  ensureSkeleton(makePaths(root));
  fs.writeFileSync(path.join(root, "profile", "preferences.json"), JSON.stringify(TEST_PREFS, null, 2));
  const store = new Store(root);
  store.replay();
  store.regenerateExports();
  return { root, store };
}

// Copy the Appendix A fixture into the temp root's inbox under its real name.
function dropFixture(root, name = FIXTURE_NAME) {
  const dest = path.join(root, "inbox", name);
  fs.copyFileSync(FIXTURE_PATH, dest);
  return dest;
}

// Build a minimal valid delivery object for rule-by-rule suggestion tests.
// Callers override the parts they care about.
function makeDelivery(overrides = {}) {
  const id = overrides.delivery_id || "delivery-20260813-120000-manual-zz01";
  return {
    schema_version: 1,
    delivery_id: id,
    produced_at: "2026-08-13T12:00:00-04:00",
    run_type: "manual",
    postings: [],
    status_suggestions: [],
    source_health: [],
    summary: "test delivery",
    outreach_files: [],
    ...overrides,
  };
}

// Write a delivery object into inbox/ under its own filename.
function writeDelivery(root, delivery) {
  const dest = path.join(root, "inbox", delivery.delivery_id + ".json");
  fs.writeFileSync(dest, JSON.stringify(delivery, null, 2));
  return dest;
}

// A minimal valid posting object for constructed deliveries.
function makePosting(key, overrides = {}) {
  return {
    key,
    company: "Test Company",
    division: null,
    role: "Test Intern Role",
    category: "WM",
    locations: ["Tampa, FL"],
    se_rank: 1,
    source: "test-source",
    ats: "other",
    tenant: null,
    posting_url: "https://example.com/job",
    apply_url: null,
    req_id: null,
    date_posted: null,
    deadline: null,
    notes: null,
    possible_repost_of: null,
    ...overrides,
  };
}

module.exports = { makeTempStore, dropFixture, makeDelivery, writeDelivery, makePosting, FIXTURE_NAME, TEST_PREFS };
