# InternshipHunt Interface Specification (App x Cowork)

Version: 1.9, tracker edition. Status: authoritative. This edition contains only the tracker and the weekly finder. The apply agent, the Practice tab, and networking/outreach drafts are not included, so sections 2.7 and 2.12 are omitted. The posting categories, the location ranking, and the email addresses come from `profile/preferences.json`.

This document is the complete contract between the two halves of this internship system:

- **The App** (Plan A): a local Node 22 + Express browser app at `http://localhost:4321`. It owns all master data. It reads delivery files from the inbox, ingests them, and displays everything.
- **Cowork** (Plan B): a Claude agent that runs weekly (on the user's chosen schedule, usually unattended) plus occasional attended sessions. It reads the app's published state and writes drop files. It never touches master data.

**The governing rule:** Cowork is only responsible for reading the state of the app and writing files. The app reads those files and shows them to the user. Cowork = read state, write drop files. App = read drop files, display, own all master data. Every rule below is an application of this division. Where this spec differs from Plan A or Plan B, this spec wins; the differences are listed in the Deviations section at the end.

All paths in this document are relative to the shared root `~/InternshipHunt/`.

---

## 1. Ownership Matrix

| Path | Created by | Written by | Read by | Must never touch |
|---|---|---|---|---|
| `app/` (server.js, ingest.js, state.js, public/) | App build session | App build session only | App process | Cowork |
| `data/events.jsonl` | App (first run) | App only (append-only) | App only | Cowork, the user's editors |
| `data/state.json` | App (first run) | App only (atomic replace) | App, Cowork | Cowork must never write, rename, or delete it |
| `data/tracker.csv` | App (first run) | App only (atomic replace) | the user (Excel etc.) | Cowork |
| `data/settings.json` | App (on first write; absent until then) | App only (atomic replace) | App only | Cowork; the user may delete it to reset to defaults |
| `inbox/` (top level) | App (first run) | Cowork (new deliveries only, temp + rename); App (error markers, file moves) | App (watcher + startup sweep); Cowork (read-only inspection at run start) | Cowork must never modify, rename, or delete any file after its own rename-into-place; the user should not hand-edit files here |
| `inbox/processed/` | App (first run; recreated on demand) | App only (moves ingested deliveries in) | App; Cowork may read for debugging | Cowork never writes here |
| `reports/` | App (first run) | Cowork only | App (renders in Reports tab), the user | App never writes here |
| `outreach/` | App (first run) | Nobody in this edition (networking is turned off) | Nobody | Kept so the folder layout stays stable; `outreach_files` is always `[]` |
| `backups/` | App (first run) | App only | App; the user for manual restore | Cowork |
| `profile/` | App (first run, empty) | The user by hand, and Claude during setup or when the user asks (profile.md, preferences.json, resume) | Cowork (reads profile.md and preferences.json every run); App (reads preferences.json at startup) | The App never writes here |
| `cowork/` (PLAYBOOK.md, sources.md, seen.jsonl) | App creates the empty folder (first run) | Cowork only | Cowork only | App never reads or writes anything in here, EXCEPT the `requests/` subfolder below |
| `cowork/requests/` | App (on demand) | App (new request files only, temp + rename) | Cowork (reads at run start, deletes each request it fulfills); App (lists names for its UI) | the user should not hand-edit files here; the App never modifies or deletes a request after publishing it |

Notes on the matrix:

- "Created by App (first run)" means the app creates the **entire folder skeleton** on its first launch: every directory above, plus `data/events.jsonl` (empty), `data/state.json` (empty-state document per section 2.2), and `data/tracker.csv` (header row only). Folder creation belongs to the app; the **files inside Cowork-owned folders** are created by Cowork.
- The single-writer rule for master data is absolute: only the app process ever writes anything under `data/`. There are no exceptions, not even "just this once" fixes. If master data needs repair, it happens through the app or through the user restoring a backup zip.

### Bootstrap: what Cowork does if it runs first

**The sentinel is `~/InternshipHunt/data/`.** Its existence proves the app has completed a first run.

- If `~/InternshipHunt/` or `~/InternshipHunt/data/` does not exist when a Cowork run starts, Cowork **stops immediately, writes nothing to disk, and tells the user**: "The InternshipHunt app has never been run on this machine. Open the app once (npm start in ~/InternshipHunt/app, or the LaunchAgent), then re-run me." The run ends cleanly; it is not an error, it is a defined outcome.
- Cowork **never creates `data/`**, never creates `app/`, `backups/`, or `inbox/processed/`, under any circumstances.
- Why: master data must be born from its single writer. A tree half-created by Cowork produces exactly the confusing split-brain state a non-backend user cannot debug, and a delivery written into a folder the app will later "create fresh" is a race waiting to happen. The cost of the strict rule is one extra message to the user on day zero; the benefit is that folder existence is always a truthful signal about which side initialized the system.
- One narrow allowance: if `data/` exists but one of Cowork's own writable folders (`inbox/`, `reports/`, `outreach/`, `cowork/`, `profile/`) is missing (for example the user deleted it by accident), Cowork may recreate that specific folder with mkdir -p and proceed, noting the recreation in its run summary. It still never creates `data/`, `app/`, `backups/`, or `inbox/processed/`.
- This gate applies to Plan B's SETUP session too: the app must be built and run once before Cowork setup writes profile.md, PLAYBOOK.md, or anything else. The Cowork prompt must expect this stop on a fresh machine.

---

## 2. File Formats

General JSON rules (apply to every file in this section): UTF-8, no BOM, LF line endings, one JSON object per file, pretty-printed with 2-space indent. Unknown fields must be ignored by the reader (must-ignore rule); this is what makes additive evolution safe. `events.jsonl` and `cowork/seen.jsonl` are JSONL (one compact JSON object per line) and are internal to their owners; their formats are not part of this interface beyond what section 4 requires of the ingest event.

### 2.1 Delivery file (`inbox/delivery-*.json`, written by Cowork)

Filename and `delivery_id` are the same string (filename minus `.json`). See section 2.4 for the naming rule.

Top-level object:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | integer | required | Interface version. Currently `1`. |
| `delivery_id` | string | required | Equals the filename without `.json`; a mismatch is a validation failure (`ID_FILENAME_MISMATCH`). Example: `delivery-20260817-193002-weekly-k3f9`. |
| `produced_at` | string, ISO 8601 with offset | required | When Cowork finished producing this delivery. Example: `"2026-08-17T19:30:02-04:00"`. |
| `run_type` | string enum | required | `"weekly"` (the scheduled Monday run, including catch-up executions of the weekly playbook), `"session"` (output of an attended apply/working session), `"manual"` (anything else the user asked for ad hoc). |
| `postings` | array of Posting | required, may be empty | Discovery data only. Postings never carry status semantics (see section 6). |
| `status_suggestions` | array of StatusSuggestion | required, may be empty | The only channel for status-affecting information. |
| `source_health` | array of SourceHealth | required, may be empty | One entry per source tried or deliberately skipped this run. Session deliveries may leave it empty. |
| `summary` | string (markdown) | required | Narrative of the run: what is new, what is closing, where Cowork looked, what the variance step tried, any staleness or skipped sources. This is shown to the user; write it for him. |
| `outreach_files` | array of strings | required, may be empty | Basenames (no path) of files this run wrote into `outreach/`. Each must already exist there at the moment the delivery is renamed into place (write ordering, section 3). |
| `state_read` | object | optional | What Cowork saw when it read `data/state.json`: `{ "state_generated_at": ISO string or null, "state_schema_version": integer or null, "stale": boolean, "note": string or null }`. Recommended in every delivery; makes staleness machine-visible. |

**Posting object:**

| Field | Type | Required | Rules |
|---|---|---|---|
| `key` | string | required | Computed by Cowork per the key algorithm in section 9. The app validates format only (regexes in section 9) and otherwise treats it as the opaque primary identifier. |
| `company` | string | required | Display name, e.g. `"Fifth Third Bank"`. |
| `division` | string or null | optional | Team/division when known, e.g. `"Private Bank"`. |
| `role` | string | required | Posting title as published. |
| `category` | string enum | required | Exactly one of the `categories` in `profile/preferences.json`, spelled exactly as listed. Cowork picks the closest. The App rejects anything else with `BAD_ENUM`. |
| `locations` | array of strings | required, may be empty | Each entry `"City, ST"` for US locations (two-letter state), `"Remote (US)"` for US-remote, or free text only when the posting is genuinely vague. Empty array = location unknown. |
| `se_rank` | integer enum 1, 2, 3 | required | Best (lowest) rank across all locations, using `profile/preferences.json`. `1`: any location whose text contains a `rank1_cities` entry (case-insensitive). `2`: any `"City, ST"` location whose state is in `rank2_states`, or `"Remote (US)"` when `remote_is_rank2` is true. `3`: everything else, including unknown location. |
| `source` | string | required | Where this came from; use the `cowork/sources.md` registry name when applicable, e.g. `"greenhouse-api:williamblair"`, `"dork:myworkdayjobs"`, `"linkedin-alert-email"`. |
| `ats` | string enum | required | One of `"workday"`, `"greenhouse"`, `"lever"`, `"ashby"`, `"smartrecruiters"`, `"icims"`, `"oraclecloud"`, `"brassring"`, `"talentlink"`, `"avature"`, `"eightfold"`, `"usajobs"`, `"other"`. |
| `tenant` | string or null | optional | The ATS tenant/board slug used in the structured key, lowercased (e.g. `"fifththird"`). Include whenever the key is structured; audit trail for dedup. |
| `posting_url` | string (URL) | required | Canonical viewable posting link, verified live by Cowork before delivery. |
| `apply_url` | string (URL) or null | optional | Only when distinct from `posting_url`. |
| `req_id` | string or null | optional | Raw requisition id as published. Required (non-null) whenever the key is in structured form. |
| `date_posted` | string `"YYYY-MM-DD"` or null | optional | Calendar date in America/New_York. |
| `deadline` | string `"YYYY-MM-DD"` or null | optional | null means rolling or unknown; say which in `notes`. |
| `notes` | string or null | optional | Cowork's short remarks: fit, verification caveats, rolling-deadline warnings. |
| `possible_repost_of` | string (posting key) or null | optional, default null | Set when this looks like a repost of a posting already present in `state.json` or `seen.jsonl`. The referenced key should exist in the app's state; if it does not, the app still files the posting under Possible Reposts with the dangling reference shown. |

**StatusSuggestion object:**

| Field | Type | Required | Rules |
|---|---|---|---|
| `posting_key` | string | required | Key of the target posting. May reference a posting in this same delivery's `postings` array. |
| `suggested_status` | string enum | required | One of `"applied"`, `"oa"`, `"interview"`, `"offer"`, `"rejected"`, `"withdrawn"`, `"closed"`. Never `"new"`, `"interested"`, or `"hidden"`: those are the user-only concepts set in the app UI. Posting-closed detection during a sweep travels as `"closed"` with `explicit_user: false`. |
| `evidence` | string | required | Human-readable justification, e.g. `"The user said 'mark Fifth Third applied' in the 2026-08-19 session"` or `"Confirmation email from @myworkdayjobs.com received 2026-08-18, subject 'Thank you for applying'"`. |
| `explicit_user` | boolean | required | `true` only when the user himself stated it in a Cowork session. Email detection, closed-link detection, and every inference is `false`. |
| `observed_at` | string ISO 8601 with offset | optional | When the evidence occurred (email received time; the moment the user said it). Used by the collision rules in section 6. Falls back to `produced_at` when absent. |
| `suggested_applied_date` | string `"YYYY-MM-DD"` | optional | For `"applied"` suggestions: the date to record as applied_date. |

**SourceHealth object:**

| Field | Type | Required | Rules |
|---|---|---|---|
| `source` | string | required | Registry name or ad hoc label. |
| `tried` | boolean | required | `false` means deliberately skipped or blocked; say why in `note`. |
| `yield` | integer >= 0 | required | Count of postings in THIS delivery attributed to this source, after dedup. `0` when not tried. Raw pre-dedup counts belong in `note`. |
| `note` | string or null | required (nullable) | Free text: blocked, truncation suspected, new tenant discovered, etc. |

### 2.2 `data/state.json` (written by the app, read by Cowork)

Regenerated atomically after every ingest and every user action, and at app startup. This is the ONLY file Cowork reads to learn what exists and what state it is in. Principle of least surface: it contains exactly what Cowork needs for dedup and suggestion hygiene, nothing more.

```
{
  "schema_version": 1,
  "generated_at": "2026-08-18T09:14:33-04:00",
  "postings": [
    {
      "key": "workday|fifththird|r123456",
      "company": "Fifth Third Bank",
      "role": "Wealth Management Intern - Summer 2027",
      "req_id": "R123456",
      "posting_url": "https://...",
      "status": "interested",
      "applied_date": null,
      "hidden": false
    }
  ],
  "counts": { "total": 41, "new": 12, "interested": 6, "applied": 9, "hidden": 8 }
}
```

Field rules:

- `postings` contains **every posting ever ingested**, including hidden and closed ones. Cowork needs the full universe for dedup; omitting hidden rows would resurrect them every week.
- `status` enum: `"new"`, `"interested"`, `"applied"`, `"oa"`, `"interview"`, `"offer"`, `"rejected"`, `"withdrawn"`, `"closed"`. `hidden` is a separate boolean flag, orthogonal to status (a posting keeps its status when hidden).
- `applied_date` is `"YYYY-MM-DD"` or null.
- `counts` is informational display data only (Cowork must not make decisions from it). Definitions: `total` = all postings; `new`, `interested`, `applied` = postings currently in that status, counted regardless of the hidden flag; `hidden` = postings with `hidden: true`. The hidden count overlaps the status counts, so the numbers do not sum to `total`.
- The first-run empty-state document is exactly: `{ "schema_version": 1, "generated_at": "<timestamp>", "postings": [], "counts": { "total": 0, "new": 0, "interested": 0, "applied": 0, "hidden": 0 } }`.
- Deliberately excluded (Cowork does not need them, so they are not published): notes, portal_note, contact fields, pending-suggestion state, event history, deadlines. If a future Cowork behavior needs a field, it is added here as an optional field (no version bump) and recorded in this spec first.

Cowork's use of this file is read-only in the strongest sense: open, parse, use in memory. Never rewrite, never touch mtime, never delete.

### 2.3 Error marker file (written by the app next to a failed delivery)

Name: the delivery's full filename plus `.error`. Example: `inbox/delivery-20260817-193002-weekly-k3f9.json.error`. The content is JSON but the extension is deliberately NOT `.json`, so the inbox watcher's match rule (section 3) can never mistake a marker for a delivery.

```
{
  "schema_version": 1,
  "delivery_file": "delivery-20260817-193002-weekly-k3f9.json",
  "delivery_id": "delivery-20260817-193002-weekly-k3f9",
  "failed_at": "2026-08-18T09:14:33-04:00",
  "stage": "validate",
  "errors": [
    { "code": "BAD_ENUM", "message": "postings[3].category is 'Wealth' (allowed: WM, PWM, CommBank, CorpFin, Data, Insight, Federal)", "path": "postings[3].category" }
  ],
  "app_note": "Delivery rejected before any data was applied. Nothing was ingested.",
  "later_deliveries_processed": false
}
```

- `delivery_id` is derived from the filename even when the file is unparseable (the watcher matched the name to detect it), so it is never null.
- `stage` enum: `"read"` (I/O), `"parse"` (not JSON), `"validate"` (schema/content), `"apply"` (I/O failure while appending events; rare, see section 4).
- `errors[].code` enum: `NOT_JSON`, `SCHEMA_VERSION_UNSUPPORTED`, `MISSING_FIELD`, `BAD_TYPE`, `BAD_ENUM`, `BAD_KEY_FORMAT`, `DUPLICATE_KEY_IN_DELIVERY`, `BAD_DATE`, `ID_FILENAME_MISMATCH`, `IO_ERROR`, `UNKNOWN`.
- `later_deliveries_processed` is set to `true` (marker rewritten) if the app goes on to ingest a newer delivery while this one sits error-marked; it warns whoever retries that ordering was broken (the stale-update guard in section 4 makes this safe).

### 2.4 File naming conventions

All names are chosen so that plain lexicographic sort equals chronological order, and so that two deliveries on the same day (weekly run plus an apply session) can never collide.

- **Delivery**: `delivery-YYYYMMDD-HHMMSS-<run_type>-<rand4>.json`, where the date-time is `produced_at` in America/New_York local time, `<run_type>` is the run_type enum value, and `<rand4>` is 4 random characters from `[a-z0-9]`. `delivery_id` = this name minus `.json`. Example: `delivery-20260817-193002-weekly-k3f9.json`. Seconds plus the random suffix make same-minute collisions practically impossible; the random suffix also covers the DST fall-back hour when wall-clock times can repeat.
- **Error marker**: `<delivery filename>.error` (section 2.3).
- **Temp files**: `.tmp-<final filename>` in the destination directory (section 3).
- **Report**: `reports/YYYY-MM-DD-<run_type>.md` (e.g. `2026-08-17-weekly.md`). If that name exists (second manual run in a day), append `-2`, `-3` before the extension (`2026-08-17-manual-2.md`). Apply-session prep packs are reports too: `reports/YYYY-MM-DD-session-prep.md`.
- **Outreach**: `outreach/YYYY-MM-DD-<company-slug>-<contact-slug>.md` (e.g. `2026-08-17-raymond-james-jane-doe.md`). Slug rule: lowercase, every run of non-alphanumeric characters becomes one hyphen, trim hyphens. On collision append `-2`, `-3`. `outreach_files` entries in a delivery are these basenames.
- **Backups** (app-internal): `backups/events-YYYYMMDD-HHMMSS.jsonl.gz` (gzip via Node's built-in zlib; no zip dependency). Retention: one backup before every ingest plus at most one per day at app startup; keep the newest 60, delete older. Recovery: gunzip (double-clickable in Finder) and copy over `data/events.jsonl`.
- **Processed deliveries**: moved to `inbox/processed/` keeping their exact filename.

### 2.5 `data/tracker.csv` columns

An export for the user only; nothing ever reads it back. Header row, in this order: `key, company, division, role, category, locations, se_rank, status, hidden, applied_date, deadline, date_posted, first_seen, source, ats, posting_url, apply_url, req_id, portal_email, portal_note, contact_referral, next_followup, notes, status_updated`. `locations` is joined with `; `. `first_seen` is the date the app first ingested the key. `portal_email` defaults to the first address in `email_addresses` in `profile/preferences.json`; it and `portal_note`, `contact_referral`, `next_followup` are the user-entered fields from the app's detail panel.

### 2.6 Request files (`cowork/requests/rescan-*.json`, written by the App)

The one deliberate exception to "the App never touches `cowork/`". Some work only Cowork can do (reading the user's mail) is triggered from the App's UI. The App cannot do it locally, so it publishes a small request file that the next Cowork run picks up.

- **Name**: `rescan-<UTC timestamp with colons and dots replaced by hyphens>.json`, e.g. `rescan-2026-08-12T02-39-37-014Z.json`. Lexicographic sort is chronological.
- **Write discipline**: the App writes `.tmp-<name>` in `cowork/requests/` and renames it into place, like every other publish in this system. After the rename the App never modifies or deletes the file.
- **Content** (JSON, must-ignore rule applies): `{ "kind": "application-rescan", "requested_at": <ISO 8601 with offset>, "reason": <string> }`. `kind` is the dispatch field; `"application-rescan"` is the only kind defined today.
- **Lifecycle**: Cowork checks `cowork/requests/` at run start (playbook step 1), performs each request it can, and DELETES each request file it fulfilled, noting that in its run summary. Deleting is Cowork's job because fulfillment is Cowork's fact to record. The App may LIST the folder (read filenames only) to show a queued indicator; it never reads request files back and never deletes them.
- This is additive (a new file type under the must-ignore rule), so it needs no schema_version bump; it is recorded here so the ownership matrix stays truthful.

### 2.8 `data/settings.json` (App-owned preferences), v1.4

A small App-owned preferences file, outside the event log. In this edition it holds only `macNotifications`, which nothing uses (it controlled apply-agent alerts, which this edition does not include). A missing, empty, or unparseable file yields the defaults; it is safe to delete at any time. Cowork never reads or writes it.

### 2.9 ACTION REQUIRED evidence convention, v1.5

A convention on the `evidence` string of a status suggestion (section 2.1), not a new file. When Cowork finds that an employer is waiting on the user (an assessment invite, a HireVue request, a form to return), it prefixes the evidence:

```
ACTION REQUIRED: <what he has to do> | DUE: <YYYY-MM-DD or "not stated"> | <where this came from>
```

Fields are separated by `|`, so `|` must not appear inside a field. The App parses this to drive its "Action required" banner and keeps the parsed action in memory keyed by posting, deliberately outliving the suggestion itself: confirming "yes, I have an assessment" must never erase when it is due.

**App-side entry, v1.5.** The user can add an action by hand from the UI for the ones no scan can reach: a text message, a phone call, a recruiter telling him in person. `POST /api/action/add` takes `{key, what, due, note}`, validates that the posting exists and that `due` is a real calendar date, rewrites any `|` in his text to `/`, composes the identical string shape above, and records an App-only `action_add` event. Adding an action also clears any earlier `action_done` on that posting (recorded as its own `action_done` with `done: false`, keeping the log append-only), because event timestamps are second-resolution and a new action must never hide behind a done mark set in the same second.

`action_add` lives in `data/events.jsonl`, which is App-only; Cowork neither reads nor writes it, and the App↔Cowork contract is unchanged.

### 2.10 NEXT ROUND evidence convention, v1.6

A second convention on the `evidence` string of a status suggestion, sibling to section 2.9. When Cowork finds an email showing the user advanced on an application but the email asks nothing of him (no assessment to take, no slot to pick), it prefixes the evidence:

```
NEXT ROUND: <what the email says, one short line> | <sender, subject, received date>
```

Pipes separate the fields, so `|` must not appear inside a field. Precedence rule: an email that asks the user to do something uses ACTION REQUIRED (section 2.9), never NEXT ROUND; a deadline outranks a celebration. The typical carrier is a suggestion whose `suggested_status` names the new stage (`oa`, `interview`, `offer`); when the email announces advancement without naming a stage, Cowork suggests the posting's current stage, which resolves as a rule-2 no-op while the evidence still lands.

**App side.** The App parses this prefix to drive its "Moving forward" strip on the Postings tab, and remembers the latest NEXT ROUND evidence per posting past the suggestion's own resolution (same survival rule as ACTION REQUIRED evidence), so a no-op or a confirm never erases the news. The strip also lists any pending non-explicit suggestion for `oa`, `interview`, or `offer` that is not already shown in the Action required banner, so advancement delivered without the prefix still surfaces. The user acknowledges a row with "Got it", recorded as an App-only `next_round_seen` event in `data/events.jsonl`; setting the posting to the suggested stage acknowledges it automatically. Cowork neither reads nor writes any of this; the App↔Cowork contract is unchanged (the convention is additive under the must-ignore rule, so `schema_version` stays 1).

### 2.11 Removing a row from Action required or Coming up, v1.7

The user can take any row off the Action required banner or the Coming up strip with its **Remove** button. Removed means removed: the row leaves the screen on the next refresh. Nothing is greyed out, struck through, or parked in a muted list, and the same is now true of "I did this" on an Action required row, which used to leave a muted row behind for a day. The undo for both lives in the toast that appears, for as long as the toast is up.

`POST /api/notice/dismiss` takes `{id, kind, key, dismissed}` and records an App-only `notice_dismiss` event in `data/events.jsonl`. `dismissed: false` is the undo and deletes the entry, mirroring `action_done` and `next_round_seen`: the log stays append-only and replay ends up with the later truth. `GET /api/view` exposes the result as `dismissedNotices` (notice id to timestamp). `kind` is `action` or `upcoming` and is used only for the Log tab's wording; `key` is carried for the same reason.

**Ids are content-addressed, and that is what makes permanent removal safe.** The page builds a notice id by hashing the posting key together with the thing the row is actually about: the action's text and due date for an Action required row, the closing date for a deadline row, the follow-up date for a follow-up row. A removal therefore mutes exactly one piece of news, never a posting. A different action, a moved deadline, or a newly chosen follow-up date hashes differently and appears normally. A re-detection of the same email hashes the same and stays gone, which is the intended quiet.

Removing an Action required row that a pending or orphan suggestion was feeding also dismisses that suggestion, so the item does not simply reappear in Needs attention. That has one consequence worth stating: suggestion dismissal is a resolution in an append-only log with no restore path, so undo brings the banner row back from remembered ACTION REQUIRED evidence but not the "Set to ..." button. For an orphan there is no remembered evidence to come back from, so no undo is offered and the toast says so instead of pretending.

Removal never touches the posting. Status, deadline, `next_followup` and `hidden` are all unchanged, and the Postings tab and detail panel still show the real dates. Cowork neither reads nor writes any of this; the App-Cowork contract is unchanged and `schema_version` stays 1.

---

## 3. Write Discipline

The invariant both sides must guarantee: **no reader ever sees a half-written file.** On macOS (APFS), `rename(2)` within the same directory is atomic; every multi-byte write in this system goes through temp-name-then-rename.

### Cowork writes

1. Write the complete file to `<dest-dir>/.tmp-<final-name>` (dot-prefixed, in the destination directory so the rename never crosses a filesystem boundary).
2. **Self-check before publishing**: re-read the temp file and run the SAME validation checklist the app runs in section 4 step 3 (required fields, types, enums, key regexes, duplicate-key-within-delivery, date formats, delivery_id equals filename), plus: every `outreach_files` entry exists on disk. Cowork validating its own output is the cheapest place to catch a malformed delivery.
3. `mv` (rename) the temp file to its final name. This is the publish moment.

Write ordering within a run (this ordering is the transaction discipline; a crash at any point leaves a safe state):

1. Outreach files (each temp + rename).
2. Report file (temp + rename).
3. **The delivery file (temp + rename). This is the commit point of the run.**
4. `cowork/seen.jsonl` append.

Why this order: a crash before step 3 leaves orphaned outreach/report files, which are harmless (the app renders whatever exists; nothing references them as ingested). A crash after step 3 but before step 4 leaves `seen.jsonl` stale, which merely means next week's run re-includes some postings; the app's key-level dedup absorbs that silently. The one order that must never happen is seen.jsonl before delivery: postings marked seen but never delivered would be lost forever.

After the rename in step 3, the delivery file is frozen: Cowork never modifies, renames, or deletes it, even if it later realizes the content was wrong. Corrections ship as a new delivery with a new `delivery_id` (key-level merge semantics make re-sending postings safe). The freeze binds Cowork only: The user editing a broken delivery in place is the sanctioned repair path, and the app treats that edit as a retry trigger (section 4).

### App writes

- `data/state.json` and `data/tracker.csv`: write `data/.tmp-state.json` / `data/.tmp-tracker.csv`, then rename over the destination. Every regeneration, every time. This is why Cowork can read `state.json` at any moment without coordination.
- `data/events.jsonl`: append-only, one write() call per batch of event lines (section 4), file opened with O_APPEND. The replay parser at startup tolerates a torn final line (a line that fails JSON.parse is skipped with a Log warning); this makes the log robust against a crash mid-append.
- `data/settings.json`: temp + rename, same as everything else under `data/`. It is preferences, not master data, so it is deliberately NOT in the event log and is not replayed; deleting it simply restores defaults.
- Backups: zip to a temp name in `backups/`, then rename.
- Error markers: temp + rename like everything else.

### What the inbox watcher matches and ignores

The watcher (and the identical startup sweep) considers a file a delivery if and only if its basename matches, in `inbox/` top level only:

```
^delivery-[0-9]{8}-[0-9]{6}-(weekly|session|manual)-[a-z0-9]{4}\.json$
```

Everything else is ignored for processing: dotfiles (which covers all `.tmp-*` temp files), `*.error` markers, the `processed/` subfolder, and any stray file the user drops in. Ignored non-dot files are listed once per app run in the Log tab as an informational line ("unrecognized file in inbox") so nothing disappears silently. The app also ignores dot-prefixed entries everywhere it lists Cowork-owned folders (`reports/`, `outreach/`), so temp files never render in tabs. The watcher re-checks any entry whose basename matches the pattern on ANY filesystem event (macOS fs.watch does not reliably distinguish event types), deduplicating by (mtime, size) so unchanged files are not reprocessed. Because Cowork publishes via atomic rename, a matching file is complete when first seen; as insurance against non-conforming tools copying files in slowly, the app waits 500 ms before reading, and on a parse failure requeues the file once after 2 more seconds before writing an error marker.

---

## 4. Delivery Lifecycle

State machine for each delivery file:

```
written (renamed into inbox/ by Cowork)
   -> detected (watcher event, or startup sweep)
   -> validated (parse + full schema + content checks)
   -> ingested (events appended, exports regenerated)
   -> archived (moved to inbox/processed/)

any failure at validate/apply
   -> error-marked (marker file written, delivery left in place)
```

**Processing order**: when multiple deliveries are pending (startup sweep after days closed, or a burst), process in ascending lexicographic filename order, which is chronological order by construction. Process strictly one at a time: a delivery completes its full pipeline (through archive) before the next begins. The app serializes all ingests through a single queue; watcher events arriving mid-ingest are queued in filename order.

**Pipeline per delivery**:

1. Read and parse. Failure: error marker (`stage: "read"` or `"parse"`), stop this delivery.
2. Schema version check: accepted versions are N and N-1 (section 8). Unsupported: error marker with `SCHEMA_VERSION_UNSUPPORTED` and an `app_note` telling the user to update the app.
3. **Validate the ENTIRE delivery before applying ANY of it.** Every posting, every suggestion, every enum, every key format, duplicate-key-within-delivery check, date formats, and `delivery_id` equality with the filename (`ID_FILENAME_MISMATCH`). Key-format scope: `postings[].key` and `status_suggestions[].posting_key` are format-validated and a failure rejects the delivery (`BAD_KEY_FORMAT`); `possible_repost_of` is also format-checked, but a failure there only drops the pointer with a Log warning and the posting still ingests normally. The app never recomputes hashes or cross-checks structured keys against the `tenant`/`req_id` fields; format only. Any rejecting error: marker written, nothing ingested. Missing `outreach_files` entries are a Log warning, not a validation failure (outreach is display-only and must not block posting data).
4. Idempotency check: the app derives the set of already-ingested `delivery_id`s from `events.jsonl` (every ingest appends an `ingest` event carrying the delivery_id; replay at startup rebuilds the registry, so it survives restarts with no extra file). If this delivery_id is already in the set: skip to step 8 with a Log note "duplicate delivery skipped".
5. Backup: zip `data/events.jsonl` into `backups/` (before any mutation, per Plan A).
6. Apply, all-or-nothing: build every event line in memory (one event per posting add/update, one event per suggestion resolution per section 6, and LAST the `ingest` commit event), then append them to `events.jsonl` in a single write. The ingest event is deliberately the FINAL line: it is the commit record. If the write tears partway, the commit record is missing, so the delivery never enters the idempotency registry; on re-detection the whole delivery re-applies, posting adds/updates converge by key, and repeated suggestion resolutions are absorbed by section 6. The ingest event carries `delivery_id`, `produced_at`, and `run_type`; every posting add/update event carries the originating delivery's `produced_at` (this is what rebuilds the stale-update guard and the header staleness warning on replay). After applying postings, re-attach any stored orphan suggestion whose key now exists, as a pending suggestion. In-memory state updates follow. An I/O failure here produces an `apply`-stage error marker.
7. Regenerate `data/state.json` and `data/tracker.csv` (atomic, section 3).
8. Move the delivery file to `inbox/processed/` (creating the folder if missing). If the move itself fails, the delivery stays in inbox; on next detection, step 4's registry makes re-ingest a no-op and the move is retried.
9. Log tab entry: delivery id, run_type, counts (added, updated, suggestions applied/pending/no-op), duration. Additionally, after a successful ingest, rewrite any `.error` marker in `inbox/` whose delivery filename sorts earlier than this one, setting `later_deliveries_processed: true`.

**Posting apply rules** (within step 6):

- New key: add with status `"new"`, `hidden: false`.
- Existing key: merge mutable fields only (`deadline`, `notes`, `posting_url`, `apply_url`, `locations`, `se_rank`, `division`, `date_posted`, `tenant`). Status, hidden, applied_date, and every the user-entered field are NEVER touched by a posting record. Note: for hash-form keys the location participates in the key itself, so a posting whose location genuinely changes arrives as a NEW key rather than a merge; `possible_repost_of` is the mitigation, and Cowork must not promise location-change dedup for hash-keyed postings.
- **Stale-update guard**: the app records, per posting, the `produced_at` of the last delivery that updated it. A delivery whose `produced_at` is older skips the mutable-field merge for that posting (its status_suggestions are still processed; the timestamp rules in section 6 handle ordering there). This makes out-of-order retries safe.
- `possible_repost_of` set: the posting is filed under Possible Reposts, not the main New group, linked to the referenced original (or showing a dangling-reference note if the key is unknown).

**Why all-or-nothing**: a partially applied delivery poisons the idempotency registry (the delivery_id would be marked done while half its content is missing) and makes retry semantics unanswerable ("which half applied?"). Rejecting the whole file keeps `delivery_id` = one atomic unit, and the fix path trivially simple: correct the file, retry, everything applies exactly once.

**Retry semantics**: the app never auto-retries an error-marked delivery on a timer. A retry happens only when (a) the user clicks Retry on the Log tab entry, which deletes the `.error` marker and re-runs the pipeline, or (b) the delivery file itself changes on disk while a marker exists (watcher event on it), which the app treats as "someone fixed it": marker deleted, pipeline re-run. Repeated failure rewrites the marker with a fresh `failed_at`.

**A failed delivery does not block later deliveries.** Availability wins: one corrupt file must not freeze the pipeline for weeks of unattended runs. The marker's `later_deliveries_processed` flag plus the stale-update guard and the suggestion timestamp rules keep an eventual out-of-order retry harmless.

---

## 5. State Read Discipline (Cowork side)

Cowork reads `data/state.json` exactly once per run, at run start, and treats that snapshot as its truth for the run. Rules, in order:

1. **`data/` missing entirely**: bootstrap rule from section 1 applies. Stop, write nothing, tell the user to run the app once.
2. **`data/` exists but `state.json` missing or unparseable**: treat as the empty state (zero postings), proceed with the run, rely on `cowork/seen.jsonl` for dedup, and record the situation in both the delivery `summary` and `state_read` (`state_generated_at: null`). Re-delivering already-known postings is harmless: the app's key-level merge absorbs them.
3. **Staleness**: state is stale when `generated_at` is more than 9 days old (one weekly cycle plus buffer; it means the app has not run since before the last weekly run). Proceed normally; set `state_read.stale: true` and say it plainly in the summary ("state.json is 16 days old; the app has not been opened; suggestions and dedup are based on old state").
4. **`schema_version` newer than Cowork knows**: read only the fields this spec version defines; if they parse sanely, use them; if anything it needs is missing or mistyped, fall back to rule 2's empty-state behavior. Either way proceed, and note it.
5. **`schema_version` older than Cowork knows**: read per that older version's spec. Proceed.

**Cowork must never fail a run because state.json is missing, stale, or odd.** Every branch above ends in "proceed" except the never-initialized bootstrap case.

Additionally, at run start Cowork inspects `inbox/` (read-only) and reports in its run summary and delivery summary:

- Leftover delivery files from previous runs (not yet ingested): count and age ("2 prior deliveries not yet ingested; the app has likely not been opened").
- Error markers: named prominently ("delivery-20260810-...-weekly-x2p1 failed ingest on 2026-08-11; open the app's Log tab"). Cowork never retries, edits, or deletes an error-marked delivery; the fix path runs through the user and the app.

---

## 6. Status Suggestion Semantics

Suggestions are the only way status information flows from Cowork to the app, and they are exactly that: suggestions. The app is the sole authority that changes a status.

**Resolution rules**, evaluated per suggestion, in this order, at ingest time:

1. **Unknown `posting_key`** (not in master data, and not added by this same delivery's postings array): the suggestion becomes an **orphan**. It is stored (as an event), shown in the app's needs-attention area with its key and evidence, and never crashes anything. If a posting with that key is ingested later, the orphan is automatically re-attached as a normal **pending** suggestion (even if it was `explicit_user: true`: too much time has passed for silent auto-apply to be unsurprising; the user one-click-confirms it instead).
2. **Current status already equals `suggested_status`**: resolve as a no-op. Yes, it is logged: a Log tab line "suggestion no-op: <key> already <status>" and a resolution event in events.jsonl. Silent discards are how systems lose the user's trust.
3. **Duplicate of an existing pending suggestion** (same posting_key + suggested_status already pending) AND `explicit_user: false`: resolve as a no-op, logged. This absorbs the same confirmation email being re-detected on consecutive weekly Gmail passes. An `explicit_user: true` suggestion is never absorbed by this rule; it proceeds to rule 4, and if applied there, any matching pending suggestion resolves as superseded, logged.
4. **`explicit_user: true`**: compare timestamps. Let T_s = the suggestion's `observed_at` (fallback `produced_at`). If the user changed this posting's status **in the app UI after T_s** (a dashboard-confirm click counts as a manual UI change for this comparison), the manual change is newer intent: resolve as a no-op, logged with reason "manual change is newer". Otherwise **apply immediately**: append a status event attributed to the session (actor `cowork-session`, carrying the delivery_id), set `applied_date` for `"applied"` suggestions from `suggested_applied_date`, else the calendar date (America/New_York) of T_s.
5. **`explicit_user: false`**: never auto-applied, with ONE carve-out: `suggested_status: "closed"` auto-applies when the posting's current status is `"new"` or `"interested"` and it is not hidden (it destroys no the user-entered state and is trivially reversible); logged like any status event (actor `auto-closed`). Every other non-explicit suggestion becomes a **pending suggestion** the app surfaces for one-click confirm (with the evidence text shown), and the app offers bulk-confirm for any remaining pending `"closed"` suggestions. Confirm appends a normal status event (actor `dashboard-confirm`); for `"applied"` confirmations, `applied_date` = `suggested_applied_date` when present, else the `observed_at` calendar date, else today. Dismiss resolves it, logged. Manual status otherwise always wins here by construction, because nothing happens without the user's click.

Walking the four required scenarios through those rules:

- **(a) the user says "mark X applied" in a session**: Cowork writes a session delivery containing `{ posting_key, suggested_status: "applied", explicit_user: true, evidence: "The user said ...", observed_at: <that moment> }`. On ingest, rule 4 applies it immediately (the typical prior status, `"interested"`, was set manually but BEFORE the user spoke, so the suggestion is the newer intent and wins). The app records applied_date.
- **(b) Confirmation email detected**: `explicit_user: false`, evidence naming the sender domain and subject. Rule 5: shows as a pending suggestion; the user confirms with one click.
- **(c) Suggestion for a posting the user already manually marked**: if the manual mark is the same status, rule 2 (no-op, logged). If it differs and the manual action came after the suggestion's `observed_at`, rule 4 (no-op, logged, manual wins). If it is a non-explicit suggestion, rule 5 (pending; the user just dismisses it). In every branch the manual state survives untouched and the resolution is logged.
- **(d) Suggestion for an unknown key**: rule 1, orphan, needs-attention, no crash.

Why timestamps rather than blanket "any manual status blocks everything": the system's primary flow is the user marking postings Interested in the app, then applying to them in a session. A blanket rule would no-op every session "mark applied" against an Interested posting, breaking the main loop. The timestamp rule implements what "manual always wins" actually means: the manual action wins every conflict with an earlier or concurrent suggestion, and only yields to the user's own later explicit statement. Non-explicit suggestions can never override anything, ever.

---

## 7. Sequence Walkthroughs

**(1) Normal Monday run while the app is closed; the user opens the app Tuesday.**
Monday 7:30 pm: Cowork starts. `data/` exists; it reads `state.json` (fresh, 6 days old, not stale), `cowork/seen.jsonl`, `cowork/sources.md`. It sweeps, verifies links, dedups, ranks. It writes two outreach files (temp + rename each), then `reports/2026-08-17-weekly.md`, then `.tmp-delivery-20260817-193002-weekly-k3f9.json`, self-checks it, renames it into `inbox/` (commit), then appends new keys to `seen.jsonl`. The app is not running; the file just sits there. Tuesday 9 am: The user opens the app. Startup sweep finds one file matching the delivery pattern. Parse, version check, full validation pass. Idempotency check: unknown delivery_id. Backup zip of events.jsonl. Events appended in one write: ingest event, 14 posting adds, 3 posting updates, 1 pending suggestion (confirmation email). state.json and tracker.csv regenerated atomically. File moved to `inbox/processed/`. Header shows "Last delivery: yesterday 7:30 pm", pending suggestions: 1. Log tab shows the ingest line. The user reads 14 new postings.

**(2) Delivery lands while the app is open.**
Same Cowork steps. The moment the rename lands, the watcher fires; the name matches the pattern; after the 500 ms settle delay the same pipeline runs (validate, idempotency, backup, apply, regenerate, move, log). The UI refreshes its view. The user, if watching, sees the new postings appear within seconds. No difference from walkthrough 1 except the trigger.

**(3) Apply session mid-week.**
Wednesday evening, attended session. The user applies to three postings with Claude prefilling; he says "mark all three applied". During the session Cowork also stumbled on one new PNC posting. At session end, Cowork writes a small delivery `delivery-20260819-203145-session-p7q2.json`: one posting, three status_suggestions (all `explicit_user: true`, `observed_at` = when the user said it, `suggested_applied_date` = today), empty source_health, a two-line summary, no outreach files. The app is open on the same machine: watcher ingests within seconds; rule 4 applies all three immediately (their prior statuses were Interested, set before the user spoke); the user sees Applied appear in the app before he stands up.

**(4) App closed for three weeks; three deliveries pile up.**
Three Monday runs produce three deliveries. Runs 2 and 3 note in their summaries and `state_read` that state.json is stale (16 and 23 days old); dedup rides on `seen.jsonl`, so the three deliveries mostly do not repeat each other. The user opens the app. Startup sweep lists the three files, sorts lexicographically (= chronologically), and processes them fully one at a time: backup, ingest, regenerate, move, then the next. Postings added by delivery 1 and updated by delivery 3 end at delivery 3's values (produced_at ordering satisfies the stale-update guard). Header shows last delivery = yesterday; the Log tab shows three ingest entries; nothing was lost.

**(5) Corrupted or truncated delivery file.**
A delivery is somehow truncated (the discipline in section 3 makes this nearly impossible, but disks and bugs exist). Detection, then parse fails. The app writes `delivery-...-weekly-a1b2.json.error` with `stage: "parse"`, code `NOT_JSON`, leaves the delivery in place, logs it, and moves on to any other pending deliveries (marker rewritten with `later_deliveries_processed: true` if one lands later). The header shows an error badge; the Log tab shows the failure with a Retry button. Next Cowork run notices the marker during its inbox inspection and says so in its summary. The user (or an attended session) fixes or re-issues the delivery; Retry clears the marker and ingests. Nothing was partially applied at any point.

**(6) Cowork runs before the app has ever been built.**
Scheduled run fires on a machine where `~/InternshipHunt/data/` does not exist. Cowork detects this first, creates nothing, writes nothing, and ends the run with a clear message in its run summary: run the app once, then re-run me. The next run after the user does so proceeds normally as in walkthrough 1 (state.json exists and is the empty-state document from first run; every posting is new).

**(7) schema_version mismatch, both directions.**
Delivery newer than the app understands (delivery says 2, app knows only 1): validation stops at the version check; error marker with `SCHEMA_VERSION_UNSUPPORTED`; `app_note`: "This delivery uses schema version 2; the app supports 1. Update the app." Nothing ingested; the delivery waits, and Retry works after the app is updated. Delivery older than the app's newest (app knows 2, delivery says 1): the app accepts it (N-1 rule), validating against version 1 rules and upgrading internally. State newer than Cowork knows: Cowork applies section 5 rule 4 (known fields, or empty-state fallback), proceeds, and notes it in the summary. State older than Cowork knows: section 5 rule 5, proceed.

---

## 8. Versioning and Evolution

- One shared integer `schema_version` covers the whole interface: delivery files, state.json, and error markers move together. Currently `1`.
- **Bump only on a breaking change**: removing or renaming a field, changing a type, changing an enum value's meaning, ADDING a value to any validated enum (the app's validator rejects unknown enum values wholesale, so additions are breaking by construction), or changing the key algorithm. Adding an optional FIELD or a new file type is additive and needs no bump, because every reader follows the must-ignore rule (unknown fields ignored everywhere).
- **Compatibility rule**: the app must accept delivery versions N and N-1. Cowork always writes the newest version it knows. Cowork must read state.json at any version without failing (section 5).
- **Where each side declares its versions**: the app hardcodes its accepted set in `app/ingest.js` as `SUPPORTED_DELIVERY_VERSIONS` (a visible constant near the top, commented for a non-backend reader). Cowork's `cowork/PLAYBOOK.md` states the version it writes. This spec document is the source of truth; any version change edits this spec first, then both declarations.
- The key algorithm (section 9) is part of the schema: changing it is always a breaking change, because keys minted under two algorithms cannot dedup against each other.

---

## 9. Clocks, Encoding, and the Posting Key Algorithm

**Clocks**: every timestamp in every interface file is ISO 8601 with an explicit numeric UTC offset, expressed in America/New_York local time, e.g. `2026-08-17T19:30:02-04:00`. Date-only fields are `YYYY-MM-DD` and mean the America/New_York calendar date. Both processes run on the same Mac, so skew is not a concern; the lexicographic filename order (not produced_at) is the authoritative processing order. During the DST fall-back hour, wall-clock names can momentarily sort out of true chronological order; that is harmless because the stale-update guard and the suggestion rules compare `produced_at`, which carries explicit offsets.

**Encoding**: all files UTF-8 without BOM, LF newlines. JSON files are one pretty-printed object per file; `events.jsonl` and `seen.jsonl` are JSONL, one compact object per line.

**Posting key algorithm.** Both sides must implement this identically; the test vectors below must be asserted in both builds' tests. Dedup breaks if the implementations drift, so neither side may "improve" this without a schema version bump.

A key has one of two forms:

**Structured form** (preferred): `<ats>|<tenant>|<req_id>`, used only when all three are available AND `ats` is in the enum excluding `"other"` (an invented tenant slug under "other" would drift; unknown ATSes always hash). Normalization: `ats` is the enum value verbatim; `tenant` is lowercased and trimmed; `req_id` is lowercased, then every character not in `[a-z0-9._-]` is deleted, then leading characters outside `[a-z0-9]` are trimmed. If `tenant` or `req_id` normalizes to empty (or the result still fails the regex), fall back to the hash form. For `usajobs`, tenant is the fixed string `usajobs` and req_id is the USAJobs control number. Example: `workday|fifththird|r123456`. Validation regex:

```
^(workday|greenhouse|lever|ashby|smartrecruiters|icims|oraclecloud|brassring|talentlink|avature|eightfold|usajobs)\|[a-z0-9][a-z0-9._-]*\|[a-z0-9][a-z0-9._-]*$
```

**Hash form** (fallback): `hash|<first 16 hex chars of SHA-256>`. Validation regex: `^hash\|[0-9a-f]{16}$`. Computed as follows.

Text normalization routine `norm(s)`, applied to each part:

1. Unicode normalize to NFKD.
2. Delete combining marks (the range U+0300 through U+036F); this strips diacritics.
3. Lowercase.
4. Replace every character not in `[a-z0-9 ]` with a single space (punctuation, hyphens, ampersands, everything).
5. Collapse every whitespace run to one space; trim.

Key computation:

1. `c = norm(company)`, `t = norm(role)`.
2. `l` = take the `locations` array, apply `norm` to each entry, sort the results ascending by plain codepoint order, take the first; if the array is empty, `l` is the empty string. (Sorting first makes the key independent of the order Cowork happened to list locations.)
3. Input string = `c + "|" + t + "|" + l` (UTF-8 bytes).
4. SHA-256 of the input, lowercase hex, first 16 characters.
5. Key = `"hash|"` + those 16 characters.

Reference implementation (Node, and the exact behavior Cowork must reproduce):

```js
const crypto = require("crypto");
function norm(s) {
  return s.normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hashKey(company, role, locations) {
  const l = locations.map(norm).sort()[0] || "";
  const input = `${norm(company)}|${norm(role)}|${l}`;
  return "hash|" + crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}
```

**Test vectors** (both builds must assert these):

| Inputs | Normalized input string | Key |
|---|---|---|
| company `Fifth Third Bank`, role `Wealth Management Intern - Summer 2027`, locations `["Charlotte, NC"]` | `fifth third bank\|wealth management intern summer 2027\|charlotte nc` | `hash\|93a0ce5fbf6ba496` |
| company `Truist`, role `Corporate Finance & FP&A Intern`, locations `[]` | `truist\|corporate finance fp a intern\|` | `hash\|29b408b874d74411` |

The app treats keys as opaque primary identifiers and validates only their format against the two regexes (a format failure is a validation error, `BAD_KEY_FORMAT`). The app must still ship the reference implementation above (in `app/state.js`, exported and unit-tested against the vectors) so that any future manual-add feature mints identical keys.

---

## 10. Failure Visibility

Each side surfaces its problems to the user directly, without depending on the other side being healthy or even running.

**App (always visible when the user opens it):**

- Header staleness warning when the `produced_at` of the newest successfully ingested delivery is more than 8 days old ("No delivery in N days"), covering: Mac asleep on Monday, Cowork schedule broken, Cowork bootstrapping error. Distinct wording when NO delivery has ever been ingested ("Waiting for the first delivery").
- Header badge for error-marked deliveries (count), and for pending suggestions (count).
- Log tab: every ingest with counts, every failed delivery with its marker contents and a Retry button, every suggestion resolution including no-ops and orphans, unrecognized inbox files.
- Needs-attention area: pending suggestions and orphan suggestions.

**Cowork (in every run summary it reports, and in the delivery `summary` field):**

- Sources skipped, blocked, or suspiciously empty (mirroring `source_health`).
- state.json staleness or absence, per section 5.
- Leftover un-ingested deliveries and any error markers found in `inbox/` at run start.
- Bootstrap stop (app never run), stated as an instruction to the user, not an error.

A blocked source, a stale state file, an unreadable Gmail body, or a pile of un-ingested deliveries must never abort a Cowork run; the run degrades, notes it, and delivers what it has. Symmetrically, a corrupt delivery must never take down the app or block other deliveries; it is marked, shown, and waits for a human.

---

## Deviations from Plan A / Plan B

The plans should be corrected to match the following; each line is a deliberate interface decision.

1. **Delivery filename** extended from Plan A's `delivery-YYYYMMDD-HHMM.json` to `delivery-YYYYMMDD-HHMMSS-<run_type>-<rand4>.json`: same-day (even same-minute) weekly-plus-session deliveries must be collision-proof and self-ordering.
2. **Error marker extension is `.error`, not `.json`**: any `*.json` marker name would match the watcher's `delivery-*.json` pattern class; a non-json extension makes false-positive detection structurally impossible.
3. **Posting gains an optional `tenant` field**: the structured key embeds the tenant, so delivering it keeps keys auditable without the app reverse-parsing key strings.
4. **Closed detection moved out of posting-record updates** (Plan A listed "closed detection" among mutable-field updates) **into status_suggestions with `suggested_status: "closed"`**: one single channel for all status-affecting information keeps "postings never change status" absolute and applies manual-wins uniformly.
5. **Explicit_user collisions resolve by timestamp (newest intent wins) instead of blanket manual-wins**: the system's primary flow (mark Interested in app, then "mark applied" in a session) would be a permanent no-op under a blanket rule. Manual still beats every non-explicit suggestion and every earlier-or-equal explicit one.
6. **Report filenames** gain a run-type suffix and a collision counter (Plan B said `reports/YYYY-MM-DD.md`): two runs in one day must not overwrite each other.
7. **Stale-update guard added** (per-posting last-accepted `produced_at`): makes out-of-order retry of an error-marked delivery unable to regress newer field values; neither plan addressed retry ordering.
8. **`hidden` is a boolean flag, not a status value**: Plan A's state.json shape already implied this; the superseded plan's status list included `hidden`. This spec fixes the split: status enum excludes hidden.
9. **Delivery gains an optional `state_read` object**: staleness becomes machine-visible instead of living only in prose summaries.
10. **Cowork may recreate its own writable folders (never `data/`, `app/`, `backups/`, `inbox/processed/`) when `data/` exists**: Plan A said the app creates all folders; strict reading would let one accidentally deleted `reports/` folder kill unattended runs.
11. **Catch-up runs are `run_type: "weekly"`** (they execute the weekly playbook), with the catch-up nature stated in `summary`; no fourth enum value.
12. **Structured keys are forbidden for `ats: "other"`**: invented tenant slugs drift between runs; unknown ATSes always use the hash form.
13. **se_rank semantics fully defined here** (best-across-locations, Remote (US) = 2, rank 1 cities and rank 2 states from profile/preferences.json, unknown = 3): the plans' one-line version is superseded.
14. **Apply-session prep packs live as `reports/YYYY-MM-DD-session-prep.md`** rendered by the Reports tab: Plan B gave them no home, and the ownership matrix does not allow Cowork to invent folders.
15. **Run-type mapping for special runs**: the attended rehearsal run is `run_type: "weekly"` (it executes the weekly playbook; its attended nature goes in `summary`); the week-zero catch-up sprint delivery is `"manual"`.
16. **Backups are gzip (`events-YYYYMMDD-HHMMSS.jsonl.gz` via Node's built-in zlib), not zip**, with Plan A's retention restated here (one per ingest + at most one per day at startup, keep newest 60): zero dependencies, Finder-double-clickable.
17. **The bootstrap gate also blocks Cowork's setup session**: the app must be built and run once before setup writes anything. Plan A's build order already implied this; the Cowork prompt must state it.

---

## Appendix A: Sample delivery fixture (supersedes Plan A's fixture sketch)

The app build MUST use this exact fixture for its acceptance tests (save it as `inbox/delivery-20260812-100000-manual-a1b2.json`). It exercises: structured and hash keys (both hash keys match the section 9 test vectors), a possible_repost, a same-delivery suggestion target, an explicit and a non-explicit suggestion, and source health. Expected outcome after ingest: 6 postings ingested; posting 5 files under Possible Reposts; William Blair immediately `applied` (explicit suggestion, rule 4); Wells Fargo gets a PENDING applied suggestion (non-explicit, rule 5); counts and exports regenerate.

```json
{
  "schema_version": 1,
  "delivery_id": "delivery-20260812-100000-manual-a1b2",
  "produced_at": "2026-08-12T10:00:00-04:00",
  "run_type": "manual",
  "postings": [
    {
      "key": "workday|fifththird|r123456",
      "company": "Fifth Third Bank",
      "division": "Wealth and Asset Management",
      "role": "Wealth Management Intern - Summer 2027",
      "category": "WM",
      "locations": ["Charlotte, NC"],
      "se_rank": 1,
      "source": "workday-cxs:fifththird",
      "ats": "workday",
      "tenant": "fifththird",
      "posting_url": "https://fifththird.wd1.myworkdayjobs.com/example/R123456",
      "apply_url": null,
      "req_id": "R123456",
      "date_posted": "2026-08-05",
      "deadline": null,
      "notes": "Rolling deadline per posting text.",
      "possible_repost_of": null
    },
    {
      "key": "hash|29b408b874d74411",
      "company": "Truist",
      "division": null,
      "role": "Corporate Finance & FP&A Intern",
      "category": "CorpFin",
      "locations": [],
      "se_rank": 3,
      "source": "dork:myworkdayjobs",
      "ats": "other",
      "tenant": null,
      "posting_url": "https://careers.truist.com/example/corp-finance-intern",
      "apply_url": null,
      "req_id": null,
      "date_posted": null,
      "deadline": null,
      "notes": "Location not stated on posting.",
      "possible_repost_of": null
    },
    {
      "key": "greenhouse|williamblair|6789012",
      "company": "William Blair",
      "division": "Private Wealth Management",
      "role": "Private Wealth Management Summer Intern 2027",
      "category": "PWM",
      "locations": ["Chicago, IL"],
      "se_rank": 3,
      "source": "greenhouse-api:williamblair",
      "ats": "greenhouse",
      "tenant": "williamblair",
      "posting_url": "https://boards.greenhouse.io/williamblair/jobs/6789012",
      "apply_url": null,
      "req_id": "6789012",
      "date_posted": "2026-08-01",
      "deadline": "2026-10-15",
      "notes": null,
      "possible_repost_of": null
    },
    {
      "key": "workday|wf|r555720",
      "company": "Wells Fargo",
      "division": "Commercial Banking",
      "role": "2027 Commercial Banking Summer Internship - Early Careers",
      "category": "CommBank",
      "locations": ["Charlotte, NC", "Atlanta, GA"],
      "se_rank": 1,
      "source": "workday-cxs:wf",
      "ats": "workday",
      "tenant": "wf",
      "posting_url": "https://www.wellsfargojobs.com/en/jobs/r-555720/",
      "apply_url": null,
      "req_id": "R-555720",
      "date_posted": "2026-06-25",
      "deadline": null,
      "notes": "Open to all majors; grad window Dec 2027 - June 2028.",
      "possible_repost_of": null
    },
    {
      "key": "hash|93a0ce5fbf6ba496",
      "company": "Fifth Third Bank",
      "division": null,
      "role": "Wealth Management Intern - Summer 2027",
      "category": "WM",
      "locations": ["Charlotte, NC"],
      "se_rank": 1,
      "source": "google-jobs",
      "ats": "other",
      "tenant": null,
      "posting_url": "https://example-aggregator.com/jobs/fifth-third-wm-intern",
      "apply_url": null,
      "req_id": null,
      "date_posted": null,
      "deadline": null,
      "notes": "Aggregator copy of what looks like the Workday posting.",
      "possible_repost_of": "workday|fifththird|r123456"
    },
    {
      "key": "usajobs|usajobs|823456700",
      "company": "FDIC",
      "division": "Division of Finance",
      "role": "Financial Management Scholar Intern (Summer 2027)",
      "category": "Federal",
      "locations": ["Washington, DC"],
      "se_rank": 3,
      "source": "usajobs-api",
      "ats": "usajobs",
      "tenant": "usajobs",
      "posting_url": "https://www.usajobs.gov/job/823456700",
      "apply_url": null,
      "req_id": "823456700",
      "date_posted": "2026-08-03",
      "deadline": "2026-09-30",
      "notes": "US citizens only (you qualify).",
      "possible_repost_of": null
    }
  ],
  "status_suggestions": [
    {
      "posting_key": "workday|wf|r555720",
      "suggested_status": "applied",
      "evidence": "Confirmation email from @myworkdayjobs.com received 2026-08-11, subject 'Thank you for applying'",
      "explicit_user": false,
      "observed_at": "2026-08-11T17:22:00-04:00",
      "suggested_applied_date": "2026-08-11"
    },
    {
      "posting_key": "greenhouse|williamblair|6789012",
      "suggested_status": "applied",
      "evidence": "The user said 'mark William Blair applied' in the 2026-08-12 session",
      "explicit_user": true,
      "observed_at": "2026-08-12T09:58:00-04:00",
      "suggested_applied_date": "2026-08-12"
    }
  ],
  "source_health": [
    { "source": "workday-cxs:wf", "tried": true, "yield": 1, "note": null },
    { "source": "greenhouse-api:williamblair", "tried": true, "yield": 1, "note": null },
    { "source": "linkedin-alert-email", "tried": false, "yield": 0, "note": "No alert emails this run (test fixture)." }
  ],
  "summary": "Test fixture delivery: 6 postings across WM, PWM, CommBank, CorpFin, and Federal, including one possible repost and two status suggestions (one explicit, one email-detected).",
  "outreach_files": [],
  "state_read": { "state_generated_at": null, "state_schema_version": null, "stale": false, "note": "Test fixture; produced against an empty state." }
}
```

---

## Changelog

v1.9, tracker edition: a trimmed copy of v1.9 with the apply agent (section 2.7), the Practice tab (section 2.12), and networking drafts removed, and with categories, location ranks, and email addresses moved into `profile/preferences.json`.

End of specification.
