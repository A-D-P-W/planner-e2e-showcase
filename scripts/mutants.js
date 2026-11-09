// Checks the tests against deliberately broken copies of the code ("mutants"). A mutant that every test passes means
// the suite missed a bug, and the script exits 1.
//   App mutants: copy demo/ to a temporary folder, plant the bug, serve that copy (DEMO_ROOT), run the Chromium suite.
//   Server mutants: write the bug to scripts/serve-demo.mutant.js (git-ignored, next to the real file so its paths
//   resolve the same way), point the server tests and the web server at it (SERVE_DEMO), then delete it. The tracked
//   serve-demo.js is never written. The expected statuses live in the tests, so a mutant cannot rewrite its own oracle.
// Both suites first run once against the unmutated code and must pass: a broken environment (no browser, port in use)
// would otherwise fail every test and count every mutant as caught.
// Usage: node scripts/mutants.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEMO = path.join(__dirname, '..', 'demo');
const SERVER = path.join(__dirname, 'serve-demo.js');
const MUTANT = path.join(__dirname, 'serve-demo.mutant.js');
const APP_MUTANTS = [
  {
    name: 'Full plan steps 24 hours per day instead of one calendar day',
    from: 'return new Date(s.y, s.m - 1, s.d + i);',
    to: 'return new Date(new Date(s.y, s.m - 1, s.d).getTime() + i * 864e5);',
  },
  {
    name: 'Today view divides the time elapsed since Day 1 by 24 hours instead of counting calendar days',
    from: 'return dayNumber(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) - dayNumber(Date.UTC(s.y, s.m - 1, s.d));',
    to: 'return Math.floor((now - new Date(s.y, s.m - 1, s.d)) / 864e5);',
  },
  {
    name: 'The ticked checklist item is not saved',
    from: 'saveChecked([...checked]);',
    to: '/* not saved */',
  },
  {
    name: 'Day items are written as HTML (innerHTML) instead of text',
    from: "items.map(t => el('li', {}, t))",
    to: "items.map(t => { const li = el('li', {}); li.innerHTML = t; return li; })",
  },
  {
    name: 'Full plan lists the days in reverse order',
    from: 'replaceChildren(...views[name]())',
    to: "replaceChildren(...(name === 'plan' ? views[name]().reverse() : views[name]()))",
  },
];
const SERVER_MUTANTS = [
  {
    name: 'Server: the path is percent-decoded twice (%252e%252e%252f becomes ../)',
    from: "decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname)",
    to: "decodeURIComponent(decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname))",
  },
  {
    name: 'Server: malformed percent-encoding throws instead of returning 400',
    from: '  } catch (e) {\n    return { status: 400 };\n  }',
    to: '  } catch (e) {\n    throw e;\n  }',
  },
  {
    name: 'Server: no null-byte check',
    from: "  if (urlPath.includes('\\0')) return { status: 400 };\n",
    to: '',
  },
  {
    name: 'Server: join + normalize instead of resolve (a decoded "../" is clamped, so the folder check never fires)',
    from: "path.resolve(root, '.' + path.sep + relative)",
    to: 'path.join(root, path.normalize(relative))',
  },
  {
    name: 'Server: folder check without the separator (a sibling such as demo-private passes)',
    from: 'if (!file.startsWith(root + path.sep))',
    to: 'if (!file.startsWith(root))',
  },
  {
    name: 'Server: no check after following symlinks (a link inside demo/ that points outside it is served)',
    from: '    if (!insideRoot(real)) return',
    to: '    if (false) return',
  },
  {
    name: 'Server: no link-count check (a hard link inside demo/ to an outside file is served)',
    from: '      if (st.nlink > 1) return done(403',
    to: '      if (false) return done(403',
  },
  {
    name: 'Server: blocking open (a FIFO inside demo/ holds a thread until a writer appears)',
    from: ' | (fs.constants.O_NONBLOCK || 0)',
    to: '',
    skipOn: ['win32'], // the FIFO test that catches it cannot run on Windows (no FIFOs in NTFS)
  },
  {
    name: 'Server: every HTTP method is served, not only GET and HEAD',
    from: "  if (req.method !== 'GET' && req.method !== 'HEAD') return send",
    to: '  if (false) return send',
  },
  {
    name: 'Server: no X-Content-Type-Options: nosniff on served files',
    from: "'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }",
    to: "'Cache-Control': 'no-store' }",
  },
  {
    name: 'Server: every file is served as text/html',
    from: "TYPES[path.extname(real)] || 'application/octet-stream'",
    to: "'text/html; charset=utf-8'",
  },
  {
    name: 'Server: the containment check counts the demo folder itself as inside it',
    from: "return rel !== '' && rel !== '..'",
    to: "return rel !== '..'",
  },
  {
    name: 'Server: the containment check counts the parent folder as inside',
    from: "rel !== '' && rel !== '..' &&",
    to: "rel !== '' &&",
  },
  {
    name: 'Server: the containment check counts ../<file> as inside',
    from: " && !rel.startsWith('..' + path.sep)",
    to: '',
  },
  {
    name: 'Server: the file is read again by path, not from the descriptor that was checked',
    from: 'fs.read(fd, data, 0, st.size, 0, (err2, n) => {',
    to: 'fs.readFile(file, (err2, buf) => { const n = buf ? buf.copy(data) : 0;',
  },
  {
    name: 'Server: a missing file gets 403 instead of 404',
    from: "send(res, err.code === 'ELOOP' ? 403 : 404, err.code === 'ELOOP' ? 'Forbidden' : 'Not found')",
    to: "send(res, 403, 'Forbidden')",
  },
  {
    name: 'Server: an fstat or realpath error is swallowed instead of returning 404',
    from: "} catch (e) { return done(404, 'Not found'); }",
    to: '} catch (e) { }',
  },
  {
    name: 'Server: a read error is ignored instead of returning 404',
    from: "if (err2) return done(404, 'Not found');",
    to: "if (false) return done(404, 'Not found');",
  },
  {
    name: 'Server: HEAD reads the whole file instead of answering from fstat',
    from: "if (req.method === 'HEAD') return done(200",
    to: 'if (false) return done(200',
  },
  {
    name: 'Server: a short read is served as a truncated 200, not a 500',
    from: 'if (n !== st.size) return done(500',
    to: 'if (false) return done(500',
  },
];

