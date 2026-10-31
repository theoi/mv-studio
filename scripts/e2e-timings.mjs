/**
 * Writes tests/e2e/timings.json: how many seconds each E2E spec file took in a CI run's two worker halves. The
 * Playwright config splits the suite into halves of equal time with it. Refresh it when the halves' times drift apart:
 *
 *   node scripts/e2e-timings.mjs <CI run id>
 *
 * Needs the GitHub CLI, signed in.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const run = process.argv[2]
if (!run) {
  console.error('Usage: node scripts/e2e-timings.mjs <CI run id>')
  process.exit(1)
}
const log = execFileSync('gh', ['run', 'view', run, '--log'], { encoding: 'utf8', maxBuffer: 1 << 30 })
// A list reporter line of either worker half (not the main-thread leg, which runs some specs a second time), e.g.
// "E2E (Chromium, 2 of 2)	Run npx playwright test	2026-10-31T21:23:40Z   ✓  14 [chromium] › tests/e2e/a.spec.ts:126:1 › … (4.6s)"
// Skipped tests ("-") have no time; they count as 0, so a spec skipped in CI is not taken for a new one.
const pattern =
  /^E2E \(Chromium, [12] of 2\)\tRun npx playwright test\t\S+\s+[✓✘-]\s+\d+ \[chromium\] › tests\/e2e\/([\w.-]+\.spec\.ts):\d+:\d+ › .*?(?: \((\d+(?:\.\d+)?)(ms|s|m)\))?$/
const unit = { ms: 0.001, s: 1, m: 60 }
const seconds = {}
for (const line of log.split('\n')) {
  const m = pattern.exec(line.trimEnd())
  if (m) seconds[m[1]] = (seconds[m[1]] ?? 0) + (m[2] ? Number(m[2]) * unit[m[3]] : 0)
}
const files = Object.keys(seconds).sort()
if (files.length === 0) {
  console.error(`No E2E test results in the log of run ${run}`)
  process.exit(1)
}
const table = Object.fromEntries(files.map((f) => [f, Math.round(seconds[f])]))
writeFileSync(new URL('../tests/e2e/timings.json', import.meta.url), `${JSON.stringify(table, null, 2)}\n`)
const total = Object.values(table).reduce((a, b) => a + b, 0)
console.log(`${files.length} spec files, ${Math.round(total / 60)} min in all`)
