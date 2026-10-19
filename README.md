# InternshipHunt

A private internship tracker that runs on your own Mac, plus a weekly search that finds new postings for you, checks every link, and reads your email to log applications and catch interview and assessment invites. Claude sets it up for you by interviewing you about your school, the roles you want, where you want to be, and the companies you care about most.

Everything you enter stays on your own computer and runs on your own Claude account.

## Get it

You need a Mac, a paid Claude plan (Pro or Max) with the Claude desktop app, and Node.js from https://nodejs.org.

**Option A (Terminal):**

```bash
git clone https://github.com/brian-stockwell/InternshipHunt.git ~/InternshipHunt
```

**Option B (no Terminal):** click the green **Code** button above, then **Download ZIP**. Unzip it, rename the folder from `InternshipHunt-main` to `InternshipHunt`, and drag it into your home folder (Finder > Go > Home).

Either way the folder has to end up at `/Users/<your name>/InternshipHunt`.

## Set it up

Open the Claude desktop app, go to the **Code** tab, pick the `InternshipHunt` folder, and type:

> Read START-HERE.md and set me up.

Claude takes it from there. The full guide is in [START-HERE.md](START-HERE.md).

## Keep your info private

This repo is shared with other people. Your profile, settings, and tracker data are meant to stay on your Mac, so never run `git push` from your copy. To get updates later, run `git pull` inside `~/InternshipHunt` (or download the ZIP again).
