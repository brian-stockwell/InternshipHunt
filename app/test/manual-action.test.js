// Tests for manually added ACTION REQUIRED entries: the ones the user learns
// about by text or phone, which the researcher's email scan can never see.

const test = require("node:test");
const assert = require("node:assert");
const { makeTempStore, writeDelivery, makeDelivery, makePosting } = require("./helpers");
const { processDeliveryFile } = require("../ingest");
const { Store } = require("../state");

const KEY = "hash|0123456789abcdef";

// A store with one real posting to hang actions on.
function storeWithPosting() {
  const { root, store } = makeTempStore();
  const delivery = makeDelivery({ postings: [makePosting(KEY)] });
  processDeliveryFile(store, writeDelivery(root, delivery));
  assert.ok(store.postings.has(KEY), "fixture posting should be tracked");
  return { root, store };
}

test("a manual action lands in actionEvidence in the researcher's own format", () => {
  const { store } = storeWithPosting();
  const res = store.userAddAction({
    key: KEY,
    what: "Complete the HireVue for the Commercial Banking internship",
    due: "2026-09-05",
    note: "Text from a recruiter on Aug 24",
  });
  assert.deepEqual(res, { ok: true });

  const rec = store.actionEvidence.get(KEY);
  assert.ok(rec, "the banner map should now have an entry");
  assert.match(rec.evidence, /^ACTION REQUIRED: Complete the HireVue/);
  assert.match(rec.evidence, /\| DUE: 2026-09-05 \|/);
  assert.match(rec.evidence, /Text from a recruiter on Aug 24$/);
});

test("no due date is recorded as 'not stated', and the note defaults", () => {
  const { store } = storeWithPosting();
  store.userAddAction({ key: KEY, what: "Call the recruiter back" });
  const { evidence } = store.actionEvidence.get(KEY);
  assert.match(evidence, /\| DUE: not stated \|/);
  assert.match(evidence, /Added by hand in the app/);
});

test("pipes in user text cannot corrupt the evidence field separators", () => {
  const { store } = storeWithPosting();
  store.userAddAction({ key: KEY, what: "Do this | DUE: 1999-01-01 | and that" });
  const { evidence } = store.actionEvidence.get(KEY);
  // Exactly the two separators the format defines, no smuggled third field.
  assert.equal(evidence.split("|").length - 1, 2, evidence);
  assert.match(evidence, /\| DUE: not stated \|/, "the injected DUE must not win");
});

test("bad input is rejected without writing an event", () => {
  const { store } = storeWithPosting();
  const before = store.actionEvidence.size;

  assert.match(store.userAddAction({ key: "hash|deadbeefdeadbeef", what: "x" }).error, /Pick which posting/);
  assert.match(store.userAddAction({ key: KEY, what: "   " }).error, /Say what you need to do/);
  assert.match(store.userAddAction({ key: KEY, what: "x", due: "2026-02-31" }).error, /real date/);
  assert.match(store.userAddAction({ key: KEY, what: "x".repeat(301) }).error, /under 300/);

  assert.equal(store.actionEvidence.size, before, "nothing should have been recorded");
});

test("a manual action survives replay and outranks an earlier 'I did this'", () => {
  const { root, store } = storeWithPosting();
  // He ticks off the old action first, then a new one arrives by text.
  store.markActionDone(KEY, true);
  store.userAddAction({ key: KEY, what: "New assessment from a text", due: "2026-09-30" });

  const reopened = new Store(root);
  reopened.replay();
  const rec = reopened.actionEvidence.get(KEY);
  assert.match(rec.evidence, /New assessment from a text/, "replay must rebuild it");

  // Adding an action explicitly clears the old done mark, so the banner shows
  // the new row no matter how close together the two clicks were. Relying on
  // a newer-than timestamp comparison would fail inside a single second.
  assert.equal(reopened.actionDone.has(KEY), false,
    "the stale done mark must be cleared, or the new action stays hidden");
});
