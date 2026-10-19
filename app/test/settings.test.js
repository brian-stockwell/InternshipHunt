// Tests for data/settings.json and the Store accessors that read and write it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeTempStore } = require("./helpers");

test("settings default to alerts on when the file does not exist", () => {
  const { root, store } = makeTempStore();
  assert.equal(fs.existsSync(path.join(root, "data", "settings.json")), false);
  assert.deepEqual(store.readSettings(), { macNotifications: true });
});

test("writeSettings persists and readSettings reads it back", () => {
  const { root, store } = makeTempStore();
  const next = store.writeSettings({ macNotifications: false });
  assert.equal(next.macNotifications, false);
  assert.equal(store.readSettings().macNotifications, false);

  // Survives a fresh Store over the same root, i.e. an app restart.
  const { Store } = require("../state");
  const reopened = new Store(root);
  assert.equal(reopened.readSettings().macNotifications, false);
});

test("a corrupt or empty settings file falls back to alerts on", () => {
  const { root, store } = makeTempStore();
  const file = path.join(root, "data", "settings.json");
  for (const junk of ["", "{", "null", "[]", '"nope"']) {
    fs.writeFileSync(file, junk);
    assert.equal(store.readSettings().macNotifications, true, `junk: ${junk}`);
  }
});
