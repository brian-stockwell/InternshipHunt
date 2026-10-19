# Source Registry

Each entry: name, type, how to query, status (core / experimental / retired), added date, last-run yield notes. Promote experimental producers to core; two consecutive zero-yield runs moves a source to retired (kept listed so it is not re-suggested). Update this file every run.

This is a starter list. During setup (START-HERE.md), Claude adds the trackers, job boards, and employer career pages that fit the user's field, and fills in the keyword pool below from profile/profile.md. Replace `<term>` with the target season from profile.md (for example `summer 2027`) and `<year>` with its year.

## ATS-direct free endpoints (no login)

### greenhouse-api
- Type: ATS API. Status: core.
- Query: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`. Filter titles for intern / `<year>`.
- Verified tokens: (none yet; add each company's board token as you find it)
- Yield notes: (none yet)

### lever-api
- Type: ATS API. Status: core.
- Query: `GET https://api.lever.co/v0/postings/{company}?mode=json`.
- Yield notes: (none yet)

### ashby-api
- Type: ATS API. Status: core.
- Query: `GET https://api.ashbyhq.com/posting-api/job-board/{org}`.
- Yield notes: (none yet)

### smartrecruiters-api
- Type: ATS API. Status: core.
- Query: `GET https://api.smartrecruiters.com/v1/companies/{company}/postings?keyword=intern`.
- Yield notes: (none yet)

### workday-cxs
- Type: ATS API. Status: core.
- Query: `POST https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"<keywords>"}`. Max 20 per page; paginate politely; cross-check reported totals against what you actually got (silent truncation under aggressive pagination). Site slugs are not guessable: discover them from real posting URLs (dork results), then record them here.
- Verified tenants (site slug in parens): (none yet)
- Yield notes: (none yet). If the run environment blocks direct HTTP to myworkdayjobs.com, cover those companies via their own careers pages and dorks instead, and say so in source_health.

## Google dork templates (rotate keywords weekly; also harvests new Workday tenants from result URLs)

### dork-myworkdayjobs
- Type: search dork. Status: core.
- Query: `site:myworkdayjobs.com "<year>" intern <keyword>`
- Yield notes: (none yet)

### dork-greenhouse
- Type: search dork. Status: core.
- Query: `site:boards.greenhouse.io "<year>" intern <keyword>` and `site:job-boards.greenhouse.io "<year>" intern <keyword>`
- Yield notes: (none yet)

### dork-lever
- Type: search dork. Status: core.
- Query: `site:lever.co "<year>" intern <keyword>`
- Yield notes: (none yet)

### dork-icims
- Type: search dork. Status: core.
- Query: `site:icims.com "<term>" intern <keyword>`
- Yield notes: (none yet)

Keyword rotation pool: (filled in at setup from the role types and top-choice cities in profile/profile.md and profile/preferences.json)

## Trackers and lists (check weekly, cheap)

### simplifyjobs-github
- Type: GitHub tracker. Status: core.
- Query: github.com/SimplifyJobs (find the current Summer `<year>` internships repo; parse the raw README, the sections matching the user's categories).
- Yield notes: (none yet)

### simplify-toplists
- Type: curated tracker. Status: experimental.
- Query: simplify.jobs top lists for the user's field (company-level open/closed status at a glance).
- Yield notes: (none yet)

(Setup adds field-specific trackers here: recruiting-calendar sites, GitHub repos, and job boards that specialize in the user's field.)

## Email-borne (via the Gmail pass; never scrape LinkedIn or Handshake)

### linkedin-alert-email
- Type: email alerts. Status: set at setup (core if the user has LinkedIn job alerts going to one of their email addresses, otherwise retired). Never scrape LinkedIn as a substitute.
- Query: Gmail search for LinkedIn job alert emails from the past week; verify postings at the employer ATS source.
- Yield notes: (none yet)

### handshake-alert-email
- Type: email alerts. Status: set at setup (core if the user gets Handshake alert emails, otherwise retired). Never scrape Handshake as a substitute.
- Query: Gmail search for Handshake job alert emails from the past week; verify postings at the employer source.
- Yield notes: (none yet)

### talent-community-email
- Type: email alerts. Status: dormant (activates automatically if firm talent-community emails start arriving).
- Query: Gmail search for firm talent-community notifications.
- Yield notes: (none yet)

## Experimental slot rules

Per run: 2 new experiments PLUS 1 recheck of a retired source (rotate oldest-recheck-first; record a last-rechecked date on each retired entry). Two consecutive zeros = retired, which means resting in the recheck rotation, not gone; a producing recheck revives the source. Monthly, at least one of the 2 new experiments must be a brand-new channel TYPE; if no genuinely new angle exists that week, say so in the report and recheck a second retired source instead. Channels the user explicitly declined are excluded from the recheck rotation until they say otherwise. Ideas bank to draw from over time: WayUp, RippleMatch, Google Jobs alerts, iCIMS sitemap sweeps, professional association job boards in the user's field, the user's school career center, career-fair employer lists.

## Experiment log

(append one line per experiment or recheck: date, name, what was tried, yield)
