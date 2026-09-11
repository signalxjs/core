// The resumability ladder in a real browser, in BOTH modes (#702 phase 7).
//
//   pnpm smoke:resume        (after `pnpm build` — the workspace dists)
//
// Builds examples/resume, then runs its smoke against the production server
// and again against the dev server. Dev runs the same ladder as prod (the
// transform has no environment gate; the dev server serves the handlers
// virtuals; the registry lazily imports the component modules), and this is
// the script that keeps it that way: every replay, upgrade-on-write, wake
// and refresh assertion must hold in both, plus the `[sigx resume]` console
// trace in dev. Needs Chromium: `pnpm exec playwright install chromium`.
// CI job: resume-smoke.
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(repoRoot, 'examples', 'resume');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log('\n[resume-smoke] building examples/resume…');
run('pnpm --filter @sigx/resume-example build', repoRoot);

console.log('\n[resume-smoke] production server');
run(`"${process.execPath}" smoke.mjs`, example);

console.log('\n[resume-smoke] dev server');
run(`"${process.execPath}" smoke.mjs --dev`, example);

console.log('\n✅ resume-smoke: the ladder holds in prod and in dev');
