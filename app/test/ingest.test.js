// End-to-end tests of the ingest pipeline against the spec's Appendix A
// fixture: first run empty state, full ingest, idempotency, validation
// failures, and export regeneration.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTempStore, dropFixture, makeDelivery, writeDelivery, FIXTURE_NAME, TEST_PREFS } = require("./helpers");
const { processDeliveryFile, validateDelivery } = require("../ingest");

test("first run creates the full skeleton and exact empty-state files", () => {
  const { root, store } = makeTempStore();
  for (const dir of ["data", "inbox", "inbox/processed", "reports", "outreach", "backups", "profile", "cowork"]) {
    assert.ok(fs.existsSync(path.join(root, dir)), `${dir} should exist`);
  }
  assert.equal(fs.readFileSync(store.paths.events, "utf8"), "");
  const state = JSON.parse(fs.readFileSync(store.paths.stateJson, "utf8"));
  assert.equal(state.schema_version, 1);
  assert.ok(typeof state.generated_at === "string");
  assert.deepEqual(state.postings, []);
  assert.deepEqual(state.counts, { total: 0, new: 0, interested: 0, applied: 0, hidden: 0 });
  const tracker = fs.readFileSync(store.paths.trackerCsv, "utf8").trim();
  assert.equal(tracker, "key,company,division,role,category,locations,se_rank,status,hidden,applied_date,deadline,date_posted,first_seen,source,ats,posting_url,apply_url,req_id,portal_email,portal_note,contact_referral,next_followup,notes,status_updated");
});

test("fixture ingest: 6 postings, explicit suggestion applied, email suggestion pending, repost linked", () => {
  const { root, store } = makeTempStore();
  const deliveryPath = dropFixture(root);
  const result = processDeliveryFile(store, deliveryPath);
  assert.equal(result.ok, true);

  // 6 postings ingested.
  assert.equal(store.postings.size, 6);

  // William Blair: explicit suggestion auto-applied with the suggested date.
  const wb = store.postings.get("greenhouse|williamblair|6789012");
  assert.equal(wb.status, "applied");
  assert.equal(wb.applied_date, "2026-08-12");

  // Wells Fargo: non-explicit suggestion is PENDING, status untouched.
  const wf = store.postings.get("workday|wf|r555720");
  assert.equal(wf.status, "new");
  const pendingList = [...store.pending.values()];
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].posting_key, "workday|wf|r555720");
  assert.equal(pendingList[0].suggested_status, "applied");
  assert.equal(pendingList[0].suggested_applied_date, "2026-08-11");

  // The aggregator copy carries its repost pointer to the Workday original.
  const repost = store.postings.get("hash|93a0ce5fbf6ba496");
  assert.equal(repost.possible_repost_of, "workday|fifththird|r123456");

  // Delivery file moved to inbox/processed/.
  assert.ok(!fs.existsSync(deliveryPath));
  assert.ok(fs.existsSync(path.join(root, "inbox", "processed", FIXTURE_NAME)));

  // Exports regenerated with correct counts.
  const state = JSON.parse(fs.readFileSync(store.paths.stateJson, "utf8"));
  assert.equal(state.postings.length, 6);
  assert.deepEqual(state.counts, { total: 6, new: 5, interested: 0, applied: 1, hidden: 0 });
  const tracker = fs.readFileSync(store.paths.trackerCsv, "utf8").trim().split("\n");
  assert.equal(tracker.length, 7); // header + 6 rows

  // A backup exists.
  const backups = fs.readdirSync(store.paths.backups).filter((n) => n.endsWith(".jsonl.gz"));
  assert.equal(backups.length >= 1, true);

  // Idempotency registry knows the delivery.
  assert.ok(store.ingested.has("delivery-20260812-100000-manual-a1b2"));
});

test("idempotency: re-dropping the processed fixture is skipped, nothing double-ingests", () => {
  const { root, store } = makeTempStore();
  processDeliveryFile(store, dropFixture(root));
  const before = JSON.stringify([...store.postings.values()]);

  // Copy the fixture back into inbox unchanged (like the acceptance test).
  const again = dropFixture(root);
  const result = processDeliveryFile(store, again);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(store.postings.size, 6);
  assert.equal(JSON.stringify([...store.postings.values()]), before);
  assert.ok(store.logLines.some((l) => l.text.includes("Duplicate delivery skipped")));
  // The duplicate file was still archived out of inbox.
  assert.ok(!fs.existsSync(again));
});

