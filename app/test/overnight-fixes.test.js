// Tests for the overnight improvement pass (2026-08-11): confirm-path guards,
// orphan lifecycle, action evidence preservation, stricter validation, and
// the self-resolving suggestion behavior.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { makeTempStore, makeDelivery, writeDelivery, makePosting, TEST_PREFS } = require("./helpers");
const { processDeliveryFile, validateDelivery } = require("../ingest");
const { Store } = require("../state");

const KEY = "hash|aaaabbbbcccc0001";

function seedPosting(root, store, overrides = {}) {
  const d = makeDelivery({
    delivery_id: "delivery-20260810-080000-manual-sd01",
    produced_at: "2026-08-10T08:00:00-04:00",
    postings: [makePosting(KEY, overrides)],
  });
  processDeliveryFile(store, writeDelivery(root, d));
}

// ---------------------------------------------------------------------------
// Confirm-path guards
// ---------------------------------------------------------------------------

test("confirming a suggestion whose status already matches resolves without a status event", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);
  const d = makeDelivery({
    delivery_id: "delivery-20260811-090000-weekly-cg01",
    produced_at: "2026-08-11T09:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "confirmation email", explicit_user: false,
      suggested_applied_date: "2026-08-10",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  // The user applies himself: the pending suggestion self-resolves right there.
  store.userSetStatus(KEY, "applied", "2026-08-10");
  assert.equal(store.pending.size, 0, "suggestion should self-resolve when the status catches up");
  assert.equal(store.postings.get(KEY).status, "applied");
});

test("confirming a stale suggestion never walks the status backwards", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);
  const d = makeDelivery({
    delivery_id: "delivery-20260811-090100-weekly-cg02",
    produced_at: "2026-08-11T09:01:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "confirmation email", explicit_user: false,
      observed_at: "2026-08-11T08:00:00-04:00",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(store.pending.size, 1);
  // The user moved on to interview himself, AFTER the suggestion was observed.
  store.userSetStatus(KEY, "interview");
  // The pending "applied" suggestion is still there (different status), but
  // confirming it must not regress interview back to applied.
  const id = [...store.pending.keys()][0];
  const ok = store.confirmSuggestion(id);
  assert.equal(ok, true);
  assert.equal(store.postings.get(KEY).status, "interview", "status must not walk backwards");
  assert.equal(store.pending.size, 0, "the stale suggestion is resolved, not left dangling");
});

// ---------------------------------------------------------------------------
// Action evidence survives no-op resolutions (the vanishing-deadline hole)
// ---------------------------------------------------------------------------

test("an ACTION REQUIRED suggestion that no-ops still records its evidence", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);
  store.userSetStatus(KEY, "applied", "2026-08-10");
  const evidence = "ACTION REQUIRED: Upload transcript to the portal | DUE: 2026-08-15 | InternshipHunt does not track these. | employer email 2026-08-11";
  const d = makeDelivery({
    delivery_id: "delivery-20260811-100000-manual-ae01",
    produced_at: "2026-08-11T10:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence, explicit_user: false,
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  // Rule 2 no-op (already applied), but the deadline must not vanish.
  assert.equal(store.pending.size, 0);
  assert.ok(store.actionEvidence.has(KEY), "action evidence must survive the no-op");
  assert.ok(store.actionEvidence.get(KEY).evidence.includes("Upload transcript"));

  // And it survives a restart, because the resolution event carries it.
  const reborn = new Store(root);
  reborn.replay();
  assert.ok(reborn.actionEvidence.has(KEY));
});

// ---------------------------------------------------------------------------
// Orphan lifecycle: dismiss, and add-under-the-orphan's-key
// ---------------------------------------------------------------------------

