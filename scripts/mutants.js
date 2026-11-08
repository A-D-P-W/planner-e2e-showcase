// Checks the tests against deliberately broken copies of the app ("mutants"). Each mutant is one bug from the
// README's table. For each one this copies demo/ to a temporary folder, plants the bug, serves that copy
// (DEMO_ROOT) and runs the browser suite in Chromium. A mutant that every test passes means the suite missed a bug,
// and the script exits 1.
// Usage: node scripts/mutants.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEMO = path.join(__dirname, '..', 'demo');
const MUTANTS = [
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
];

const source = fs.readFileSync(path.join(DEMO, 'index.html'), 'utf8');
let survivors = 0;
for (const mutant of MUTANTS) {
  // A mutant whose text no longer matches the app would "pass" without testing anything, so that is an error too.
  if (source.split(mutant.from).length !== 2) {
    console.error(`MUTANT DOES NOT APPLY (app changed?): ${mutant.name}`);
    process.exit(1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-mutant-'));
  fs.cpSync(DEMO, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), source.replace(mutant.from, mutant.to));
  const run = spawnSync('npx', ['playwright', 'test', '--project=chromium', '--reporter=json', '--retries=0'], {
    env: { ...process.env, DEMO_ROOT: dir },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  let stats;
  try {
    stats = JSON.parse(run.stdout).stats;
  } catch (e) {
    console.error(`Could not read the test report for: ${mutant.name}\n${run.stderr}`);
    process.exit(1);
  }
  const total = stats.expected + stats.unexpected + stats.flaky + stats.skipped;
  const caught = stats.unexpected > 0;
  if (!caught) survivors++;
  console.log(`${caught ? 'CAUGHT  ' : 'MISSED  '} ${stats.unexpected} of ${total} failed: ${mutant.name}`);
}
console.log(survivors ? `VERDICT: ${survivors} mutant(s) not caught` : `VERDICT: all ${MUTANTS.length} mutants caught`);
process.exit(survivors ? 1 : 0);