test("survives a restart: replay rebuilds the same state", () => {
  const { root, store } = makeTempStore();
  processDeliveryFile(store, dropFixture(root));
  store.userSetStatus("workday|fifththird|r123456", "interested");
  store.userSetHidden("hash|29b408b874d74411", true);

  const { Store } = require("../state");
  const reborn = new Store(root);
  reborn.replay();
  assert.equal(reborn.postings.size, 6);
  assert.equal(reborn.postings.get("workday|fifththird|r123456").status, "interested");
  assert.equal(reborn.postings.get("hash|29b408b874d74411").hidden, true);
  assert.equal(reborn.postings.get("greenhouse|williamblair|6789012").status, "applied");
  assert.equal(reborn.pending.size, 1);
  assert.ok(reborn.ingested.has("delivery-20260812-100000-manual-a1b2"));
});

test("confirming the Wells Fargo pending suggestion uses suggested_applied_date", () => {
  const { root, store } = makeTempStore();
  processDeliveryFile(store, dropFixture(root));
  const pending = [...store.pending.values()][0];
  store.confirmSuggestion(pending.id);
  const wf = store.postings.get("workday|wf|r555720");
  assert.equal(wf.status, "applied");
  assert.equal(wf.applied_date, "2026-08-11");
  assert.equal(store.pending.size, 0);
});

test("validation rejects a delivery with a bad enum, nothing ingested", () => {
  const { root, store } = makeTempStore();
  const bad = makeDelivery({
    delivery_id: "delivery-20260813-120000-manual-bad1",
    postings: [{ ...require("./helpers").makePosting("hash|0123456789abcdef"), category: "Wealth" }],
  });
  const deliveryPath = writeDelivery(root, bad);
  const result = processDeliveryFile(store, deliveryPath);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "validate");
  assert.equal(store.postings.size, 0);
  const marker = JSON.parse(fs.readFileSync(deliveryPath + ".error", "utf8"));
  assert.equal(marker.stage, "validate");
  assert.ok(marker.errors.some((e) => e.code === "BAD_ENUM"));
  assert.equal(marker.later_deliveries_processed, false);
  assert.ok(fs.existsSync(deliveryPath)); // delivery left in place
});

test("validation catches id/filename mismatch, bad keys, duplicate keys, unsupported version", () => {
  const { makePosting } = require("./helpers");
  // id mismatch
  let { errors } = validateDelivery(makeDelivery({ delivery_id: "delivery-20260813-120000-manual-aaaa" }), "delivery-20260813-120000-manual-bbbb.json", TEST_PREFS.categories);
  assert.ok(errors.some((e) => e.code === "ID_FILENAME_MISMATCH"));
  // bad key format
  ({ errors } = validateDelivery(makeDelivery({ postings: [makePosting("badkey")] }), "delivery-20260813-120000-manual-zz01.json", TEST_PREFS.categories));
  assert.ok(errors.some((e) => e.code === "BAD_KEY_FORMAT"));
  // duplicate key in delivery
  ({ errors } = validateDelivery(makeDelivery({ postings: [makePosting("hash|0123456789abcdef"), makePosting("hash|0123456789abcdef")] }), "delivery-20260813-120000-manual-zz01.json", TEST_PREFS.categories));
  assert.ok(errors.some((e) => e.code === "DUPLICATE_KEY_IN_DELIVERY"));
  // unsupported schema version goes through processDeliveryFile
  const { root, store } = makeTempStore();
  const deliveryPath = writeDelivery(root, makeDelivery({ delivery_id: "delivery-20260813-120000-manual-ver2", schema_version: 2 }));
  const result = processDeliveryFile(store, deliveryPath);
  assert.equal(result.ok, false);
  const marker = JSON.parse(fs.readFileSync(deliveryPath + ".error", "utf8"));
  assert.ok(marker.errors.some((e) => e.code === "SCHEMA_VERSION_UNSUPPORTED"));
  assert.ok(marker.app_note.includes("Update the app"));
});

test("bad possible_repost_of only drops the pointer; posting still ingests", () => {
  const { root, store } = makeTempStore();
  const { makePosting } = require("./helpers");
  const d = makeDelivery({
    delivery_id: "delivery-20260813-120000-manual-rep1",
    postings: [makePosting("hash|00112233445566aa", { possible_repost_of: "not-a-key" })],
  });
  const result = processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(result.ok, true);
  const p = store.postings.get("hash|00112233445566aa");
  assert.equal(p.possible_repost_of, null);
  assert.ok(store.logLines.some((l) => l.text.includes("possible_repost_of")));
});

test("a later delivery flags an earlier error-marked one", () => {
  const { root, store } = makeTempStore();
  // An early delivery that fails (bad JSON).
  const badPath = path.join(root, "inbox", "delivery-20260810-090000-weekly-ee01.json");
  fs.writeFileSync(badPath, "{ this is not json");
  processDeliveryFile(store, badPath);
  assert.ok(fs.existsSync(badPath + ".error"));
  // A later good delivery ingests fine.
  const result = processDeliveryFile(store, dropFixture(root));
  assert.equal(result.ok, true);
  const marker = JSON.parse(fs.readFileSync(badPath + ".error", "utf8"));
  assert.equal(marker.later_deliveries_processed, true);
});
