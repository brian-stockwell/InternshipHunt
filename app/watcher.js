// watcher.js: the mail room.
//
// Watches inbox/ for delivery files and hands them to the ingest pipeline
// strictly one at a time, in ascending filename order (which the naming
// convention guarantees is chronological order). Also does a full sweep at
// startup so deliveries dropped while the app was closed are never missed.
//
// macOS fs.watch reports renames and in-place changes inconsistently, so we
// react to ANY event by re-scanning the folder, and we deduplicate by each
// file's (mtime, size) signature so unchanged files are not reprocessed.

const fs = require("fs");
const path = require("path");
const { DELIVERY_RE, processDeliveryFile } = require("./ingest");

const SETTLE_MS = 500;       // wait before reading a newly seen file
const PARSE_RETRY_MS = 2000; // one extra chance for a slow-copying writer

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InboxWatcher {
  constructor(store, { onAfterIngest } = {}) {
    this.store = store;
    this.onAfterIngest = onAfterIngest || (() => {});
    this.seenSignatures = new Map();   // basename -> "mtimeMs:size" of last handled version
    this.strayLogged = new Set();      // non-delivery files we already logged this run
    this.queue = [];                   // basenames waiting to be processed
    this.processing = false;
    this.fsWatcher = null;
  }

  start() {
    this.scan(); // startup sweep
    try {
      this.fsWatcher = fs.watch(this.store.paths.inbox, () => {
        try { this.scan(); } catch (e) {
          this.store.log("error", `Inbox scan failed (${e.message}); will try again on the next event.`);
        }
      });
    } catch (e) {
      this.store.log("warn", `Could not watch inbox/ (${e.message}); deliveries will only be picked up at startup.`);
    }
  }

  stop() {
    if (this.fsWatcher) { this.fsWatcher.close(); this.fsWatcher = null; }
  }

  signatureOf(basename) {
    try {
      const st = fs.statSync(path.join(this.store.paths.inbox, basename));
      if (!st.isFile()) return null;
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null; // vanished between listing and stat; ignore
    }
  }

  // Look at everything currently in inbox/ and queue whatever is new or has
  // changed since we last handled it.
  scan() {
    let entries = [];
    try { entries = fs.readdirSync(this.store.paths.inbox); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;           // dotfiles incl. temp files
      if (name.endsWith(".error")) continue;        // error markers
      if (name === "processed") continue;           // archive subfolder
      if (!DELIVERY_RE.test(name)) {
        // A stray file the user dropped in: mention it once per app run so
        // nothing disappears silently, then leave it alone.
        if (!this.strayLogged.has(name)) {
          this.strayLogged.add(name);
          this.store.log("warn", `Unrecognized file in inbox/: '${name}' (ignored; deliveries must match the delivery-*.json naming rule)`);
        }
        continue;
      }
      const sig = this.signatureOf(name);
      if (sig === null) continue;
      if (this.seenSignatures.get(name) === sig) continue; // unchanged; already handled
      if (!this.queue.includes(name)) this.queue.push(name);
    }
    this.drain();
  }

  // Forget what we knew about a file so the next scan reprocesses it
  // (used by the Log tab's Retry button).
  forget(basename) {
    this.seenSignatures.delete(basename);
  }

  // Process queued deliveries one at a time, oldest filename first.
  // Nothing thrown in here may escape: drain() is called fire-and-forget from
  // the watcher callback and the API, and an escaped rejection would take the
  // whole server down with it.
  async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        this.queue.sort();
        const name = this.queue.shift();
        try {
          await this.processOne(name);
        } catch (e) {
          this.store.log("error", `Processing ${name} failed unexpectedly (${e.message}). The delivery stays in the inbox; use Retry on the Log tab.`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async processOne(basename) {
    const fullPath = path.join(this.store.paths.inbox, basename);

    // Settle delay: insurance against a non-atomic writer still copying.
    await sleep(SETTLE_MS);
    let sig = this.signatureOf(basename);
    if (sig === null) return; // gone (maybe already processed or removed)
    if (this.seenSignatures.get(basename) === sig) return;

    // If the raw bytes are not JSON yet, give the writer one more chance
    // before we condemn the file (spec section 3).
    if (!this.parses(fullPath)) {
      await sleep(PARSE_RETRY_MS);
      sig = this.signatureOf(basename);
      if (sig === null) return;
    }

    // Record the signature of the version we are about to judge, so an
    // unchanged file is never reprocessed, while an edited one (The user fixing
    // a broken delivery in place) automatically triggers a retry.
    this.seenSignatures.set(basename, sig);

    const result = processDeliveryFile(this.store, fullPath);
    if (result.ok) {
      // The file moved to processed/; drop its signature so a future file
      // with the same name (the duplicate test) is examined fresh.
      this.seenSignatures.delete(basename);
    }
    this.onAfterIngest(result);
  }

  parses(fullPath) {
    try {
      JSON.parse(fs.readFileSync(fullPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { InboxWatcher };
