// Tests for the Moving forward machinery (spec 2.10): NEXT ROUND evidence is
// remembered past its suggestion's resolution, acknowledgments are recorded
// as events (so they survive a restart), and setting the posting to the
// suggested stage acknowledges the news automatically.

const test = require("node:test");
const assert = require("node:assert");
const { Store } = require("../state");
const { processDeliveryFile } = require("../ingest");
const { makeTempStore, makeDelivery, writeDelivery, makePosting } = require("./helpers");

const KEY = "hash|0123456789abcdef";
const NR_EVIDENCE = "NEXT ROUND: Acme Consulting says you are moving to the next stage | recruiter@acme.example, subject \"Update on your application\", received 2026-08-24";

function ingestPostingWithSuggestion(root, store, suggestionOverrides = {}) {
  const delivery = makeDelivery({
    postings: [makePosting(KEY)],
    status_suggestions: [{
      posting_key: KEY,
      suggested_status: "interview",
      evidence: NR_EVIDENCE,
      explicit_user: false,
      observed_at: "2026-08-13T11:00:00-04:00",
      ...suggestionOverrides,
    }],
  });
  const file = writeDelivery(root, delivery);
  const result = processDeliveryFile(store, file);
  assert.equal(result.ok, true);
  return result;
}

test("NEXT ROUND evidence is remembered from a pending suggestion", () => {
  const { root, store } = makeTempStore();
  ingestPostingWithSuggestion(root, store);
  assert.equal(store.pending.size, 1);
  assert.ok(store.nextRound.has(KEY));
  assert.equal(store.nextRound.get(KEY).evidence, NR_EVIDENCE);
});

test("NEXT ROUND evidence survives a rule-2 no-op (the stage-less advancement path)", () => {
  const { root, store } = makeTempStore();
  // Posting arrives applied, then a stage-less advancement email suggests the
  // stage the posting is already at, exactly as playbook R3b instructs.
  const setup = makeDelivery({
    delivery_id: "delivery-20260813-110000-manual-zz00",
    produced_at: "2026-08-13T11:00:00-04:00",
    postings: [makePosting(KEY)],
  });
  processDeliveryFile(store, writeDelivery(root, setup));
  store.userSetStatus(KEY, "applied", "2026-08-13");
  const noopDelivery = makeDelivery({
    status_suggestions: [{
      posting_key: KEY,
      suggested_status: "applied",
      evidence: NR_EVIDENCE,
      explicit_user: false,
      observed_at: "2026-08-13T11:30:00-04:00",
    }],
  });
  const result = processDeliveryFile(store, writeDelivery(root, noopDelivery));
  assert.equal(result.ok, true);
  assert.equal(result.counts.sugg_noop, 1);
  assert.equal(store.pending.size, 0);
  assert.ok(store.nextRound.has(KEY), "no-op resolution must still remember the news");
});

test("Got it records an event, survives replay, and Undo reverses it", () => {
  const { root, store } = makeTempStore();
  ingestPostingWithSuggestion(root, store);
  store.markNextRoundSeen(KEY);
  assert.ok(store.nextRoundSeen.has(KEY));

  const reborn = new Store(root);
  reborn.replay();
  assert.ok(reborn.nextRound.has(KEY), "evidence survives restart");
  assert.ok(reborn.nextRoundSeen.has(KEY), "acknowledgment survives restart");

  store.markNextRoundSeen(KEY, false);
  assert.ok(!store.nextRoundSeen.has(KEY), "Undo clears the acknowledgment");
});

test("setting the posting to a next-round stage auto-acknowledges the news", () => {
  const { root, store } = makeTempStore();
  ingestPostingWithSuggestion(root, store);
  assert.ok(!store.nextRoundSeen.has(KEY));
  store.userSetStatus(KEY, "interview");
  assert.ok(store.nextRoundSeen.has(KEY), "status change acknowledges the strip row");
  // And the pending suggestion for that same status resolved itself too.
  assert.equal(store.pending.size, 0);
});

test("newer NEXT ROUND evidence outranks an older acknowledgment", () => {
  const { root, store } = makeTempStore();
  ingestPostingWithSuggestion(root, store);
  store.markNextRoundSeen(KEY);
  const seenAt = store.nextRoundSeen.get(KEY);
  // A later delivery brings fresh news on the same posting.
  const later = makeDelivery({
    delivery_id: "delivery-20260815-120000-manual-zz02",
    produced_at: "2026-08-15T12:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY,
      suggested_status: "offer",
      evidence: "NEXT ROUND: Offer call scheduled | recruiter@acme.example, received 2026-08-15",
      explicit_user: false,
      observed_at: "2026-08-15T11:00:00-04:00",
    }],
  });
  const result = processDeliveryFile(store, writeDelivery(root, later));
  assert.equal(result.ok, true);
  const rec = store.nextRound.get(KEY);
  assert.match(rec.evidence, /Offer call/);
  assert.ok(!store.nextRoundSeen.has(KEY), "fresh news clears the old Got it, so the strip shows it again");
  assert.ok(seenAt, "the earlier acknowledgment really existed before the fresh news");

  // But re-detecting the SAME email on a later scan keeps the acknowledgment.
  store.markNextRoundSeen(KEY);
  const repeat = makeDelivery({
    delivery_id: "delivery-20260816-120000-manual-zz03",
    produced_at: "2026-08-16T12:00:00-04:00",
    status_suggestions: [{
      posting_key: KEY,
      suggested_status: "offer",
      evidence: "NEXT ROUND: Offer call scheduled | recruiter@acme.example, received 2026-08-15",
      explicit_user: false,
      observed_at: "2026-08-15T11:00:00-04:00",
    }],
  });
  assert.equal(processDeliveryFile(store, writeDelivery(root, repeat)).ok, true);
  assert.ok(store.nextRoundSeen.has(KEY), "a re-detected duplicate must not resurrect an acknowledged row");
});

test("plain ACTION REQUIRED evidence does not populate the next-round map", () => {
  const { root, store } = makeTempStore();
  ingestPostingWithSuggestion(root, store, {
    evidence: "ACTION REQUIRED: Complete the HireVue | DUE: 2026-08-28 | disclaimer | sender",
    suggested_status: "oa",
  });
  assert.ok(!store.nextRound.has(KEY));
  assert.ok(store.actionEvidence.has(KEY));
});