test("an orphan can be dismissed, and the dismissal survives replay", () => {
  const { root, store } = makeTempStore();
  const d = makeDelivery({
    delivery_id: "delivery-20260811-110000-manual-or01",
    produced_at: "2026-08-11T11:00:00-04:00",
    status_suggestions: [{
      posting_key: "workday|acmeaero|jr123", suggested_status: "applied",
      evidence: "confirmation email", explicit_user: false,
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(store.orphans.size, 1);
  const id = [...store.orphans.keys()][0];
  assert.equal(store.dismissOrphan(id), true);
  assert.equal(store.orphans.size, 0);
  const reborn = new Store(root);
  reborn.replay();
  assert.equal(reborn.orphans.size, 0);
});

test("adding a posting under an orphan's key attaches the orphan as pending", () => {
  const { root, store } = makeTempStore();
  const orphanKey = "workday|acmeaero|jr0004417";
  const d = makeDelivery({
    delivery_id: "delivery-20260811-110100-manual-or02",
    produced_at: "2026-08-11T11:01:00-04:00",
    status_suggestions: [{
      posting_key: orphanKey, suggested_status: "applied",
      evidence: "Acme Aerospace confirmation email", explicit_user: false,
      suggested_applied_date: "2026-08-03",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(store.orphans.size, 1);

  const result = store.userAddPosting({
    key: orphanKey,
    company: "Acme Aerospace", role: "Data Analytics Intern",
    posting_url: "https://example.com/jobs/acme-aerospace", category: "Data",
    locations: [], status: "applied", applied_date: "2026-08-03",
  });
  assert.equal(result.ok, true);
  assert.equal(result.key, orphanKey);
  assert.equal(store.orphans.size, 0, "orphan attached");
  // The attached suggestion then self-resolved, because the posting was added
  // already in the suggested status. Nothing left to nag about.
  assert.equal(store.pending.size, 0);
  assert.equal(store.postings.get(orphanKey).status, "applied");

  // Survives restart.
  const reborn = new Store(root);
  reborn.replay();
  assert.equal(reborn.postings.get(orphanKey).company, "Acme Aerospace");
  assert.equal(reborn.orphans.size, 0);
});

test("userAddPosting rejects a malformed key and a non-http link", () => {
  const { store } = makeTempStore();
  const base = { company: "X", role: "Y", posting_url: "https://example.com", category: "WM", locations: [] };
  assert.ok(store.userAddPosting({ ...base, key: "not-a-key" }).error);
  assert.ok(store.userAddPosting({ ...base, posting_url: "javascript:alert(1)" }).error);
});

// ---------------------------------------------------------------------------
// Stricter validation
// ---------------------------------------------------------------------------

test("validator rejects impossible calendar dates and non-http URLs", () => {
  const good = makePosting("hash|0123456789abcdef");
  let { errors } = validateDelivery(
    makeDelivery({ postings: [{ ...good, deadline: "2026-02-31" }] }),
    "delivery-20260813-120000-manual-zz01.json", TEST_PREFS.categories);
  assert.ok(errors.some((e) => e.code === "BAD_DATE"), "2026-02-31 must not pass");

  ({ errors } = validateDelivery(
    makeDelivery({ postings: [{ ...good, posting_url: "javascript:alert(1)" }] }),
    "delivery-20260813-120000-manual-zz01.json", TEST_PREFS.categories));
  assert.ok(errors.some((e) => e.code === "BAD_TYPE"), "javascript: URL must not pass");

  ({ errors } = validateDelivery(
    makeDelivery({ postings: [good] }),
    "delivery-20260813-120000-manual-zz01.json", TEST_PREFS.categories));
  assert.equal(errors.length, 0, "a normal posting still passes");
});

// ---------------------------------------------------------------------------
// Crash resistance: a failing exports write must not kill the ingest
// ---------------------------------------------------------------------------

test("a delivery still ingests when the exports refresh fails", () => {
  const { root, store } = makeTempStore();
  const d = makeDelivery({
    delivery_id: "delivery-20260811-120000-manual-cr01",
    produced_at: "2026-08-11T12:00:00-04:00",
    postings: [makePosting("hash|ccccddddeeee0001")],
  });
  const deliveryPath = writeDelivery(root, d);
  const original = store.regenerateExports.bind(store);
  store.regenerateExports = () => { throw new Error("disk full (simulated)"); };
  const result = processDeliveryFile(store, deliveryPath);
  store.regenerateExports = original;
  assert.equal(result.ok, true, "ingest must survive an exports failure");
  assert.ok(store.ingested.has("delivery-20260811-120000-manual-cr01"));
  assert.ok(store.logLines.some((l) => l.text.includes("refreshing state.json")));
  // The delivery was still archived out of the inbox.
  assert.ok(!fs.existsSync(deliveryPath));
});
