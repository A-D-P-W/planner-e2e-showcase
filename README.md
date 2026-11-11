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
| Full plan view | One check covers the whole list: 17 days, in order, each with the expected weekday and date, so no date repeats or is skipped. A day opens and closes. |
| List view | Every checklist item is shown, unticked at first. A ticked item stays ticked after a reload, and the other items stay unticked. |
| Demo server | A request with malformed percent-encoding or a null byte gets 400, and the server keeps serving. `/..%2f` (an encoded slash after `..`) gets 403 and no file contents, and so does a sibling folder whose name starts with `demo` (`demo-private`). A symlink inside `demo/` that leads outside it, as a file or as a directory, gets 403. A hard link inside `demo/` to a file outside it gets 403, and a named pipe (FIFO) gets 404 without tying up the server. Eight more hostile paths (encoded, double-encoded, backslash, doubled-slash forms) each get a result written in the test. Methods other than GET and HEAD get 405, HEAD returns the size without reading the file, and served files carry `X-Content-Type-Options: nosniff` and the Content-Type of their extension. A file replaced right after the check is not what gets served, and a read shorter than the file's size gets 500 instead of a truncated 200. A missing file gets 404 (not 403), an fstat error after the open and a read error each get 404, and HEAD answers from fstat without reading the file. |

17 tests per browser, plus 36 tests that need no browser and run once (server tests, the fixture pin and the four calendar anchors): 87 in all (the FIFO test is skipped on Windows).

## How the tests are built

- **The clock is frozen.** Each test sets the browser clock (`page.clock.setFixedTime`) before the app loads, so the
  result does not depend on the day the suite runs. The browser runs in a fixed time zone (`America/Los_Angeles`) and
  locale (`en-US`), set in `playwright.config.ts`.
- **The trip crosses a daylight-saving change.** US daylight saving time ends on Sunday 3 November 2030 (Day 7), so that
  day is 25 hours long. Code that adds 24 hours per day instead of stepping the calendar shows a wrong date from Day 8 on.
  The clock instants in the tests carry explicit UTC offsets on both sides of the change.
- **Expected values do not come from the app.** Expected dates are computed in the test process, in UTC, from the
  fixture's start date. Four anchors (Day 1, 7, 8, 17) are hardcoded from an external calendar and checked once, without a
  browser, so a bug in that helper cannot hide a bug in the app.
- **One fixture, two readers.** The app loads `demo/trip.json` over HTTP, and the tests read the same file. A change to
  the trip changes the expectations with it. A separate check pins the fixture at 17 days, so a trip shortened by
  mistake fails.
- **Hermetic.** Playwright starts a small static server (`scripts/serve-demo.js`, no dependencies) and stops it after
  the run. A test records every request and fails on any request that leaves that server.

## Checked against broken versions of the code

`npm run mutants` (`scripts/mutants.js`) plants each bug below and runs the tests against it: app bugs in a copy of
`demo/index.html` with the Chromium suite, server bugs in a git-ignored copy of `scripts/serve-demo.js` with the server
tests (the tracked file is never written). Both suites first run on the unmutated code and must pass, so a broken
environment cannot count as a caught bug. It exits 1 if any bug gets through, and CI runs it on every push. Each bug is caught (counts from a Linux run):

| Bug introduced | Tests that failed |
|---|---|
| Full plan steps 24 hours per day instead of one calendar day | 1 of 17: the ordered day list |
| Full plan lists the days in reverse order | 1 of 17: the ordered day list |
| Today view takes the time elapsed since local midnight on Day 1, divides it by 24 hours and rounds down, instead of counting calendar days | 2 of 17: 23:30 on the 25-hour day, and the last minute of the trip |
| The ticked checklist item is not saved | 1 of 17: "a ticked item stays ticked after a reload" |
| Day items are written with `innerHTML` instead of as text | 1 of 17: "markup in the trip data is shown as text and never runs" |
| Server: malformed percent-encoding throws instead of returning 400 | 10 of 36 browserless tests (the crash also fails the tests that follow it) |
| Server: no null-byte check | 9 of 36 |
| Server: join + normalize instead of resolve, so a decoded `../` is clamped and the folder check never fires | 5 of 36 |
| Server: the path is percent-decoded twice, so `%252e%252e%252f` becomes `../` | 1 of 36 |
| Server: folder check without the path separator, so a sibling such as `demo-private` passes | 1 of 36 |
| Server: the containment check counts the demo folder itself as inside it | 1 of 36 |
| Server: the containment check counts the parent folder as inside | 1 of 36 |
| Server: the containment check counts `../<file>` as inside | 2 of 36 |
| Server: no check after following symlinks, so a link inside `demo/` that points outside it is served | 1 of 36 |
| Server: no link-count check, so a hard link inside `demo/` to an outside file is served | 1 of 36 |
| Server: the file is read again by path, not from the descriptor that was checked | 3 of 36 |
| Server: a short read is served as a truncated 200, not a 500 | 1 of 36 |
| Server: blocking open, so a FIFO inside `demo/` holds a thread until a writer appears (Linux and macOS only) | 1 of 36 |
| Server: every HTTP method is served, not only GET and HEAD | 1 of 36 |
| Server: no `X-Content-Type-Options: nosniff` on served files | 1 of 36 |
| Server: every file is served as `text/html` | 1 of 36 |
| Server: a missing file gets 403 instead of 404 | 1 of 36: "a file that does not exist gets 404, not 403" |
| Server: an fstat or realpath error is swallowed instead of returning 404 | 1 of 36: "an fstat error after the open gets 404, not a crash" |
| Server: a read error is ignored instead of returning 404 | 1 of 36: "a read error gets 404, not a 500 or a partial 200" |
| Server: HEAD reads the whole file instead of answering from fstat | 1 of 36: "HEAD answers from fstat and never reads the file" |

