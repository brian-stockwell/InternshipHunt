# InternshipHunt Weekly Run Playbook

This playbook writes interface schema_version 1. INTERFACE-SPEC.md (v1.1) is authoritative over this file wherever they seem to disagree. Written 2026-08-10.

Purpose: the weekly sweep for the user's internship hunt (who they are and what they want: profile/profile.md and profile/preferences.json). Read state, hunt, verify, dedupe, rank, deliver drop files to inbox/. Never write under data/, app/, backups/, or inbox/processed/. Never modify a delivery after publishing. Never maintain a separate tracker.

Run entirely with web search and direct HTTP fetches. NEVER use the Chrome browser extension in an unattended run (it requires an open, attended browser). Never let one failed source, one unreadable email, or a stale state file abort the run: skip, note it in source_health and the summary, continue.

Environment (this task runs locally on the user's Mac): the project root is `__INTERNSHIPHUNT_ROOT__`. Resolve `~/InternshipHunt` and every relative path in this file (`data/`, `cowork/`, `inbox/`, `reports/`, `outreach/`, `profile/`) against that absolute root, whatever the working directory happens to be. Node lives at `__NODE__`; if that binary is missing, fall back to plain `node` on PATH, and if neither runs, note it in the summary and stop rather than hand-computing a key or filename.

Who the user is, for judgment calls: read `profile/profile.md` in full before you start (school, major, graduation date, target season, work authorization, the kinds of roles they want and do not want, starred firms). The category list is `categories` in `profile/preferences.json`; use those exact spellings and nothing outside the list. Location is a ranking, never a filter: se_rank 1 = a location matching any `rank1_cities` entry; 2 = a location in a `rank2_states` state, or Remote (US) when `remote_is_rank2` is true; 3 = everything else including unknown.

## Parallel work

Capability check, once, at the start of every run: determine whether you can spawn subagents in this environment. If you can, use the fan-out form of steps 2b and 5. If you cannot, do those steps sequentially yourself exactly as written. A missing subagent capability is NEVER a run failure: sequential is a valid run. Either way, state which path you took in the report and the delivery summary, in the form "fan-out: yes, N workers" or "fan-out: no, sequential" plus the reason.

Rules that hold on either path:

- Politeness is per host, not global. Two workers on two different companies is fine. Two workers on the same Workday tenant is not: one worker owns one company end to end, and inside that company it paginates sequentially.
- At most 5 workers running at once. More is not faster here and it starts to look like scraping.
- Workers RESEARCH and RETURN. No worker writes a file, appends to `cowork/seen.jsonl`, publishes a delivery, or touches `inbox/`. Every write in the run is yours, done in step 9.
- The verification standard in step 5 is not relaxed for workers. A worker that cannot positively confirm a posting returns "unverifiable", never a guess. Delegation must not become a back door around the rule the user tightened after two bad links reached the app.
- A worker that fails, times out, or returns nothing is not fatal. Name that company and the reason in source_health and continue with what the rest returned. Never let a failed worker turn into silent non-coverage.
- Steps 1, 2, 3, 4, 6, 7, 9, and 10 are yours alone, never delegated. Dedup (6) needs every posting in one view to compare against state.json and seen.jsonl, and publish (9) needs a single writer to keep the write-then-rename ordering intact.

## Steps, in order

1. **Gate and read state**: confirm `~/InternshipHunt/data/` exists (if not: stop, write nothing, message the user "The InternshipHunt app has never been run on this machine. Open it once, then re-run me.", done). Read `data/state.json` ONCE (spec section 5 discipline: missing or unparseable = treat as empty and note it; generated_at older than 9 days = proceed and set state_read.stale true). Read `cowork/seen.jsonl` and `cowork/sources.md`. Inspect `inbox/` read-only: report leftover un-ingested deliveries and any `.error` markers in your summary (never touch them). Then check `cowork/requests/` for queued requests from the app: the Rescan button cannot read mail from the app itself (see R0), so it drops a `rescan-*.json` there instead. If any exist, run Application rescan mode as part of this run before anything else, delete each request file you fulfilled, and say in the summary which ones you picked up. A queued request that sits unfulfilled is a silent failure of exactly the kind R1 exists to prevent.

2. **Core sweep**: work through every `core` source in sources.md. Pace politely (sequential within any one source or tenant, no hammering; this is a per-host rule, see Parallel work above, not a ban on covering two different companies at the same time; Workday CXS returns max 20 per page and silently truncates under aggressive pagination, so sanity-check its reported total against what you got). Harvest new Workday tenant slugs from any dork results and add them to sources.md.

2b. **Full company-page enumeration**: job boards and dorks are leads, not coverage. For EVERY firm on the starred list in profile/profile.md, and for every company that produced at least one candidate posting this run, go to that company's own careers site and enumerate ALL of its intern / early-talent / student postings, paginating to the end of the listing, not just the first page and not just the roles a board surfaced. Judge every posting found there against the user's categories (preferences.json) and eligibility (profile.md); deliver everything that qualifies. If a company's careers site cannot be enumerated (login wall, hard bot-block), say so in source_health rather than silently covering only board results. FAN-OUT FORM (preferred whenever subagents are available; this step is the main reason fan-out exists, it is the largest step in the run and the one most likely to run out of context if done in one pass): one worker per company, each owning that company's careers site end to end and paginating to the end of the listing. Each worker returns only the postings that qualify against the user's categories and eligibility, each with company, role, all locations, req id and ATS where visible, and the canonical posting URL, plus a one-line coverage note saying how many pages it enumerated or exactly why enumeration failed. You hold the master list. If the number of companies exceeds the 5-worker cap, run them in successive batches of 5 until every starred firm and every candidate-producing company is covered; never trim the company list to fit one batch.

3. **Gmail pass**: search every address in `email_addresses` in `profile/preferences.json` (see Application rescan mode for the rule on addresses not yet on that list) for the past week's LinkedIn/Handshake/talent-community alert emails (postings inside them get verified at the source and delivered like any other posting; the alert email is the source, the employer ATS link is the posting_url) and for application confirmations (sender domains like myworkdayjobs.com, greenhouse-mail.io, hire.lever.co, ashbyhq.com, smartrecruiters.com): each becomes a status_suggestion with `explicit_user: false`, evidence quoting sender and subject, observed_at = email receipt time. Also search, explicitly and every week, for next-round and advancement emails per R3 and R3b below: "congratulations", "moving forward", "next steps", "you have been selected", interview and assessment invitations, offer letters. The Application rescan mode rules below are not optional here: apply the R1 reachability gate (never report "no new applications" for a mailbox you could not scan), the R4 dedup layers, the R3b next-round rules, and the R6 action-item disclaimer, exactly as written. If message bodies will not load, log it and move on.

4. **VARIANCE STEP, mandatory, never skip**: each run, (a) invent and actually try 2 NEW sources or query formulations (a fresh Google dork, a board you have not tried, a firm list from a news article, a plain Google search counts), and (b) RECHECK 1 previously logged source from the retired list in sources.md, rotating oldest-recheck-first so every retired source cycles back around. A retired source that produces on recheck is revived (experimental, or core if it clearly earns it). At least once a month, one of the 2 new experiments must be a channel TYPE not already in sources.md; if after months of runs a genuinely new angle is not findable, say so in the report and recheck a second retired source instead of inventing a junk experiment. Channels the user explicitly declined (see sources.md: LinkedIn alerts, Handshake, talent communities) are NOT in the recheck rotation; they revive only if the user says so. Log every experiment, every recheck, and its yield in sources.md; promote producers to `core`; after two consecutive zero-yield tries, move a source to `retired` (keep it listed; retirement now means "resting in the recheck rotation", not gone). This is the user's explicit requirement: the scan itself must never calcify.

5. **Verify**: every posting_url must be OPENED and its rendered content READ before it goes in a delivery. An HTTP 200 never counts as verification by itself: ATS sites happily return 200 for "job no longer available" pages, careers-home redirects, and search pages. A link is deliverable only when you positively confirmed ALL of the following on the destination itself:
   - The page shows THIS posting: the title and company visibly match what you are delivering.
   - There is a working apply path on the page (an Apply button or equivalent), meaning the user lands somewhere he can actually start an application.
   - The URL is the direct, canonical ATS posting page, not an aggregator copy, a tracking redirect, or an intermediate board page. Resolve redirects to their final destination and deliver that.
   How to read the screen given the run mode:
   - Attended session: open the page in the browser and read it. Actually look.
   - Unattended run (HTTP fetch only): read the fetched body text. For JS-rendered ATS pages where the raw HTML contains no posting text (Workday, Oracle Cloud recruiting, some iCIMS), confirm through that ATS's data endpoint instead (Workday CXS job API, Oracle Cloud recruiting API, Greenhouse/Lever/Ashby public JSON) that the req id exists, is open, and matches the title, then deliver the canonical page URL for that tenant.
   If you cannot positively confirm the destination by either path, DO NOT deliver the link as a live posting. Either find a link you can confirm, or drop the posting and record it in the summary as found-but-unverifiable. A missing posting costs the user one opportunity; a broken link costs trust in every link.
   Check eligibility while you are there against profile/profile.md: the target term and the graduation date; a posting clearly scoped to a different class year or term gets skipped. If a sweep shows a previously delivered posting is now closed, that is a status_suggestion (`"closed"`, `explicit_user: false`), not a posting edit.
   FAN-OUT FORM: distribute the unverified postings across workers, never more than one worker on a given ATS tenant at a time. For each posting a worker returns a verdict of verified-live, closed, or unverifiable, the canonical URL it resolved to after following redirects, and a one-line note on what it actually saw on the destination (title and company match, apply path present). It returns unverifiable whenever it cannot confirm all three bullets above, and you treat that exactly as you would your own unverifiable: drop the posting and record it as found-but-unverifiable. Never promote a worker's verdict to verified on the strength of an HTTP 200 or a plausible-looking URL.

6. **Dedup and key**: compute each posting's key: structured `ats|tenant|req_id` when you have all three and the ATS is in the spec enum (never for `ats: "other"`); otherwise hash form via `__NODE__ ~/InternshipHunt/cowork/helpers.mjs key "<company>" "<role>" "<loc1;loc2>"`. Never hand-compute a hash. Skip anything already in state.json or seen.jsonl unchanged. A fuzzy match to something already applied or hidden (same company and near-identical role, different or missing req id): deliver it WITH `possible_repost_of` set rather than silently dropping it.

7. **Categorize and rank**: assign the single closest category from `categories` in `profile/preferences.json` (exact spelling; nothing outside the list); se_rank per the location ranking above (best rank across all listed locations).

8. **Networking: turned off in this edition.** Write no outreach files. `outreach_files` in every delivery is `[]`.

9. **Publish, in exactly this order** (each file: write to a dot-prefixed temp name in its destination folder, then rename): the report `reports/YYYY-MM-DD-weekly.md`, then the DELIVERY (filename from `__NODE__ ~/InternshipHunt/cowork/helpers.mjs newname weekly`; validate BEFORE renaming, but note that `helpers.mjs validate` checks the FILENAME too, so pointing it at the dot-prefixed temp always fails on the filename and the delivery_id mismatch. Copy the temp to a scratch location under its FINAL name and validate that copy: `cp inbox/.<name> /tmp/<name> && __NODE__ ~/InternshipHunt/cowork/helpers.mjs validate /tmp/<name>`, fix any failure, then rename the real temp; the rename is the commit), then append the new keys to `cowork/seen.jsonl` (one compact JSON object per line, at minimum `{"key": ..., "first_seen": ..., "company": ..., "role": ...}`). Never reverse this order; never touch a delivery after the rename. If a published delivery turns out wrong, ship a correction as a NEW delivery; only the user may repair a file in place.

10. **Report content** (`reports/` file; the app renders it): what is new and notable this week by category, what is closing soon, where you looked, what the variance step tried and what it yielded, source health issues, and state staleness if any. Also state the run shape: fan-out yes or no, how many workers, how many companies were enumerated in step 2b, and every company a worker failed on with the reason. The user needs to be able to tell a thin week apart from a week where coverage quietly fell short. The delivery's `summary` field is the compact version of the same. Write both for the user, plainly. No em dashes anywhere.

## Application rescan mode

Triggered by the "Rescan email for applications" button under the applied group in the app, or by the user asking for it directly. `run_type` is `"manual"`. This mode does NOT hunt for postings: skip steps 2, 2b, 4, and 8 entirely. Its only jobs are to find applications the user made that the tracker does not know about, and to surface anything an employer is waiting on him to do.

**Mailboxes in scope:** every address in `email_addresses` in `profile/preferences.json`.

That list is a floor, not a ceiling. The user may apply from whichever address is autofilled, so treat the recipient address as data you discover rather than a filter you impose: search by sender and subject, and when an application email is addressed to something not on this list, deliver it like any other AND name the unlisted address in the report so the list can be corrected. Never discard an application confirmation because its recipient address was not expected.

**R0. Which surface you are running on.** The user's Gmail connector is authorized inside Cowork. The headless `claude -p` process that the app's buttons spawn on the Mac is a DIFFERENT surface with its own MCP config, and it has no mail connector at all. A rescan launched from the app therefore cannot read email no matter how it is written, and the first attempt burned three minutes proving it. So:

- Running in Cowork, or as the Cowork scheduled task: you have mail. Proceed.
- Running as a headless run spawned by the app: you do not. The app now refuses to launch this mode for that reason, so if you somehow find yourself here anyway, stop, publish a delivery saying the surface has no mail path, and tell the user to run it from Cowork.

Do not go looking for a substitute mail path (IMAP clients, Apple Mail, Outlook). That search is wasted effort: if the Gmail connector is absent, the answer is the wrong surface, not a workaround.

**R1. Reachability gate, before any searching.** For each mailbox, confirm you can actually search it, by running a search scoped to that address and confirming the tool returns results belonging to that mailbox rather than an error, an empty connector, or another account's mail. Classify each mailbox as SCANNED or UNREACHABLE and carry that verdict into the report.

NEVER report "no new applications" for a mailbox you could not search. An unscanned mailbox and an empty mailbox look identical in the output and mean opposite things, and the cost of confusing them is the user believing nothing is outstanding while an assessment quietly expires. Say "could not scan <address>" and say why. If EVERY mailbox is unreachable, still publish a delivery, with empty `postings` and empty `status_suggestions` and a summary that states plainly that nothing was scanned, so the run leaves a record in the app's Log tab instead of vanishing.

**R2. Window.** Search from the day after the most recent prior rescan (find it in `reports/`) through today. If no prior rescan exists, use the last 90 days. State the window in the report.

**R3. What to look for.** Application confirmations and any later message on the same application: sender domains like `myworkday.com`, `myworkdayjobs.com`, `greenhouse-mail.io`, `hire.lever.co`, `ashbyhq.com`, `smartrecruiters.com`, `icims.com`, plus employer-run domains; subjects along the lines of "thank you for applying", "application received", "we received your application", "update on your application". ALSO search, as its own pass rather than hoping the confirmation searches surface them, for next-round and advancement language : "congratulations", "moving forward", "move forward", "next steps", "next stage", "next round", "you have been selected", "advance", "invitation to interview", "interview invitation", "schedule your interview", "assessment invitation", "video interview", "offer". A next-round email often arrives from a recruiter's personal address rather than an ATS domain, so search by phrase across the whole mailbox in the window, not only by sender domain. Read the message body, not just the subject: employers reuse one subject line for a confirmation, a rejection, and a revival.

**R3b. Next-round and advancement emails.** Any email showing that the user moved forward on an application becomes a status_suggestion (`explicit_user: false`), matched to its posting per R4:

- The email names the next stage: suggest that stage. `oa` for an assessment, questionnaire, or recorded video interview; `interview` for a live interview or a scheduling request; `offer` for an offer.
- The email asks the user to DO something (complete the assessment, pick a slot, return a form): the existing R6 rules apply unchanged, ACTION REQUIRED evidence and all. A deadline outranks a celebration; do not replace an ACTION REQUIRED prefix with a NEXT ROUND one.
- The email announces advancement but names no concrete next step ("your application is progressing, a recruiter will reach out"): suggest the stage the application is currently at (yes, that resolves as a no-op in the app; the evidence still gets through) and prefix the evidence exactly like this, pipes as separators, no pipes inside a field:

  `NEXT ROUND: <what the email says, one short line> | <sender, subject, received date>`

  The app parses this prefix to build its "Moving forward" strip, and it remembers the evidence even after the suggestion resolves, so the news is never lost to a no-op. Use the NEXT ROUND prefix ONLY for advancement emails with nothing for the user to do; anything with an ask is ACTION REQUIRED per R6.
- A rejection is not a next round: suggest `rejected` with plain evidence, as before. When one application has several emails, R4's latest-email-wins ordering decides.

**In the report,** list every advancement found under a "Moving forward" heading right after the Action required section, and write "Moving forward: none found in this window" when there are none, so absence is never ambiguous.

**R4. Dedup, so nothing is counted twice.** Three layers, all required:

- Against the tracker: read `data/state.json` (already read in step 1) and skip any posting whose status is already `applied`, `oa`, `interview`, or `offer` when the email is evidence of that same status. When the email shows a req id, the req id decides the match and company plus role never overrides it. Example: the tracker holds req 10435672 "Finance Rotation Program" while a confirmation arrives for req 10435673 "Operations Finance Rotational Program" at the same company. Nearly the same role name, one digit apart, and two genuinely different applications. Merging those loses one. Only fall back to company plus role when no req id appears anywhere in the email, and say in the report that you matched on the weaker signal.
- Within the run: emit at most ONE suggestion per `posting_key` plus `suggested_status` pair, even when three emails describe the same application. Cite the earliest email as evidence and mention the later ones in the report.
- Ordering: when one application has several emails (applied, then rejected, then revived), suggest only the status the LATEST email supports, not one suggestion per stage. A rejection followed by a revival is `oa` or `interview` or back to `applied` as the revival says, never a `rejected` suggestion you then contradict.

The app is the backstop, not the plan. Its ingest rules already no-op a suggestion whose status the posting already has (spec rule 2) and absorb a repeat of a pending suggestion (spec rule 3), but relying on that alone leaves the user dismissing duplicates by hand. Do the work here.

**R5. Applications for postings the tracker does not have.** Common: The user applied to something the sweep never delivered. Preferred handling is to verify the posting per step 5 and include it in this delivery's `postings` array, then point the suggestion at it, since a suggestion may reference a posting added by the same delivery. If the posting cannot be verified (req closed, page gone), still emit the suggestion; it lands as an orphan that the app shows in its needs-attention area with the evidence text, which is the correct outcome. Either way, name every one of these in the report so the user can see what he applied to outside the tracker.

**R6. Action items, matched to a posting, and made loud.** This is the highest-value thing the rescan does. An application the user forgot to log costs him bookkeeping; an assessment he never saw costs him the job.

**What counts as an action.** Anything an employer is waiting on the user to do. Not assessments alone:

- Recorded or on-demand video interview (HireVue, ModernHire, Spark Hire)
- Online assessment, OA, questionnaire, coding challenge (Codility, HackerRank, CodeSignal), game-based or Pymetrics-style assessment
- An interview to schedule, or a scheduling link to pick a slot from
- Documents requested: transcript, resume update, references, work authorization, background check consent
- A form, profile, or portal step left incomplete, including "your application is incomplete" nudges
- An offer or decision with a response-by date
- An identity or email verification step that blocks the application from progressing

When in doubt, treat it as an action. A false positive costs the user ten seconds of reading. A false negative costs him the posting.

**Match it to the posting.** Every action must carry the `posting_key` of the internship it belongs to, matched by req id first exactly as in R4. The app cannot show the user "this assessment is for that job" unless the suggestion points at the right key. If the posting is not in the tracker, do NOT drop the action: deliver the posting per R5 so the action attaches, and if the posting cannot be verified, still emit the suggestion as an orphan and say so loudly in the report. An action nobody can attach to a job is the most dangerous kind, because it is the easiest to scroll past.

**Status to suggest:** `oa` for an assessment, questionnaire, challenge, or recorded video interview. `interview` for a live interview invite or scheduling request. For document requests, verification steps, and incomplete-application nudges where the stage has not changed, suggest the stage the application is actually at (usually `applied`) and let the action text carry the urgency.

**Evidence format, exact.** The app parses this to build its Action required banner, so the first two fields are structural, not prose. Pipes separate them:

`ACTION REQUIRED: <what the user must do, one short line> | DUE: <YYYY-MM-DD, or "not stated"> | InternshipHunt does not track, remind about, or complete these. The employer email is the only authority on the deadline. Nothing has been started or completed on your behalf. | <sender, subject, received date>`

Rules for the fields: `<what>` is imperative and specific ("Complete Acme Corp HireVue questionnaire", not "assessment"). `DUE:` is an absolute date even when the email says something relative: an email sent 2026-08-11 saying "3 days to complete" is `DUE: 2026-08-14`. Compute it, never pass the relative phrase through. Use `not stated` only when the email truly gives no deadline, and never guess one.

**In the report,** open with an Action required section above everything else: company, role, what is being asked, the due date, and which mailbox it came from. If there are none, write "Action required: none found in this window" rather than omitting the section, so its absence is never ambiguous.

**Never open the link.** Report assessment, interview, and verification links; never start, complete, schedule, or click through one. This is the existing no-auto-submit rail applied to exactly the thing employers most want automated.

**R7. Publish** per step 9, with this difference: the report is `reports/YYYY-MM-DD-manual.md` (append `-2`, `-3` if a manual report already exists for today, per spec section 8). The report states, in order: the Action required section, then per-mailbox SCANNED or UNREACHABLE verdicts, the search window, applications newly found, applications skipped as already tracked and why, and anything found that could not be matched to a posting.

## Standing calendar judgment (verify live before acting)

Recruiting calendars differ by field. Use the target season in profile/profile.md and its "Recruiting calendar notes" section (if present) to decide where weekly effort pays off and which programs have already closed; verify live rather than assume. Standing rule all cycle: rolling programs reward applying within 1 to 2 weeks of posting; deadline fields lie, speed matters.

## Safety rails (absolute)

- Never write anything under `~/InternshipHunt/data/`, `app/`, `backups/`, or `inbox/processed/`. Never modify, rename, or delete a delivery after publishing it. Never create `data/` (bootstrap gate). May recreate a missing Cowork-owned folder (inbox/, reports/, outreach/, cowork/, profile/) only when data/ exists, noting it in the summary.
- Never store, type, or transmit passwords. Never create accounts. Never complete CAPTCHAs or verification challenges. Never fill out or click Submit on an application, and never touch EEO/self-ID, legal-attestation, or consent fields. Applying is the user's job.
- Never scrape or automate linkedin.com or joinhandshake.com. Their content arrives via email alerts only.
- Never auto-submit anything anywhere. This system prepares and assists; the user applies.
- Status changes travel only as status_suggestions in deliveries. Email-detected ones are never explicit_user: true.
- No em dashes in anything written: files, reports, outreach drafts, messages.
- Work unattended: never wait on a question; degrade gracefully and note every problem in the delivery summary.
