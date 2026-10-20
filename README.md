# InternshipHunt

A private internship tracker that runs on your own Mac, plus a weekly search that finds new postings for you, checks every link, and reads your email to log applications and catch interview and assessment invites. Claude sets it up for you by interviewing you about your school, the roles you want, where you want to be, and the companies you care about most.

Everything you enter stays on your own computer and runs on your own Claude account.

## Try it first

**[Open the interactive tutorial](https://brian-stockwell.github.io/InternshipHunt/)**: the real tracker, filled with a made-up student's search, plus a coach that walks you through every button in about 10 minutes. Nothing to install, and nothing you click there goes anywhere. After setup, the same tutorial is one click away inside your tracker (the **Tutorial** button at the top).

## Get it

**Never used Terminal or GitHub?** The [tutorial's first chapter](https://brian-stockwell.github.io/InternshipHunt/) walks you through the whole install one click at a time, with a "you should see" check after every step.

You need a Mac (macOS 13 or newer), a paid Claude plan (Pro or Max) with the [Claude desktop app](https://claude.com/download), and the free macOS installer for [Node.js](https://nodejs.org/en/download).

**Option A (no Terminal):** [download the ZIP](https://github.com/brian-stockwell/InternshipHunt/archive/refs/heads/main.zip). Unzip it if your browser did not, rename the folder from `InternshipHunt-main` to `InternshipHunt`, and move it into your home folder (Finder > Go > Home).

**Option B (Terminal):**

```bash
git clone https://github.com/brian-stockwell/InternshipHunt.git ~/InternshipHunt
```

Either way the folder has to end up at `/Users/<your name>/InternshipHunt`.

## Set it up

Open the Claude desktop app, go to the **Code** tab, pick the `InternshipHunt` folder, and type:

> Read START-HERE.md and set me up.

Claude takes it from there. The full guide is in [START-HERE.md](START-HERE.md).

## Keep your info private

Setup fills `profile/` with your details, and the tracker keeps your data in folders that `.gitignore` leaves out of this project. Your copy is meant to stay on your Mac, so never push it to GitHub or anywhere else. To get updates later, run `git pull` inside `~/InternshipHunt` (or download the ZIP again).

## License

MIT. Use it, change it, and share it, for free. See [LICENSE](LICENSE).
