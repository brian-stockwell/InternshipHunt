// Torn-write recovery (acceptance checklist item 8).
//
// Simulates a crash that wrote a delivery's event batch WITHOUT the final
// ingest commit event. On replay, the delivery must NOT be in the idempotency
// registry, and re-ingesting the same file must converge to the same final
// state with no duplicates. The commit-event-LAST rule is what makes this work.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { makeTempStore, dropFixture } = require("./helpers");
const { processDeliveryFile } = require("../ingest");
const { Store } = require("../state");

// Strip volatile per-run fields so two stores' postings can be compared.
function snapshot(store) {
  return [...store.postings.values()]
    .map((p) => {
      const { status_updated, last_manual_status_at, first_seen, ...rest } = p;
      return rest;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

test("torn write: batch without commit event is not registered and re-ingest converges", () => {
  // Reference run: a clean, complete ingest in its own temp root.
  const clean = makeTempStore();
  processDeliveryFile(clean.store, dropFixture(clean.root));
  const referenceState = snapshot(clean.store);

  // Torn run: ingest fully, then surgically remove the final ingest commit
  // line from events.jsonl, exactly what a torn append would leave behind.
  const torn = makeTempStore();
  processDeliveryFile(torn.store, dropFixture(torn.root));
  const lines = fs.readFileSync(torn.store.paths.events, "utf8").trim().split("\n");
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEvent.t, "ingest", "the commit event must be the LAST line of the batch");
  fs.writeFileSync(torn.store.paths.events, lines.slice(0, -1).join("\n") + "\n");

  // Replay after the "crash": postings exist, but the delivery is NOT in the
  // idempotency registry, so it is eligible for re-ingest.
  const reborn = new Store(torn.root);
  reborn.replay();
  assert.equal(reborn.ingested.has("delivery-20260812-100000-manual-a1b2"), false);
  assert.equal(reborn.postings.size, 6);

  // Re-ingest the same delivery (it was archived; copy it back like a retry).
  const again = dropFixture(torn.root);
  const result = processDeliveryFile(reborn, again);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined, "must re-apply, not skip: the commit record was missing");

  // Converged: same postings as the clean run, no duplicates, registry set.
  assert.equal(reborn.postings.size, 6);
  assert.deepEqual(snapshot(reborn), referenceState);
  assert.equal(reborn.ingested.has("delivery-20260812-100000-manual-a1b2"), true);
  assert.equal(reborn.pending.size, 1, "the pending suggestion must not duplicate");

  // William Blair's explicit suggestion re-resolves as a no-op (already
  // applied), not a second application.
  const wb = reborn.postings.get("greenhouse|williamblair|6789012");
  assert.equal(wb.status, "applied");
  assert.equal(wb.applied_date, "2026-08-12");

  // And a final replay of the repaired log reproduces the same state again.
  const finalCheck = new Store(torn.root);
  finalCheck.replay();
  assert.deepEqual(snapshot(finalCheck), referenceState);
  assert.equal(finalCheck.pending.size, 1);
});

test("replay tolerates a torn (half-written) final line", () => {
  const { root, store } = makeTempStore();
  processDeliveryFile(store, dropFixture(root));
  // Simulate a crash mid-append: garbage half-line at the end of the log.
  fs.appendFileSync(store.paths.events, '{"t":"status","key":"workday|wf|r5557');
  const reborn = new Store(root);
  reborn.replay();
  assert.equal(reborn.postings.size, 6);
  assert.ok(reborn.logLines.some((l) => l.kind === "warn" && l.text.includes("unreadable line")));
});
