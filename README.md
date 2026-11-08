# planner-e2e-showcase

Playwright end-to-end tests for a small trip-planner web app, run in Chromium, Firefox and WebKit.

The app in `demo/` is a stand-in written for this repository. It has the same three views as a personal trip planner I
built for a family trip (Today, Full plan, List). That planner is not published because its data is personal. The trip
here is invented: Example Island, 28 October to 13 November 2030, with placeholder travellers.

## What is tested

| Area | Tests |
|---|---|
| Loading | The title names the trip. A failed fixture load (HTTP 500) shows an error message instead of an empty page. The app makes no requests outside the local demo server. A trip file full of markup shows as literal text in every view, and its script never runs. |
| Today view | Eight frozen clock instants give the expected heading: before the trip, the day before ("1 day", singular), first day, both sides of the clock change, the last minute of the trip, and after it. One more test checks that day's items. |
| Full plan view | All 17 days are listed. Each day has the expected weekday and date (17 generated tests). No date repeats or is skipped. A day opens and closes. |
| List view | Every checklist item is shown, unticked at first. A ticked item stays ticked after a reload, and the other items stay unticked. |
| Demo server | A request with malformed percent-encoding or a null byte gets 400, and the server keeps serving. An encoded `../` gets 403 and no file contents, and so does a sibling folder whose name starts with `demo` (`demo-private`). A symlink inside `demo/` that leads outside it, as a file or as a directory, gets 403. Methods other than GET and HEAD get 405, and served files carry `X-Content-Type-Options: nosniff`. No hostile path resolves to a file outside `demo/`. |

39 tests per browser, plus 15 server tests that need no browser and run once: 132 in all.

## How the tests are built

- **The clock is frozen.** Each test sets the browser clock (`page.clock.setFixedTime`) before the app loads, so the
  result does not depend on the day the suite runs. The browser runs in a fixed time zone (`America/Los_Angeles`) and
  locale (`en-US`), set in `playwright.config.ts`.
- **The trip crosses a daylight-saving change.** US daylight saving time ends on Sunday 3 November 2030 (Day 7), so that
  day is 25 hours long. Code that adds 24 hours per day instead of stepping the calendar shows a wrong date from Day 8 on.
  The clock instants in the tests carry explicit UTC offsets on both sides of the change.
- **Expected values do not come from the app.** Expected dates are computed in the test process, in UTC, from the
  fixture's start date. Four anchors (Day 1, 7, 8, 17) are hardcoded from an external calendar, so a bug in that helper
  cannot hide a bug in the app.
- **One fixture, two readers.** The app loads `demo/trip.json` over HTTP, and the tests read the same file. A change to
  the trip changes the expectations with it. A separate check pins the fixture at 17 days, so a trip shortened by
  mistake fails.
- **Hermetic.** Playwright starts a small static server (`scripts/serve-demo.js`, no dependencies) and stops it after
  the run. A test records every request and fails on any request that leaves that server.

## Checked against broken versions of the code

`npm run mutants` (`scripts/mutants.js`) plants each bug below and runs the tests against it: app bugs in a copy of
`demo/index.html` with the Chromium suite, server bugs in a git-ignored copy of `scripts/serve-demo.js` with the server
tests (the tracked file is never written). Both suites first run on the unmutated code and must pass, so a broken
environment cannot count as a caught bug. It exits 1 if any bug gets through, and CI runs it on every push. Each bug is caught:

| Bug introduced | Tests that failed |
|---|---|
| Full plan steps 24 hours per day instead of one calendar day | 11 of 39: Day 8 to Day 17 labels, and "no date repeats or is skipped" |
| Today view takes the time elapsed since local midnight on Day 1, divides it by 24 hours and rounds down, instead of counting calendar days | 2 of 39: 23:30 on the 25-hour day, and the last minute of the trip |
| The ticked checklist item is not saved | 1 of 39: "a ticked item stays ticked after a reload" |
| Day items are written with `innerHTML` instead of as text | 1 of 39: "markup in the trip data is shown as text and never runs" |
| Server: malformed percent-encoding throws instead of returning 400 | 8 of 15 server tests (the crash also fails the tests that follow it) |
| Server: no null-byte check | 7 of 15 |
| Server: join + normalize instead of resolve, so a decoded `../` is clamped and the folder check never fires | 4 of 15 |
| Server: folder check without the path separator, so a sibling such as `demo-private` passes | 2 of 15 |
| Server: no check after following symlinks, so a link inside `demo/` that points outside it is served | 2 of 15 |
| Server: every HTTP method is served, not only GET and HEAD | 1 of 15 |
| Server: no `X-Content-Type-Options: nosniff` on served files | 1 of 15 |

## Security-relevant properties

- **Crafted input does not take the server down.** On 2026-11-08 two requests sent over a raw socket crashed the demo
  server: `/%E0%A4%A` (`decodeURIComponent` threw `URIError`) and `/a%00b` (the null byte made `fs.readFile` throw).
  After either one the server refused every later connection. Both now get 400. The tests send the same two requests
  over a raw socket, then check that the server still answers. `npm run mutants` undoes each part of the fix in turn,
  and each one is caught (table above).
- **No file outside `demo/` is served.** The old code joined and normalised the path, which quietly clamped a decoded
  `../` back to the demo folder, so its "outside the folder" check could never fire. The path is now resolved, an
  encoded `../` reaches the check and gets 403. A second test uses a sibling folder with the same name prefix
  (`demo-private`), which a check without the path separator would serve. Both expected statuses are written in the tests,
  not computed from the code under test. The path is checked again after following symlinks, so a link inside `demo/`
  that points outside it gets 403; tests make a file link and a directory link at run time and request them. The file is
  opened once and the check runs on the opened file, so swapping the path for a link after the check cannot change what
  is read. A round-3 red-team review leaked an outside file in 295 of 4000 requests with the old check-then-read code;
  the new code leaked 0 of 8000 on Linux. On Windows and macOS (no `/proc`) the check compares the opened file's
  identity with the real path's, which narrows the race but does not close it (22 of 4000 in a forced test).
- **No traffic leaves the machine.** A test records every request and every WebSocket connection the app opens, and
  fails on any that leaves the local server. Service workers are blocked, so none of their fetches go unrecorded.
- **Trip data is shown as text, never parsed as HTML.** The app builds the page with `createElement` and appends the
  strings, which the DOM inserts as text nodes. A test loads a trip file full of markup and an `onerror` script, opens every
  view, and checks that the markup shows as literal text and the script never runs.
- **The tests are tested.** `npm run mutants` plants known bugs and fails if the suite misses one (see above).
- **CI has least privilege.** The workflow token is read-only (`contents: read`), checkout keeps no credentials
  (`persist-credentials: false`), and every action is pinned to a commit.

## Run it locally

```
npm ci
npx playwright install
npm test
```

| Command | What it does |
|---|---|
| `npm run test:chromium` | Runs the suite in Chromium only |
| `npm run demo` | Serves the demo app at http://127.0.0.1:4173/ |
| `npm run report` | Opens the HTML report from the last run |
| `npm run mutants` | Runs the Chromium suite against each deliberately broken copy of the app |

GitHub Actions (`.github/workflows/playwright.yml`) runs the suite in all three browsers, then the mutants, on every push and pull
request to `main`, and saves the HTML report with each run. The actions are pinned by commit.