## Security-relevant properties

- **Crafted input does not take the server down.** On 2026-11-08 two requests sent over a raw socket crashed the demo
  server: `/%E0%A4%A` (`decodeURIComponent` threw `URIError`) and `/a%00b` (the null byte made `fs.readFile` throw).
  After either one the server refused every later connection. Both now get 400. The tests send the same two requests
  over a raw socket, then check that the server still answers. `npm run mutants` undoes each part of the fix in turn,
  and each one is caught (table above).
- **No file outside `demo/` is served.** The old code joined and normalised the path, which quietly clamped a decoded
  `../` back to the demo folder, so its "outside the folder" check could never fire. The path is now resolved, an
  encoded slash after `..` (`/..%2f`) reaches the check and gets 403. A second test uses a sibling folder with the same name prefix
  (`demo-private`), which a check without the path separator would serve. Both expected statuses are written in the tests,
  not computed from the code under test. The path is checked again after following symlinks, so a link inside `demo/`
  that points outside it gets 403; tests make a file link and a directory link at run time and request them. The file is
  opened once and the check runs on the opened file, so swapping the path for a link after the check cannot change what
  is read. A round-3 red-team review leaked an outside file in 295 of 4000 requests with the old check-then-read code;
  the new code leaked 0 of 8000 on Linux. On Windows and macOS (no `/proc`) the check compares the opened file's
  identity with its real path's instead. A test swaps the file right after the check and confirms the swapped file is not served. On Linux
  that covers the descriptor check. On Windows 11 the same test shows the swap cannot land: Windows refuses to replace a
  file that the server has open, and the original file is served. macOS is not tested, so treat that path as unmeasured.
  A hard link is not a path trick: its real path is inside `demo/`, so the server refuses any file with more than one
  link, which also refuses legitimately hard-linked copies.
- **No traffic leaves the machine.** A test records every request and every WebSocket connection the app opens, and
  fails on any that leaves the local server. Service workers are blocked, so none of their fetches go unrecorded.
- **Trip data is shown as text, never parsed as HTML.** The app builds the page with `createElement` and appends the
  strings, which the DOM inserts as text nodes. A test loads a trip file full of markup and an `onerror` script, opens every
  view, and checks that the markup shows as literal text and the script never runs.
- **The tests are tested.** `npm run mutants` plants known bugs and fails if the suite misses one (see above).
- **CI has least privilege.** The workflow token is read-only (`contents: read`), checkout keeps no credentials
  (`persist-credentials: false`), and every action is pinned to a commit.

## Run it locally

Requires Node (CI uses Node 24).

```
npm ci
npx playwright install --with-deps   # Linux: also installs system libraries (needs root); omit --with-deps on macOS and Windows
npm test                             # needs port 4173 free: a server already listening there is reused, not restarted
```

| Command | What it does |
|---|---|
| `npm run test:chromium` | Runs the browser tests in Chromium only (not the browserless server tests) |
| `npm run demo` | Serves the demo app at http://127.0.0.1:4173/ |
| `npm run report` | Opens the HTML report from the last run |
| `npm run mutants` | Runs the Chromium suite against each broken copy of the app, and the browserless tests against each broken copy of the server |

GitHub Actions (`.github/workflows/playwright.yml`) runs the suite in all three browsers, then the mutants, on every push to any branch
and on pull requests to `main`, and saves the HTML report with each run. A second job runs the browserless server tests on Windows
(`windows-2025`) and macOS (`macos-15`), where the server's non-Linux branch and the Windows swap behaviour run.
`.github/workflows/scorecard.yml` runs OpenSSF Scorecard on pull requests to `main`, pushes to `main` and weekly, and
puts the score in the job summary.
`.github/workflows/osv-scanner.yml` runs OSV-Scanner on pull requests to `main` and fails a pull request that adds a
dependency with a known vulnerability. The actions are pinned by commit.

## License

MIT, see [LICENSE](LICENSE).
