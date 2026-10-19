// Tests for removing a row from Action required or Coming up.
//
// The point of the feature is that a removed row is GONE, not greyed out with
// a line through it. These tests pin the two things that make permanent
// removal safe: the removal survives a restart, and it is undoable.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { makeTempStore, writeDelivery, makeDelivery, makePosting } = require("./helpers");
const { processDeliveryFile } = require("../ingest");
const { Store } = require("../state");

const KEY = "hash|0123456789abcdef";
const ID = "action:1a2b3c";

function storeWithPosting() {
  const { root, store } = makeTempStore();
  const delivery = makeDelivery({ postings: [makePosting(KEY, { deadline: "2026-09-10" })] });
  processDeliveryFile(store, writeDelivery(root, delivery));
  assert.ok(store.postings.has(KEY), "fixture posting should be tracked");
  return { root, store };
}

test("dismissing a notice records it against its id", () => {
  const { store } = storeWithPosting();
  assert.equal(store.dismissedNotices.size, 0);

  assert.equal(store.dismissNotice(ID, true, "action", KEY), true);
  assert.ok(store.dismissedNotices.has(ID), "the removed row should be recorded");
  assert.match(store.dismissedNotices.get(ID), /^\d{4}-\d{2}-\d{2}T/);
});

test("undo deletes the entry, so the row comes straight back", () => {
  const { store } = storeWithPosting();
  store.dismissNotice(ID, true, "action", KEY);
  store.dismissNotice(ID, false, "action", KEY);
  assert.equal(store.dismissedNotices.has(ID), false, "undo should clear the removal");
});

test("a removal survives a restart", () => {
  const { root, store } = storeWithPosting();
  store.dismissNotice(ID, true, "upcoming", KEY);

  const replayed = new Store(root);
  replayed.replay();
  assert.ok(replayed.dismissedNotices.has(ID), "replay should rebuild the removal");
});

test("undo survives a restart too (append-only, later truth wins)", () => {
  const { root, store } = storeWithPosting();
  store.dismissNotice(ID, true, "upcoming", KEY);
  store.dismissNotice(ID, false, "upcoming", KEY);

  const replayed = new Store(root);
  replayed.replay();
  assert.equal(replayed.dismissedNotices.has(ID), false, "the undo is the later truth");
});

test("removing a row changes nothing about the posting", () => {
  const { store } = storeWithPosting();
  const before = { ...store.postings.get(KEY) };
  store.dismissNotice(noticeIdish("deadline"), true, "upcoming", KEY);
  const after = store.postings.get(KEY);
  assert.equal(after.status, before.status, "status must not move");
  assert.equal(after.deadline, before.deadline, "the deadline must still be the truth");
  assert.equal(after.hidden, before.hidden, "the posting must not get hidden");
});

test("a blank id is refused rather than written to the log", () => {
  const { root, store } = storeWithPosting();
  const before = fs.readFileSync(store.paths.events, "utf8");
  assert.equal(store.dismissNotice("", true, "action", KEY), false);
  assert.equal(store.dismissNotice(null, true, "action", KEY), false);
  assert.equal(fs.readFileSync(store.paths.events, "utf8"), before, "nothing should be appended");
  assert.equal(store.dismissedNotices.size, 0);
  assert.equal(root.length > 0, true);
});

test("two different rows on one posting are removed independently", () => {
  const { store } = storeWithPosting();
  const deadlineRow = "upcoming:deadline-row";
  const followupRow = "upcoming:followup-row";

  store.dismissNotice(deadlineRow, true, "upcoming", KEY);
  assert.ok(store.dismissedNotices.has(deadlineRow));
  assert.equal(store.dismissedNotices.has(followupRow), false,
    "removing one reminder must not mute the other one on the same posting");
});

// The ids the page builds are content-addressed, so this is really a test of
// the contract the UI relies on: a different action text is a different id and
// therefore shows up even though an older one on the same posting was removed.
function noticeIdish(defining) {
  let h = 2166136261;
  const s = `${KEY} ${defining}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `upcoming:${(h >>> 0).toString(36)}`;
}

test("a different action on the same posting hashes to a different id", () => {
  const first = noticeIdish("ACTION REQUIRED: HireVue|2026-09-05");
  const second = noticeIdish("ACTION REQUIRED: Final interview|2026-09-20");
  assert.notEqual(first, second, "new news must not inherit an old removal");
});