function runSuite(project, env) {
  const run = spawnSync('npx', ['playwright', 'test', `--project=${project}`, '--reporter=json', '--retries=0'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  try {
    return JSON.parse(run.stdout).stats;
  } catch (e) {
    throw new Error(`could not read the test report:\n${run.stderr}`);
  }
}

// Normalise line endings, so a checkout with CRLF still matches the multi-line mutants.
function read(file) { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }

function check(mutant, source) {
  // A mutant whose text no longer matches would "pass" without testing anything, so that is an error too.
  if (source.split(mutant.from).length !== 2) {
    console.error(`MUTANT DOES NOT APPLY (code changed?): ${mutant.name}`);
    process.exit(1);
  }
}

let survivors = 0, total = 0;
function report(mutant, stats) {
  total++;
  const all = stats.expected + stats.unexpected + stats.flaky + stats.skipped;
  const caught = stats.unexpected > 0;
  if (!caught) survivors++;
  console.log(`${caught ? 'CAUGHT  ' : 'MISSED  '} ${stats.unexpected} of ${all} failed: ${mutant.name}`);
}
function baseline(project, env) {
  const stats = runSuite(project, env);
  if (stats.unexpected || stats.flaky || !stats.expected) {
    console.error(`BASELINE FAILED: the ${project} suite does not pass on the unmutated code (${stats.unexpected} failed, ${stats.expected} passed), so no mutant result would mean anything.`);
    process.exit(1);
  }
  console.log(`BASELINE  ${stats.expected} passed, ${stats.skipped} skipped: ${project} suite on the unmutated code`);
}

const app = read(path.join(DEMO, 'index.html'));
baseline('chromium', {});
for (const mutant of APP_MUTANTS) {
  check(mutant, app);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-mutant-'));
  fs.cpSync(DEMO, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), app.replace(mutant.from, mutant.to));
  try { report(mutant, runSuite('chromium', { DEMO_ROOT: dir })); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const server = read(SERVER);
const serverEnv = { CI: '1', SERVE_DEMO: path.relative(process.cwd(), MUTANT) };
fs.rmSync(MUTANT, { force: true });
fs.writeFileSync(MUTANT, server);
try { baseline('server', serverEnv); } finally { fs.rmSync(MUTANT, { force: true }); }
for (const mutant of SERVER_MUTANTS) {
  check(mutant, server);
  if (mutant.skipOn && mutant.skipOn.includes(process.platform)) { console.log('SKIPPED   on ' + process.platform + ': ' + mutant.name); continue; }
  fs.writeFileSync(MUTANT, server.replace(mutant.from, mutant.to));
  try { report(mutant, runSuite('server', serverEnv)); } finally { fs.rmSync(MUTANT, { force: true }); }
}

console.log(survivors ? `VERDICT: ${survivors} of ${total} mutant(s) not caught` : `VERDICT: all ${total} mutants caught`);
process.exit(survivors ? 1 : 0);