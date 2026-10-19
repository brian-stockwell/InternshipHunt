// Tests for the manual add-posting feature (adding a job you found
// yourself) and the region-rank helper it uses.

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeTempStore, TEST_PREFS } = require("./helpers");
const { computeSeRank, hashKey, Store } = require("../state");

test("computeSeRank follows the spec's region rules", () => {
  assert.equal(computeSeRank(["Tampa, FL"], TEST_PREFS), 1);
  assert.equal(computeSeRank(["Charlotte, NC", "New York, NY"], TEST_PREFS), 1); // best across locations
  assert.equal(computeSeRank(["Nashville, TN"], TEST_PREFS), 1);
  assert.equal(computeSeRank(["Atlanta, GA"], TEST_PREFS), 2);
  assert.equal(computeSeRank(["Richmond, VA"], TEST_PREFS), 2);
  assert.equal(computeSeRank(["Remote (US)"], TEST_PREFS), 2);
  assert.equal(computeSeRank(["New York, NY"], TEST_PREFS), 3);
  assert.equal(computeSeRank([], TEST_PREFS), 3); // unknown location
});

test("manual add creates a posting with a spec-identical hash key", () => {
  const { store } = makeTempStore();
  const result = store.userAddPosting({
    company: "Acme Corp",
    role: "Summer Analyst Intern",
    posting_url: "https://careers.raymondjames.com/example",
    category: "WM",
    locations: ["Tampa, FL"],
    status: "applied",
    applied_date: "2026-08-10",
    user_notes: "Found this one myself at a career fair.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.key, hashKey("Acme Corp", "Summer Analyst Intern", ["Tampa, FL"]));

  const p = store.postings.get(result.key);
  assert.equal(p.status, "applied");
  assert.equal(p.applied_date, "2026-08-10");
  assert.equal(p.se_rank, 1); // Tampa is a priority metro
  assert.equal(p.source, "manual-add");
  assert.equal(p.user_notes, "Found this one myself at a career fair.");
});

test("manual add rejects duplicates and missing fields", () => {
  const { store } = makeTempStore();
  const input = {
    company: "Truist", role: "FP&A Intern",
    posting_url: "https://example.com", category: "CorpFin", locations: [],
  };
  assert.equal(store.userAddPosting(input).ok, true);
  const dup = store.userAddPosting(input);
  assert.ok(dup.error && dup.error.includes("Already tracked"));
  assert.ok(store.userAddPosting({ ...input, company: "" }).error);
  assert.ok(store.userAddPosting({ ...input, company: "Other Co", category: "Wealth" }).error);
});

test("a manually added posting survives a restart", () => {
  const { root, store } = makeTempStore();
  const result = store.userAddPosting({
    company: "PNC", role: "Finance Intern 2027",
    posting_url: "https://example.com/pnc", category: "CorpFin",
    locations: ["Pittsburgh, PA"], status: "interested",
  });
  const reborn = new Store(root);
  reborn.replay();
  const p = reborn.postings.get(result.key);
  assert.equal(p.company, "PNC");
  assert.equal(p.status, "interested");
});
