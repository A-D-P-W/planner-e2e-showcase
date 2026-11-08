// Checks the tests against deliberately broken copies of the code ("mutants"). A mutant that every test passes means
// the suite missed a bug, and the script exits 1.
//   App mutants: copy demo/ to a temporary folder, plant the bug, serve that copy (DEMO_ROOT), run the Chromium suite.
//   Server mutants: plant the bug in scripts/serve-demo.js itself, run the server tests, then restore the file (also
//   on a crash or Ctrl+C). The expected statuses live in the tests, so a mutant cannot rewrite its own oracle.
// Usage: node scripts/mutants.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEMO = path.join(__dirname, '..', 'demo');
const SERVER = path.join(__dirname, 'serve-demo.js');
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
];
const SERVER_MUTANTS = [
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

const app = read(path.join(DEMO, 'index.html'));
for (const mutant of APP_MUTANTS) {
  check(mutant, app);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-mutant-'));
  fs.cpSync(DEMO, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), app.replace(mutant.from, mutant.to));
  try { report(mutant, runSuite('chromium', { DEMO_ROOT: dir })); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const serverBytes = fs.readFileSync(SERVER);
const restore = () => fs.writeFileSync(SERVER, serverBytes);
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
const server = read(SERVER);
for (const mutant of SERVER_MUTANTS) {
  check(mutant, server);
  fs.writeFileSync(SERVER, server.replace(mutant.from, mutant.to));
  try { report(mutant, runSuite('server', { CI: '1' })); } finally { restore(); }
}

console.log(survivors ? `VERDICT: ${survivors} of ${total} mutant(s) not caught` : `VERDICT: all ${total} mutants caught`);
process.exit(survivors ? 1 : 0);