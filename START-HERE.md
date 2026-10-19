# InternshipHunt: start here

InternshipHunt is a private internship tracker that runs on your own Mac, plus a weekly search that finds new postings for you, checks every link, and reads your email to log applications and catch interview and assessment invites. Everything lives in this folder on your computer and runs on your own Claude account. Nothing is shared with anyone.

## What you need

- A Mac
- A paid Claude plan (Pro or Max), with the Claude desktop app installed
- The Gmail account(s) you apply to jobs from
- About 20 minutes

## Setup (4 steps)

1. **Put this folder in your home folder.** In Finder, choose Go > Home (the house icon) and drag the `InternshipHunt` folder there. It must end up at `/Users/<your name>/InternshipHunt`.
2. **Install Node.js.** Go to https://nodejs.org, download the macOS installer (the LTS one), and click through it.
3. **Open the Claude desktop app, go to the Code tab, and pick the `InternshipHunt` folder.** Then type:

   > Read START-HERE.md and set me up.

4. **Answer Claude's questions.** It asks about your school, what roles you want, where you want to be, which companies you are most excited about, and which email you apply from. Then it installs everything, opens the tracker in your browser, and helps you turn on the weekly search.

After that, open the tracker any time at http://localhost:4321. To change anything later (new cities, new target companies, a different weekly time), open this folder in Claude's Code tab and just ask.

---

## Instructions for Claude (the setup session)

You are setting up InternshipHunt for the person you are talking to. It is a fresh install: there is no data yet and every personal setting is blank. Talk in plain language, a few questions at a time, and explain what you are doing as you go. The user is probably not a developer: give them clicks, not jargon, and never ask a technical question you can answer by reading this folder. No em dashes in anything you write.

The system has two halves. Read `INTERFACE-SPEC.md` (the contract) and `cowork/PLAYBOOK.md` (the weekly finder's instructions) before you start, so you understand what each setting drives.

- **The app** (`app/`, a small Node server at http://localhost:4321) owns all data under `data/` and shows it. Never write under `data/` yourself.
- **The weekly finder** is a scheduled Claude run that follows `cowork/PLAYBOOK.md`, finds and verifies postings, scans the user's email, and drops delivery files into `inbox/` for the app to pick up.

### Step 1: Check the basics

- This folder must be at `~/InternshipHunt`. If it is somewhere else, ask the user to move it (or offer to move it for them) and reopen it in the Code tab.
- Run `node -v`. If Node is missing or older than 18, ask the user to install the LTS from https://nodejs.org (it needs their Mac password, so they do it) and wait.

### Step 2: Interview the user

Ask conversationally, in small batches. Do not invent answers; if they are unsure, offer suggestions and let them pick.

1. Name, school, major(s), year in school, graduation month and year, and work authorization (citizen, permanent resident, needs sponsorship).
2. Target season (for example Summer 2027), the kinds of roles they want, roles they do not want, and industries they care about. Turn this into 3 to 8 short **category** names that cover their search (for example `Software`, `Data`, `Product`). Confirm the list with them.
3. Location: their top-choice cities (rank 1), states that are good but not top choice (rank 2, as two-letter codes), and whether Remote (US) counts as rank 2. Location only sorts postings; it never hides any.
4. Every email address they apply from. If they offer a resume, read it to fill in the Background section, and ask before saving a copy into `profile/`.
5. Their starred firms: the 5 to 20 companies they most want. If they are unsure, suggest companies that fit their categories and let them choose.
6. Whether they get LinkedIn or Handshake job-alert emails (this decides two source statuses).

### Step 3: Write their settings

- `profile/profile.md`: fill in every section from the interview. Leave a section's prompt text out once it is answered. Research the recruiting calendar for their field and target season (when programs usually open and close) and write it under Recruiting calendar notes.
- `profile/preferences.json`: set `email_addresses`, `categories`, `rank1_cities` (lowercase), `rank2_states` (two-letter codes), `remote_is_rank2`, and optionally friendlier `rank1_label` / `rank2_label`. Keep the `_help` block. Make sure it is valid JSON.
- `cowork/sources.md`: fill in the keyword rotation pool from their roles and cities, add trackers, GitHub repos, and job boards that specialize in their field, set the LinkedIn and Handshake alert sources to `core` or `retired` from their answer, and add any of their starred firms' Greenhouse, Lever, Ashby, or Workday boards you can confirm.

Show the user a short summary of what you saved and ask if anything is off.

### Step 4: Install and start the app

Run `zsh ~/InternshipHunt/setup.sh`. It installs the one dependency, runs the tests, points the playbook at this Mac, turns on autostart (the app starts at login and restarts itself if it crashes), and opens http://localhost:4321. If it fails, read the message, fix it, and run it again; it is safe to rerun. Because `profile/preferences.json` is read when the app starts, run `~/InternshipHunt/bin/ih restart` whenever you change it later.

Check that the page loads and the category filter shows their categories. The app is empty until the first search delivers.

### Step 5: Connect their email

The weekly finder reads email through Claude's Gmail connector. Ask the user to connect it themselves in the Claude app's settings (Connectors > Gmail) and sign in with the Google account(s) that get their job email. You never handle their passwords.

### Step 6: Turn on the weekly search

Create a weekly scheduled task in the Claude desktop app with the user. Let them pick the day and time (an evening when the Mac is on and plugged in works best). The two settings that matter most: it must **run on this computer** (not in the cloud), and the **`~/InternshipHunt` folder must be attached**, or it cannot see the app. If you have a tool that creates local scheduled tasks, you may create it yourself after the user confirms the schedule; otherwise walk them through it (Cowork > Scheduled > New task). Task name: `InternshipHunt weekly sweep`. Prompt:

> Run the InternshipHunt weekly sweep. Read ~/InternshipHunt/INTERFACE-SPEC.md and ~/InternshipHunt/cowork/PLAYBOOK.md in full and follow the playbook exactly, start to finish, with run_type "weekly". Work unattended and never ask questions.

Offer to run it once right now so they see postings arrive. A first run takes a while; deliveries show up in the app on their own.

### Step 7: The two buttons in the app

- **Find more opportunities** starts an extra search on demand. It needs Claude Code's command-line tool. Run `which claude`; if nothing is found, offer to install it with the official installer and have the user sign in themselves.
- **Rescan email for applications** opens a Cowork session that scans their email for applications and next steps. It needs the Gmail connector from Step 5.

### Step 8: Wrap up

Tell the user, briefly:

- Open the tracker at http://localhost:4321 (bookmark it). Tabs: Postings, Reports, Log.
- Mark postings Interested, Applied, or Hide as they go. Status suggestions from email show up for one-click confirm.
- The Mac has to be awake and plugged in when the weekly search runs.
- `~/InternshipHunt/bin/ih help` lists the controls (open, status, restart, stop, start, logs).
- To change anything (cities, categories, starred firms, schedule), open this folder in Claude's Code tab and ask.

Rules for this and every later session: the user's information stays in `profile/` on this Mac and goes nowhere else. Never fill out or submit job applications, never type passwords, and never scrape LinkedIn or Handshake.
