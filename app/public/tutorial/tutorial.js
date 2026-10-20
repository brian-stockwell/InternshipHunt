// tutorial.js: the coach for the practice copy of InternshipHunt.
//
// Boot order: demo-api.js has already swapped in the pretend back end. This
// file pulls the real app's page (../index.html) and script (../app.js) so the
// practice copy is always the actual tracker, then walks the person through it
// one small task at a time. Each task is checked off by watching the practice
// data (window.__demo) or the screen, and the coach moves on by itself.

(function () {
  "use strict";

  const D = window.__demo;
  const q = (sel, root = document) => (root ? root.querySelector(sel) : null);
  const qa = (sel, root = document) => (root ? [...root.querySelectorAll(sel)] : []);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const REPO = "https://github.com/brian-stockwell/InternshipHunt";
  const PROGRESS_KEY = "internshiphunt.tutorial";
  const RESUME_KEY = "internshiphunt.tutorial.resume";
  const isLocalApp = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------------------
  // Finding things on the app's screen
  // ---------------------------------------------------------------------------
  const shown = (el) => !!el && !el.closest(".hidden") && el.getClientRects().length > 0;
  const posting = (company) => D.find(company);
  const detailOpen = () => { const d = q("#detail"); return !!d && !d.classList.contains("hidden"); };
  const detailFor = (company) => detailOpen() && q("#detail h2")?.textContent === company;
  const modalOpen = () => { const m = q("#apply-modal"); return !!m && !m.classList.contains("hidden"); };
  const activeTab = () => q(".tab.active")?.dataset.tab || "postings";
  const button = (root, text) => qa("button", root).find((b) => b.textContent.trim() === text) || null;
  const rowFor = (company) => qa("#groups .row").find((r) => q(".company", r)?.textContent === company) || null;
  const stripRow = (boxSel, rowSel, company) => qa(`${boxSel} ${rowSel}`).find((r) => r.textContent.includes(company)) || null;
  const openedToApply = () => {
    try { return JSON.parse(D.appStorage.getItem("internshiphunt.openedToApply")) || {}; } catch { return {}; }
  };

  // ---------------------------------------------------------------------------
  // Copy for the setup chapter
  // ---------------------------------------------------------------------------
  const code = (text) =>
    `<span class="coach-code"><code>${esc(text)}</code><button type="button" class="coach-copy" data-copy="${esc(text)}">Copy</button></span>`;
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

  // ---------------------------------------------------------------------------
  // The lessons
  // ---------------------------------------------------------------------------
  const CHAPTERS = [
    { id: "welcome", title: "Welcome" },
    { id: "setup", title: "Set it up" },
    { id: "tour", title: "Find your way around" },
    { id: "triage", title: "Sort new postings" },
    { id: "apply", title: "Log an application" },
    { id: "email", title: "Let your email do the work" },
    { id: "followup", title: "Deadlines and follow-ups" },
    { id: "research", title: "Searches, reports, and the log" },
    { id: "finish", title: "Your weekly routine" },
  ];

  const STEPS = [
    // ----- Welcome -----
    {
      ch: "welcome",
      title: "Learn InternshipHunt in about 10 minutes",
      body: `
        <p>This is a practice copy of the tracker. It runs the real app's screens, filled with a made-up student named Alex who is hunting for Summer 2027 internships in data, software, and finance.</p>
        <p>Click anything you like. Nothing here touches a real tracker, reads any email, or applies anywhere, and starting over puts everything back.</p>
        <p>This panel is your coach. It gives you one small task at a time, checks it off when you do it, and moves on.</p>`,
      welcome: true,
    },

    // ----- Set it up -----
    {
      ch: "setup",
      title: "How it works",
      body: `
        <p>InternshipHunt has two halves that share one folder on your Mac:</p>
        <ul>
          <li><b>The tracker</b>, the page you see here. A small app on your own Mac that keeps every posting, status, and note. Your data never leaves your computer.</li>
          <li><b>The weekly search.</b> Once a week, Claude runs on your Mac. It searches job boards and the career pages of the companies you care about most, opens every link to make sure the job is real, reads your job email for applications and invites, and drops what it found into the tracker.</li>
        </ul>
        <p>The search does the digging. You review and click.</p>`,
    },
    {
      ch: "setup",
      title: "What you need",
      body: `
        <ul>
          <li>A Mac.</li>
          <li>A paid Claude plan (Pro or Max) and the ${link("https://claude.ai/download", "Claude desktop app")}.</li>
          <li>Node.js, which is free: download the LTS installer from ${link("https://nodejs.org", "nodejs.org")} and click through it.</li>
          <li>The Gmail account you apply to jobs from.</li>
          <li>About 20 minutes.</li>
        </ul>`,
    },
    {
      ch: "setup",
      title: "Get the folder",
      body: `
        <p><b>Option A, with Terminal.</b> Open Terminal (Applications, then Utilities) and paste:</p>
        ${code(`git clone ${REPO}.git ~/InternshipHunt`)}
        <p><b>Option B, no Terminal.</b> On the ${link(REPO, "project's GitHub page")}, click the green <b>Code</b> button, then <b>Download ZIP</b>. Unzip it, rename the folder from <code>InternshipHunt-main</code> to <code>InternshipHunt</code>, and drag it into your home folder (in Finder: Go, then Home).</p>
        <p>Either way, the folder has to end up at <code>/Users/your-name/InternshipHunt</code>.</p>`,
    },
    {
      ch: "setup",
      title: "Let Claude set you up",
      body: `
        <p>Open the Claude desktop app, go to the <b>Code</b> tab, choose the <code>InternshipHunt</code> folder, and send:</p>
        ${code("Read START-HERE.md and set me up.")}
        <p>Claude interviews you a few questions at a time:</p>
        <ul>
          <li>your school, major, year, and graduation date</li>
          <li>the kinds of roles you want, and the ones you do not</li>
          <li>your top cities and the states that would also work</li>
          <li>the 5 to 20 companies you want most (your starred firms)</li>
          <li>the email addresses you apply from</li>
        </ul>
        <p>Then it installs everything and opens your tracker. Your tracker stays empty until the first search runs, which is exactly why this practice copy exists.</p>`,
    },
    {
      ch: "setup",
      title: "Turn on email and the weekly search",
      body: `
        <p>Two switches finish the job. Claude walks you through both.</p>
        <ol>
          <li><b>Gmail.</b> In the Claude app's settings, open Connectors and connect Gmail with the account that gets your job email. You sign in yourself; Claude never sees your password.</li>
          <li><b>The weekly search.</b> A scheduled task in the Claude app. Two settings matter most: it has to <b>run on this computer</b> (not in the cloud), and the <code>InternshipHunt</code> folder has to be attached.</li>
        </ol>
        <p>Pick an evening when your Mac is usually on and plugged in. A sleeping Mac misses the run.</p>
        <p>Next, you will practice on Alex's tracker.</p>`,
    },

    // ----- Find your way around -----
    {
      ch: "tour",
      tab: "postings",
      title: "The top bar",
      target: () => q("#header"),
      body: `
        <p>The top bar sums up the search at a glance:</p>
        <ul>
          <li><b>Last delivery</b>: when the weekly search last dropped off results. If it ever says <i>No delivery in 8 days</i>, a run was missed (usually the Mac was asleep).</li>
          <li><b>Suggestions</b>: things the search found in your email that wait for your OK.</li>
          <li><b>Unapplied</b>: postings you are considering but have not applied to.</li>
          <li><b>This week</b>: applications logged in the last 7 days.</li>
          <li><b>Errors</b>: a delivery that failed to load. Normally 0.</li>
        </ul>`,
    },
    {
      ch: "tour",
      tab: "postings",
      title: "Three tabs",
      target: () => q("#tabs"),
      body: `
        <p><b>Postings</b> is where you will spend your time. <b>Reports</b> holds the weekly search's write-up. <b>Log</b> records everything that happened.</p>
        <p>You will visit all three before the end.</p>`,
    },
    {
      ch: "tour",
      tab: "postings",
      title: "Postings, in groups",
      target: () => q("#groups"),
      body: `
        <p>Postings are grouped by where they stand:</p>
        <ul>
          <li><b>In progress</b>: you applied and it is still alive (applied, online assessment, interview, offer).</li>
          <li><b>Interested</b>: your shortlist.</li>
          <li><b>New</b>: fresh finds waiting for you to sort them.</li>
          <li><b>Archived</b>: rejected, withdrawn, and closed.</li>
        </ul>
        <p>Click a group's name to fold it away when you do not need it.</p>`,
    },
    {
      ch: "tour",
      tab: "postings",
      title: "Reading a row",
      target: () => rowFor("Northwind Analytics") || q("#groups .row"),
      body: `
        <p>Each row shows the company, the role, and a few tags:</p>
        <ul>
          <li>the <b>category</b>, from the list Claude made with you</li>
          <li>the <b>region rank</b>: <i>1 top choice</i> is one of your top cities, <i>2 good fit</i> is a state you like or remote, <i>3</i> is anywhere else</li>
          <li>the city, and where the search found it</li>
        </ul>
        <p>The right column is the deadline. It turns orange inside two weeks and red once it passes; <i>rolling</i> means no stated deadline. The default sort shows your best regions first, then the soonest deadlines.</p>`,
    },

    // ----- Sort new postings -----
    {
      ch: "triage",
      tab: "postings",
      title: "Open a posting",
      target: () => rowFor("Northwind Analytics"),
      body: `<p>Every week the search adds new postings to the <b>New</b> group. Sorting one takes seconds: open it, decide, move on.</p>`,
      task: "Click the Northwind Analytics row.",
      done: () => detailFor("Northwind Analytics") || posting("Northwind Analytics")?.status !== "new",
    },
    {
      ch: "triage",
      title: "Put it on your shortlist",
      target: () => (detailFor("Northwind Analytics") ? button(q("#detail-actions"), "Interested") : rowFor("Northwind Analytics")),
      body: `
        <p>This panel holds everything the search learned: the link, the deadline, where it was found, and its notes. In your real tracker, <b>Open posting</b> takes you to the company's page.</p>
        <p>Alex likes this one: it is in Chicago, a top city, and asks for SQL and Python.</p>`,
      task: "Press Interested.",
      done: () => posting("Northwind Analytics")?.status === "interested",
    },
    {
      ch: "triage",
      tab: "postings",
      title: "Nothing jumps around",
      target: () => rowFor("Northwind Analytics"),
      body: `
        <p>See how the row stayed where it was, faded, with an <b>Undo</b> button? Rows you just sorted hold still for a few minutes so the list never shuffles under your mouse while you work through it.</p>
        <p>Once things settle, Northwind moves up into <b>Interested</b>.</p>`,
    },
    {
      ch: "triage",
      tab: "postings",
      title: "Hide what you do not want",
      target: () => (detailFor("Pioneer Aerospace") ? button(q("#detail-actions"), "Hide") : rowFor("Pioneer Aerospace")),
      body: `
        <p>Pioneer Aerospace is in Denver, which is not on Alex's list. Hide it.</p>
        <p>Hidden is not deleted. The posting stays on file so the search never suggests it again, and the <b>Show hidden</b> box brings it back any time.</p>`,
      task: "Open Pioneer Aerospace and press Hide.",
      done: () => !!posting("Pioneer Aerospace")?.hidden,
    },
    {
      ch: "triage",
      tab: "postings",
      title: "Search and filters",
      target: () => q("#f-search"),
      body: `
        <p>With dozens of postings, the search box earns its keep. It matches company, role, city, notes, and more, and every word you type has to match, so <i>remote software</i> narrows further than <i>remote</i>.</p>
        <p>Press the <b>/</b> key from anywhere to jump to it. The menus beside it filter by category, status, region, and source, and change the sort order.</p>`,
      task: "Type remote into the search box.",
      done: () => (q("#f-search")?.value || "").toLowerCase().includes("remote"),
      // Stay put so the filtered list can be seen; Next clears the search.
      stay: true,
      leave: () => clearSearch(),
    },

    // ----- Log an application -----
    {
      ch: "apply",
      tab: "postings",
      title: "Open the posting to apply",
      target: () => (detailFor("Summit Capital") ? q("#detail-open-posting") : rowFor("Summit Capital")),
      body: `
        <p>Summit Capital is on Alex's shortlist and closes in 5 days. Time to apply.</p>
        <p>The practice copy keeps you on this page instead of opening a real one.</p>`,
      task: "Open Summit Capital, then press Open posting.",
      done: () => {
        const p = posting("Summit Capital");
        return !!p && (!!openedToApply()[p.key] || p.status === "applied");
      },
    },
    {
      ch: "apply",
      title: "Did you finish applying?",
      target: () => {
        if (modalOpen()) return q("#ap-save");
        if (detailOpen()) return q("#detail-close");
        const row = stripRow("#upcoming", ".up-row", "Summit Capital");
        return q("[data-mark-applied]", row) || rowFor("Summit Capital");
      },
      body: `
        <p>The tracker noticed you opened the posting. Close the panel (the <b>Close</b> button or the Esc key) and look at <b>Coming up</b> near the top: it asks whether you finished, so a half-done application never slips through.</p>
        <p>Press <b>Mark applied</b>, look over the form, and press <b>Save</b>. The portal email and portal note fields help future you remember which login that company's site used.</p>`,
      task: "Mark Summit Capital as applied and press Save.",
      done: () => posting("Summit Capital")?.status === "applied",
    },
    {
      ch: "apply",
      tab: "postings",
      title: "Now it is in progress",
      target: () => rowFor("Summit Capital"),
      body: `
        <p>Summit Capital moved to <b>In progress</b> with an <i>applied</i> tag. From now on its panel shows stage buttons: <b>Got assessment</b>, <b>Got interview</b>, <b>Rejected</b>. One click moves it along.</p>
        <p>You will rarely need them, though. The weekly search reads your email and suggests those changes for you. That is the next chapter.</p>`,
    },

    // ----- Let your email do the work -----
    {
      ch: "email",
      tab: "postings",
      title: "Action required",
      target: () => {
        const row = stripRow("#action-required", ".action-row", "Bluebird Bank");
        return q("[data-confirm-action]", row) || row || q("#action-required");
      },
      body: `
        <p>The most important list on the page. The weekly search read an email from Bluebird Bank asking Alex to finish an online assessment by a deadline, and put it here with a countdown.</p>
        <p>Two promises: the tracker never opens assessment links (you do that yourself), and the employer's email always has the final word on the deadline.</p>`,
      task: "Press Set to online assessment.",
      done: () => posting("Bluebird Bank")?.status === "oa",
    },
    {
      ch: "email",
      tab: "postings",
      title: "Finished it? Say so",
      target: () => {
        const row = stripRow("#action-required", ".action-row", "Bluebird Bank");
        return q("[data-action-done]", row) || row;
      },
      body: `
        <p>Pretend Alex just finished the assessment. Press <b>I did this</b>.</p>
        <p>The row leaves the list, and the posting stays at <i>online assessment</i>, because finishing a test says nothing about what the employer decides. Clicked the wrong one? The message at the bottom offers <b>Undo</b> for a few seconds.</p>`,
      task: "Press I did this.",
      done: () => { const p = posting("Bluebird Bank"); return !!p && D.store.actionDone.has(p.key); },
    },
    {
      ch: "email",
      tab: "postings",
      title: "Moving forward",
      target: () => {
        const row = stripRow("#next-round", ".nr-row", "Lumen Robotics");
        return q("[data-nr-confirm]", row) || row || q("#next-round");
      },
      body: `
        <p>Good news gets its own strip. Lumen Robotics emailed Alex an interview invitation.</p>
        <p>If the search ever misreads an email, <b>Dismiss</b> throws the suggestion away and changes nothing.</p>`,
      task: "Press Set to interview.",
      done: () => posting("Lumen Robotics")?.status === "interview",
    },
    {
      ch: "email",
      tab: "postings",
      title: "Needs attention",
      target: () => {
        const row = stripRow("#attention", ".suggestion", "Atlas Freight");
        return q("[data-confirm]", row) || row || q("#attention");
      },
      body: `
        <p>Everything else the search noticed waits here for your OK. Alex applied to Atlas Freight and forgot to mark it, so the search found the confirmation email.</p>
        <p>Below it, the search thinks Kestrel Energy closed. <b>Confirm</b> would archive it; <b>Dismiss</b> keeps it. Either way the rule is the same: the search suggests, you decide.</p>`,
      task: "Press Confirm on the Atlas Freight suggestion.",
      done: () => posting("Atlas Freight")?.status === "applied",
    },
    {
      ch: "email",
      tab: "postings",
      title: "Heard it some other way?",
      target: () => q("#add-action"),
      body: `
        <p>The search only reads email. If a recruiter calls or texts you about a next step, press <b>+ Add action required</b> and put it on the list yourself. It behaves exactly like the ones from email, deadline countdown included.</p>
        <p>Next to it, <b>+ Add posting</b> tracks a job you found on your own.</p>`,
    },

    // ----- Deadlines and follow-ups -----
    {
      ch: "followup",
      tab: "postings",
      title: "Coming up",
      target: () => q("#upcoming"),
      body: `
        <p><b>Coming up</b> collects the things that quietly slip:</p>
        <ul>
          <li>deadlines inside two weeks on postings you have not applied to yet</li>
          <li>follow-up reminders you set</li>
          <li>postings you opened but never marked as applied</li>
        </ul>
        <p><b>Remove</b> clears a row without changing the posting.</p>`,
    },
    {
      ch: "followup",
      tab: "postings",
      title: "Set the next reminder",
      target: () => {
        if (detailFor("Harbor Health")) {
          const input = q("#d-next_followup");
          return input && input.value > D.today ? q("#d-save") : input;
        }
        const row = stripRow("#upcoming", ".up-row", "Harbor Health");
        return q("a", row) || rowFor("Harbor Health");
      },
      body: `
        <p>Harbor Health is due for a follow-up today. Pretend Alex sent the email: open Harbor Health, choose a date about a week out under <b>Next follow-up</b>, and press <b>Save</b>.</p>
        <p>The reminder comes back on that date. The same panel keeps a contact or referral and your own notes, like the ones Alex left here.</p>`,
      task: "Pick a new Next follow-up date for Harbor Health and press Save.",
      done: () => (posting("Harbor Health")?.next_followup || "") > D.today,
    },

    // ----- Searches, reports, and the log -----
    {
      ch: "research",
      tab: "postings",
      title: "Search on demand",
      target: () => (D.store.research.running ? q("#scans-panel") : q("#find-more")),
      body: `
        <p>The weekly search does all of this by itself, but you can ask for more any time from <b>Research and scans</b>:</p>
        <ul>
          <li><b>Find more opportunities</b> runs an extra search right now. It uses your Claude plan and needs Claude's command line tool, which setup installs.</li>
          <li><b>Rescan email for applications</b> opens Claude with an email-only scan ready to send.</li>
        </ul>
        <p>Try the practice run. It takes about 10 seconds here; a real one takes longer.</p>`,
      task: "Press Find more opportunities and watch it work.",
      done: () => !!posting("Quarry Labs"),
    },
    {
      ch: "research",
      title: "The weekly report",
      target: () => (activeTab() === "reports" ? q("#reports-list .doc") : q('.tab[data-tab="reports"]')),
      body: `
        <p>The extra run just added two postings to <b>New</b>. After every run, the search also writes a short report: top picks, which starred companies it checked, what it found in your email, and what new places it tried.</p>`,
      task: "Open the Reports tab.",
      done: () => activeTab() === "reports",
    },
    {
      ch: "research",
      title: "The log",
      target: () => (activeTab() === "log" ? q("#log-list") : q('.tab[data-tab="log"]')),
      body: `
        <p>The <b>Log</b> lists every change, who made it (you, a confirm click, or the search), and every delivery. If a delivery ever fails to load, it shows up here with a <b>Retry</b> button.</p>
        <p>Everything you clicked in this tutorial is in there.</p>`,
      task: "Open the Log tab.",
      done: () => activeTab() === "log",
    },

    // ----- Your weekly routine -----
    {
      ch: "finish",
      title: "You are ready",
      body: `
        <p>That is the whole tracker. A good week looks like this:</p>
        <ol>
          <li>After the weekly search runs, open your tracker at <code>http://localhost:4321</code> (bookmark it).</li>
          <li>Clear <b>Action required</b> first. Those have deadlines.</li>
          <li>Confirm or dismiss the suggestions.</li>
          <li>Sort the <b>New</b> pile: Interested or Hide.</li>
          <li>Apply to your shortlist, and mark each one applied as you go.</li>
        </ol>
        <p>To change anything (cities, categories, starred companies, the weekly time), open the <code>InternshipHunt</code> folder in Claude's Code tab and just ask. In Terminal, <code>~/InternshipHunt/bin/ih help</code> lists the app's controls.</p>
        <p>Your profile, settings, and tracker data stay on your Mac. They are never part of the shared project.</p>`,
      finish: true,
    },
  ];

  // ---------------------------------------------------------------------------
  // Progress (kept in the browser's real storage, separate from the app's)
  // ---------------------------------------------------------------------------
  function loadProgress() {
    try { return JSON.parse(D.realStorage.getItem(PROGRESS_KEY)) || { done: [], last: null }; } catch { return { done: [], last: null }; }
  }
  function saveProgress(p) {
    try { D.realStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode: progress just is not remembered */ }
  }
  let progress = loadProgress();

  // ---------------------------------------------------------------------------
  // The coach panel
  // ---------------------------------------------------------------------------
  const el = {
    coach: q("#coach"),
    chapter: q("#coach-chapter"),
    title: q("#coach-title"),
    body: q("#coach-body"),
    task: q("#coach-task"),
    extra: q("#coach-extra"),
    back: q("#coach-back"),
    next: q("#coach-next"),
    bar: q("#coach-bar"),
    toc: q("#coach-toc"),
    ring: q("#coach-ring"),
    mini: q("#coach-mini-task"),
    status: q("#coach-status"),
  };

  let idx = 0;
  let taskDone = false;
  let doneOnEntry = false;
  let advanceTimer = null;
  let lastTarget = null;

  const chapterOf = (i) => CHAPTERS.find((c) => c.id === STEPS[i].ch);
  const chapterNumber = (id) => CHAPTERS.findIndex((c) => c.id === id); // welcome is 0
  const firstStepOf = (id) => STEPS.findIndex((s) => s.ch === id);

  function safe(fn) {
    try { return fn(); } catch { return null; }
  }

  function goTo(i) {
    const prev = STEPS[idx];
    if (prev && prev.leave && i !== idx) safe(prev.leave);
    // Leaving a chapter forward counts it as done.
    if (prev && STEPS[i] && STEPS[i].ch !== prev.ch && i > idx && prev.ch !== "welcome") {
      if (!progress.done.includes(prev.ch)) progress.done.push(prev.ch);
    }
    idx = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[idx];
    if (s.ch !== "welcome") progress.last = s.ch;
    saveProgress(progress);
    clearTimeout(advanceTimer);
    if (s.tab && activeTab() !== s.tab) q(`.tab[data-tab="${s.tab}"]`)?.click();
    taskDone = s.done ? !!safe(s.done) : false;
    doneOnEntry = taskDone;
    lastTarget = null;
    render();
    el.coach.scrollTop = 0;
    // Let the app redraw first, then bring the step's target into view.
    setTimeout(bringIntoView, 120);
  }

  function goChapter(id) {
    goTo(firstStepOf(id));
  }

  function render() {
    const s = STEPS[idx];
    const ch = chapterOf(idx);
    const n = chapterNumber(ch.id);
    el.chapter.textContent = ch.id === "welcome" ? "Practice copy" : `Chapter ${n} of ${CHAPTERS.length - 1}: ${ch.title}`;
    el.title.textContent = s.title;
    el.body.innerHTML = s.body;
    el.bar.style.width = `${Math.round((idx / (STEPS.length - 1)) * 100)}%`;
    renderTask();
    renderExtra(s);
    el.back.disabled = idx === 0;
    el.back.classList.toggle("hidden", !!s.welcome);
    el.next.classList.toggle("hidden", !!s.welcome || !!s.finish);
    renderToc();
    wireCopy(el.body);
  }

  function renderTask() {
    const s = STEPS[idx];
    if (!s.task) {
      el.task.className = "coach-task hidden";
      el.task.innerHTML = "";
      el.mini.textContent = s.title;
      el.next.textContent = "Next";
      el.next.className = "coach-btn primary";
      return;
    }
    el.task.className = "coach-task" + (taskDone ? " done" : "");
    const note = taskDone ? (doneOnEntry ? "Already done." : "Done.") : "Your turn";
    el.task.innerHTML = `<span class="coach-check" aria-hidden="true"></span><span><span class="coach-task-label">${esc(note)}</span>${esc(s.task)}</span>`;
    el.mini.textContent = taskDone ? `Done: ${s.task}` : s.task;
    el.next.textContent = taskDone ? "Next" : "Skip";
    el.next.className = "coach-btn " + (taskDone ? "primary" : "quiet");
  }

  function renderExtra(s) {
    el.extra.innerHTML = "";
    const add = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `coach-btn ${cls}`;
      b.textContent = label;
      b.onclick = fn;
      el.extra.appendChild(b);
    };
    if (s.welcome) {
      const resume = progress.last && !["welcome", "finish"].includes(progress.last) ? CHAPTERS.find((c) => c.id === progress.last) : null;
      if (isLocalApp) {
        add("Teach me the tracker", "primary", () => goChapter("tour"));
        add("Show me the setup steps too", "", () => goChapter("setup"));
      } else {
        add("Start from the beginning", "primary", () => goChapter("setup"));
        add("Skip setup, teach me the tracker", "", () => goChapter("tour"));
      }
      if (resume) add(`Pick up at: ${resume.title}`, "quiet", () => goChapter(resume.id));
    }
    if (s.finish) {
      if (!progress.done.includes("finish")) { progress.done.push("finish"); saveProgress(progress); }
      add("Start over with fresh data", "primary", () => restart("welcome"));
      add("Back to the setup steps", "", () => goChapter("setup"));
      if (!isLocalApp) {
        const a = document.createElement("a");
        a.className = "coach-btn";
        a.href = REPO;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Open the project on GitHub";
        el.extra.appendChild(a);
      }
    }
  }

  function renderToc() {
    el.toc.innerHTML = "";
    const current = STEPS[idx].ch;
    for (const c of CHAPTERS) {
      if (c.id === "welcome") continue;
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const isDone = progress.done.includes(c.id);
      b.className = "coach-toc-item" + (c.id === current ? " current" : "") + (isDone ? " done" : "");
      b.innerHTML = `<span class="coach-toc-mark" aria-hidden="true">${isDone ? "&#10003;" : chapterNumber(c.id)}</span>${esc(c.title)}`;
      if (isDone) b.setAttribute("aria-label", `${c.title} (done)`);
      b.onclick = () => goChapter(c.id);
      li.appendChild(b);
      el.toc.appendChild(li);
    }
  }

  function wireCopy(root) {
    qa(".coach-copy", root).forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Select and copy";
        }
        setTimeout(() => { b.textContent = "Copy"; }, 1600);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Checking tasks off
  // ---------------------------------------------------------------------------
  function check() {
    const s = STEPS[idx];
    if (!s.done) return;
    const now = !!safe(s.done);
    if (now === taskDone) return;
    taskDone = now;
    renderTask();
    if (now && !doneOnEntry && !s.stay) {
      announce(`Done: ${s.task}`);
      el.coach.classList.remove("flash");
      void el.coach.offsetWidth;
      el.coach.classList.add("flash");
      clearTimeout(advanceTimer);
      const at = idx;
      advanceTimer = setTimeout(() => { if (idx === at) goTo(idx + 1); }, 1200);
    }
  }

  function announce(text) {
    el.status.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // The highlight ring, following its target as the page scrolls and redraws
  // ---------------------------------------------------------------------------
  function currentTarget() {
    const s = STEPS[idx];
    if (!s.target) return null;
    const t = safe(s.target);
    return shown(t) ? t : null;
  }

  function placeRing() {
    const t = currentTarget();
    if (!t) {
      el.ring.hidden = true;
    } else {
      // Pad the target a little, but keep the ring on screen so a target
      // touching the window edge (the top bar) still shows all four sides.
      const r = t.getBoundingClientRect();
      const b = document.body.classList;
      const minLeft = b.contains("coach-docked") && !b.contains("coach-min") ? el.coach.getBoundingClientRect().right + 2 : 2;
      const left = Math.max(minLeft, r.left - 6);
      const top = Math.max(2, r.top - 6);
      const right = Math.min(window.innerWidth - 2, r.right + 6);
      const bottom = Math.min(window.innerHeight - 2, r.bottom + 6);
      el.ring.hidden = false;
      el.ring.style.left = `${left}px`;
      el.ring.style.top = `${top}px`;
      el.ring.style.width = `${Math.max(0, right - left)}px`;
      el.ring.style.height = `${Math.max(0, bottom - top)}px`;
      if (t !== lastTarget) {
        lastTarget = t;
        bringIntoView();
      }
    }
    requestAnimationFrame(placeRing);
  }

  // Scroll the target into the part of the screen the coach does not cover.
  function bringIntoView() {
    const t = currentTarget();
    if (!t) return;
    const behavior = reduceMotion ? "auto" : "smooth";
    if (t.closest("#detail, #apply-modal")) {
      t.scrollIntoView({ block: "nearest", behavior });
      return;
    }
    const r = t.getBoundingClientRect();
    const topbar = q("#topbar");
    const top = topbar ? topbar.getBoundingClientRect().bottom + 12 : 12;
    const coachRect = el.coach.getBoundingClientRect();
    const sheet = document.body.classList.contains("coach-sheet") ? window.innerHeight - coachRect.top : 0;
    const bottom = window.innerHeight - sheet - 12;
    if (r.top >= top && r.bottom <= bottom) return;
    const room = bottom - top;
    const offset = r.height < room ? (room - r.height) / 3 : 0;
    window.scrollTo({ top: window.scrollY + r.top - top - offset, behavior });
  }

  // ---------------------------------------------------------------------------
  // Small helpers used by steps
  // ---------------------------------------------------------------------------
  function clearSearch() {
    const box = q("#f-search");
    if (box && box.value) {
      box.value = "";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function restart(chapterId) {
    try { sessionStorage.setItem(RESUME_KEY, chapterId); } catch { /* reload still resets the data */ }
    location.reload();
  }

  // Links out of the practice copy (posting pages, report links) stay put.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.closest("#coach")) return;
    if (!/^https?:/i.test(a.getAttribute("href") || "")) return;
    e.preventDefault();
    if (typeof window.showToast === "function") {
      window.showToast("Practice copy: in your real tracker this opens the job posting in a new tab.", "info");
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Layout: a sidebar on wide screens, a bottom sheet on narrow ones, and a
  // minimize button for both.
  // ---------------------------------------------------------------------------
  const narrow = window.matchMedia("(max-width: 899px)");
  function applyLayout() {
    document.body.classList.toggle("coach-sheet", narrow.matches);
    document.body.classList.toggle("coach-docked", !narrow.matches);
  }
  narrow.addEventListener ? narrow.addEventListener("change", applyLayout) : narrow.addListener(applyLayout);
  applyLayout();

  q("#coach-min").onclick = () => document.body.classList.add("coach-min");
  q("#coach-restore").onclick = () => document.body.classList.remove("coach-min");
  q("#coach-reset").onclick = () => {
    if (confirm("Start over with fresh practice data? You stay in the same chapter.")) restart(STEPS[idx].ch);
  };
  el.back.onclick = () => goTo(idx - 1);
  el.next.onclick = () => goTo(idx + 1);

  // ---------------------------------------------------------------------------
  // Boot: borrow the real app's page and script, then start the coach.
  // ---------------------------------------------------------------------------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.body.appendChild(s);
    });
  }

  function fail(message) {
    el.chapter.textContent = "Practice copy";
    el.title.textContent = "The tutorial could not start";
    el.body.innerHTML = message;
    el.task.className = "coach-task hidden";
    el.back.classList.add("hidden");
    el.next.classList.add("hidden");
  }

  async function boot() {
    if (location.protocol === "file:") {
      fail(`<p>This page needs to be opened from a web address, not straight from a file.</p>
        <p>Use the online tutorial linked from the ${link(REPO, "project page")}, or, once InternshipHunt is installed, open <code>http://localhost:4321/tutorial/</code>.</p>`);
      return;
    }
    try {
      const res = await fetch("../index.html", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      doc.querySelectorAll("script").forEach((s) => s.remove());
      const root = q("#app-root");
      for (const node of [...doc.body.childNodes]) root.appendChild(document.importNode(node, true));
      await loadScript("../app.js");
    } catch (e) {
      fail(`<p>Something went wrong loading the practice tracker (${esc(e.message)}). Reload the page to try again.</p>`);
      return;
    }

    window.addEventListener("demo:change", () => setTimeout(check, 80));
    setInterval(check, 250);
    requestAnimationFrame(placeRing);

    let start = 0;
    try {
      const resume = sessionStorage.getItem(RESUME_KEY);
      if (resume) {
        sessionStorage.removeItem(RESUME_KEY);
        if (firstStepOf(resume) >= 0) start = firstStepOf(resume);
      }
    } catch { /* start at the welcome */ }
    goTo(start);
  }

  boot();
})();
