/**
 * Writes tests/e2e/timings.json: how many seconds each E2E spec file takes in CI's worker halves, averaged over the
 * given runs. The Playwright config splits the suite into halves of equal time with it. Refresh it when the halves'
 * times drift apart, from a few recent runs:
 *
 *   node scripts/e2e-timings.mjs <CI run id> [<CI run id>…]
 *
 * Runners differ in speed by up to a third, so one run's times favour the specs that got the faster machine; several
 * runs even that out. A cancelled job's tests are not in its run's log, so a run cut short adds only its other half.
 * Needs the GitHub CLI, signed in.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'

const runs = process.argv.slice(2)
if (runs.length === 0) {
  console.error('Usage: node scripts/e2e-timings.mjs <CI run id> [<CI run id>…]')
  process.exit(1)
}
// A list reporter line of a worker half (not the main-thread leg, which runs some specs a second time), e.g.
// "E2E (Chromium, 2 of 2)	UNKNOWN STEP	2026-10-31T21:23:40Z   ✓  14 [chromium] › tests/e2e/a.spec.ts:126:1 › … (4.6s)"
// The middle column names the step, or says UNKNOWN STEP when GitHub can't tell. Skipped tests ("-") have no time;
// they count as 0, so a spec skipped in CI is not taken for a new one.
const pattern =
  /^E2E \(Chromium, \d of \d\)\t[^\t]*\t\S+\s+[✓✘-]\s+\d+ \[chromium\] › tests\/e2e\/([\w.-]+\.spec\.ts):\d+:\d+ › .*?(?: \((\d+(?:\.\d+)?)(ms|s|m)\))?$/
const unit = { ms: 0.001, s: 1, m: 60 }
const sums = {}
const counts = {}
for (const run of runs) {
  const log = execFileSync('gh', ['run', 'view', run, '--log'], { encoding: 'utf8', maxBuffer: 1 << 30 })
  const seconds = {}
  for (const line of log.split('\n')) {
    const m = pattern.exec(line.trimEnd())
    if (m) seconds[m[1]] = (seconds[m[1]] ?? 0) + (m[2] ? Number(m[2]) * unit[m[3]] : 0)
  }
  if (Object.keys(seconds).length === 0) {
    console.error(`No E2E test results in the log of run ${run}`)
    process.exit(1)
  }
  for (const [file, s] of Object.entries(seconds)) {
    sums[file] = (sums[file] ?? 0) + s
    counts[file] = (counts[file] ?? 0) + 1
  }
}
// Specs deleted since are left out: the typical time a new spec counts as is taken from these.
const present = new Set(readdirSync(new URL('../tests/e2e/', import.meta.url)))
const files = Object.keys(sums)
  .filter((f) => present.has(f))
  .sort()
const table = Object.fromEntries(files.map((f) => [f, Math.round(sums[f] / counts[f])]))
writeFileSync(new URL('../tests/e2e/timings.json', import.meta.url), `${JSON.stringify(table, null, 2)}\n`)
const total = Object.values(table).reduce((a, b) => a + b, 0)
console.log(`${files.length} spec files, ${Math.round(total / 60)} min in all, from ${runs.length} runs`)
