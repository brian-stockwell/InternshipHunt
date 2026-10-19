// Unit tests for the status suggestion resolution rules (spec section 6),
// covering the four acceptance scenarios in checklist item 9.

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeTempStore, makeDelivery, writeDelivery, makePosting } = require("./helpers");
const { processDeliveryFile } = require("../ingest");

const KEY = "hash|aaaabbbbcccc0001";

// Seed a store with one posting via a normal delivery.
function seedPosting(root, store, overrides = {}) {
  const d = makeDelivery({
    delivery_id: "delivery-20260810-080000-manual-sd01",
    produced_at: "2026-08-10T08:00:00-04:00",
    postings: [makePosting(KEY, overrides)],
  });
  processDeliveryFile(store, writeDelivery(root, d));
}

test("explicit suggestion beats an existing pending duplicate (the blocker scenario)", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);

  // First: a non-explicit "applied" suggestion becomes pending.
  const d1 = makeDelivery({
    delivery_id: "delivery-20260811-090000-weekly-em01",
    produced_at: "2026-08-11T09:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "confirmation email", explicit_user: false,
      observed_at: "2026-08-11T08:00:00-04:00", suggested_applied_date: "2026-08-11",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d1));
  assert.equal(store.pending.size, 1);
  assert.equal(store.postings.get(KEY).status, "new");

  // Then: The user's explicit "mark applied" must NOT be absorbed by the
  // pending duplicate; it applies immediately and supersedes the pending one.
  const d2 = makeDelivery({
    delivery_id: "delivery-20260812-190000-session-ex01",
    produced_at: "2026-08-12T19:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "The user said 'mark it applied' in the session", explicit_user: true,
      observed_at: "2026-08-12T18:55:00-04:00", suggested_applied_date: "2026-08-12",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d2));
  const p = store.postings.get(KEY);
  assert.equal(p.status, "applied");
  assert.equal(p.applied_date, "2026-08-12");
  assert.equal(store.pending.size, 0); // pending duplicate superseded
});

test("a manual UI change AFTER the suggestion's observed_at wins", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);

  // The user manually marks it rejected NOW (long after the fixture timestamps).
  store.userSetStatus(KEY, "rejected");

  // An explicit suggestion observed BEFORE that manual change must no-op.
  // (observed_at is in the past relative to the manual click above, which
  // happened "now" during this test run.)
  const d = makeDelivery({
    delivery_id: "delivery-20260813-100000-session-old1",
    produced_at: "2026-08-13T10:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "The user said so earlier", explicit_user: true,
      observed_at: "2026-08-09T10:00:00-04:00",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(store.postings.get(KEY).status, "rejected");
  assert.ok(store.logLines.some((l) => l.text.includes("manual change is newer")));
});

test("the primary flow works: interested first, then explicit applied wins", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);
  store.userSetStatus(KEY, "interested"); // manual, but BEFORE the user speaks

  const futureIso = new Date(Date.now() + 60000).toISOString().replace("Z", "+00:00");
  const d = makeDelivery({
    delivery_id: "delivery-20260814-190000-session-flw1",
    produced_at: "2026-08-14T19:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "The user said 'mark applied' in the session", explicit_user: true,
      observed_at: futureIso, suggested_applied_date: "2026-08-14",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  const p = store.postings.get(KEY);
  assert.equal(p.status, "applied");
  assert.equal(p.applied_date, "2026-08-14");
});

test("'closed' auto-applies on a new posting but goes pending on an applied one", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store); // status: new
  const KEY2 = "hash|aaaabbbbcccc0002";
  const d0 = makeDelivery({
    delivery_id: "delivery-20260810-081000-manual-sd02",
    produced_at: "2026-08-10T08:10:00-04:00",
    postings: [makePosting(KEY2)],
  });
  processDeliveryFile(store, writeDelivery(root, d0));
  store.userSetStatus(KEY2, "applied", "2026-08-10");

  const d = makeDelivery({
    delivery_id: "delivery-20260817-190000-weekly-cl01",
    produced_at: "2026-08-17T19:00:00-04:00",
    status_suggestions: [
      { posting_key: KEY, suggested_status: "closed", evidence: "posting link is dead", explicit_user: false },
      { posting_key: KEY2, suggested_status: "closed", evidence: "posting link is dead", explicit_user: false },
    ],
  });
  processDeliveryFile(store, writeDelivery(root, d));

  // New posting: auto-closed (destroys nothing, trivially reversible).
  assert.equal(store.postings.get(KEY).status, "closed");
  // Applied posting: waits for the user.
  assert.equal(store.postings.get(KEY2).status, "applied");
  const pend = [...store.pending.values()];
  assert.equal(pend.length, 1);
  assert.equal(pend[0].posting_key, KEY2);
  assert.equal(pend[0].suggested_status, "closed");
});

test("an orphan suggestion attaches as pending when its posting arrives later", () => {
  const { root, store } = makeTempStore();

  // Suggestion for a posting nobody has ever seen.
  const d1 = makeDelivery({
    delivery_id: "delivery-20260811-090000-weekly-or01",
    produced_at: "2026-08-11T09:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "confirmation email for a posting not yet delivered", explicit_user: false,
      suggested_applied_date: "2026-08-10",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d1));
  assert.equal(store.orphans.size, 1);
  assert.equal(store.pending.size, 0);

  // The posting arrives in a later delivery: orphan becomes pending.
  const d2 = makeDelivery({
    delivery_id: "delivery-20260818-190000-weekly-or02",
    produced_at: "2026-08-18T19:00:00-04:00",
    postings: [makePosting(KEY)],
  });
  processDeliveryFile(store, writeDelivery(root, d2));
  assert.equal(store.orphans.size, 0);
  assert.equal(store.pending.size, 1);
  const pend = [...store.pending.values()][0];
  assert.equal(pend.posting_key, KEY);
  assert.equal(pend.suggested_status, "applied");

  // And the user's one-click confirm applies it with the suggested date.
  store.confirmSuggestion(pend.id);
  assert.equal(store.postings.get(KEY).status, "applied");
  assert.equal(store.postings.get(KEY).applied_date, "2026-08-10");
});

test("suggestion for the current status resolves as a logged no-op", () => {
  const { root, store } = makeTempStore();
  seedPosting(root, store);
  store.userSetStatus(KEY, "applied", "2026-08-12");
  const d = makeDelivery({
    delivery_id: "delivery-20260817-190100-weekly-no01",
    produced_at: "2026-08-17T19:01:00-04:00",
    status_suggestions: [{
      posting_key: KEY, suggested_status: "applied",
      evidence: "confirmation email re-detected", explicit_user: false,
      observed_at: "2026-08-12T10:00:00-04:00",
    }],
  });
  processDeliveryFile(store, writeDelivery(root, d));
  assert.equal(store.pending.size, 0);
  assert.ok(store.logLines.some((l) => l.text.includes("noop") && l.text.includes("already applied")));
});
