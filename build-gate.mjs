#!/usr/bin/env node
/**
 * build-gate.mjs — THE blocking quality gate for every automated site build or change.
 *
 * Tim, 29 Jul 2026: "basic website creation errors can't be done. So we need a
 * foundation that we can always rely upon when you do these automated builds and
 * changes." This is that foundation. Exit code 1 means DO NOT DEPLOY.
 *
 * Four families of basic error, none of which the old overflow-only check could see:
 *
 *   1. GUTTER    text jammed against the viewport edge (delegates to layout-check.mjs)
 *   2. OVERFLOW  the page scrolls sideways at any width
 *   3. A11Y      contrast, tap target size, missing alt text, unnamed links and
 *                buttons, missing lang or title  (axe-core, Deque, zero deps)
 *   4. ASSETS    any request that 404s, so a broken image or font can never ship
 *
 *   node ~/.scalus/build-gate.mjs <url> [--widths 390,768,1280] [--gutter 20] [--json]
 *
 * Keep the exclusions honest. If the gate flags something you believe is intentional,
 * look at the rendered screenshot at that width and prove it before excluding it.
 * Never widen an exclusion just to make a page pass.
 */

import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const GROOT = execSync('npm root -g').toString().trim();
const { chromium } = require(path.join(GROOT, 'playwright'));
const AXE_PATH = path.join(GROOT, 'axe-core', 'axe.min.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const url = argv.find((a) => a.startsWith('http'));
if (!url) { console.error('usage: build-gate.mjs <url> [--widths a,b,c] [--gutter N]'); process.exit(2); }

const GUTTER = arg('gutter', '20');
const WIDTHS = String(arg('widths', '390,768,1024,1280,1440')).split(',').map(Number);
const asJson = argv.includes('--json');
const writeBaseline = argv.includes('--baseline');

// BASELINE. Contrast and tap size on an existing site are usually brand decisions that
// need the client's sign off, not automation errors. If the gate hard failed on those,
// every site would fail forever and the gate would get switched off, which is the real
// risk. So: anything ALREADY on a page is recorded once and reported every run, while a
// violation the change INTRODUCED is a hard fail. The gate can never be quietened by
// widening an exclusion, only by an explicit, visible baseline entry.
// CI (Tim, 21 Sep 2026): the baseline used to live only in Tim's home folder, so
// a GitHub Actions runner had none and every pre-existing brand decision became a
// hard fail (106 of them on the first cloud run). Two env overrides fix
// that without changing local behaviour:
//   SCALUS_BASELINE_DIR  where baselines live (CI commits them to the repo)
//   SCALUS_BASELINE_KEY  stable per-site key, so the baseline does not break just
//                        because CI serves on a different port than the Mac did
const BASE_DIR = process.env.SCALUS_BASELINE_DIR
  || path.join(process.env.HOME, '.scalus', 'build-gate-baseline');
const BASE_KEY = process.env.SCALUS_BASELINE_KEY
  || url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_');
const BASE_FILE = path.join(BASE_DIR, BASE_KEY + '.json');
const baseline = (() => { try { return JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch { return null; } })();
const sig = (w, v, n) => `${w}|${v.id}|${n.target}`;

// The rules that map to "basic website creation errors". Deliberately NOT the full
// WCAG sweep: this gate must be something every build can actually pass.
const RULES = [
  'color-contrast',        // unreadable text on its background
  'image-alt',             // images with no alt text
  'link-name',             // links with no accessible name
  'button-name',           // buttons with no accessible name
  'target-size',           // tap targets under the minimum (WCAG 2.2)
  'html-has-lang',
  'document-title',
  'meta-viewport',         // pinch zoom disabled
  'duplicate-id-active',
];

const report = { url, gutter: null, overflow: [], a11y: [], assets: [] };
let failed = 0;

// ---------------------------------------------------------------- 1. gutter
// CI (Tim, 21 Sep 2026): this used to hardcode $HOME/.scalus/layout-check.mjs,
// which does not exist on a GitHub runner, so the gutter check silently broke
// in the cloud. Resolve it next to THIS file instead, which is correct both on
// the Mac (~/.scalus/) and in CI (ci-tools/).
const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);
const g = spawnSync(process.execPath, [path.join(SELF_DIR, 'layout-check.mjs'), url,
  '--gutter', GUTTER, '--widths', WIDTHS.join(','), '--json'], { encoding: 'utf8' });

// Gutter baselining, same philosophy as a11y above. TMC Media designs to an
// 18px gutter against a 20px house default, so 45 "violations" were really one
// design decision. Widening the threshold per site would erode the standard
// quietly; recording them makes the deviation visible and still hard fails on
// anything NEW. SKILL.md flagged this gap on 29 Jul 2026.
let gutterFindings = [];
try { gutterFindings = JSON.parse(g.stdout || '[]'); } catch { gutterFindings = []; }
const gutterSig = (f) => `${f.width}|${f.selector}|${f.side}`;
const knownGutter = baseline?.knownGutter || [];
const newGutter = gutterFindings.filter((f) => !knownGutter.includes(gutterSig(f)));
report.gutter = {
  pass: newGutter.length === 0,
  total: gutterFindings.length,
  new: newGutter.length,
  known: gutterFindings.length - newGutter.length,
  out: newGutter.slice(0, 8).map((f) =>
    `  ${f.side}  left=${f.left} right=${f.right} vw=${f.width}  <${f.selector}>  ${JSON.stringify(f.text || '')}`).join('\n'),
};
report.gutterFindings = gutterFindings;
failed += newGutter.length;

// ---------------------------------------------------------------- 2-4. browser passes
const browser = await chromium.launch({ headless: true });

for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const page = await ctx.newPage();

  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => bad.push(`FAILED ${r.url()}`));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  // Kill every transition and animation FIRST. Reveal sections fade with
  // `transition:opacity .7s`, so simply setting opacity:1 and waiting 250ms left
  // axe sampling them mid fade: it then blends the real colour against the
  // background and invents a contrast figure that differs on every single run.
  // That made the a11y gate non deterministic (byte identical page reported
  // "106 new" then "264 new" against its own baseline on 3 Aug 2026), which is
  // worse than no gate, because nothing ever matches a baseline fingerprint.
  await page.addStyleTag({ content: `*,*::before,*::after{
    animation:none!important;
    transition:none!important;
    animation-duration:0s!important;
    transition-duration:0s!important;
  }` });
  // materialise scroll-reveal content so it is actually audited
  await page.evaluate(() => {
    document.querySelectorAll('.rv,.reveal,.hide').forEach((e) => {
      e.classList.add('in', 'is-in', 'visible'); e.classList.remove('hide');
      e.style.opacity = '1'; e.style.transform = 'none';
    });
  });
  await page.waitForTimeout(250);

  // 2. overflow
  const ov = await page.evaluate(() => {
    const d = document.documentElement;
    return { s: d.scrollWidth, c: d.clientWidth };
  });
  if (ov.s > ov.c + 1) { report.overflow.push({ w, scrollWidth: ov.s, clientWidth: ov.c }); failed++; }

  // 3. a11y
  await page.addScriptTag({ path: AXE_PATH });
  const res = await page.evaluate(async (rules) => {
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules } });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => ({
        target: n.target.join(' '),
        detail: (n.failureSummary || '').split('\n').filter(Boolean).slice(1, 3).join(' | ').slice(0, 160),
      })),
    }));
  }, RULES);
  for (const v of res) {
    const isNew = (n) => !baseline || !baseline.known.includes(sig(w, v, n));
    const fresh = v.nodes.filter(isNew);
    const known = v.nodes.filter((n) => !isNew(n));
    report.a11y.push({ w, id: v.id, impact: v.impact, help: v.help, fresh, known });
    failed += fresh.length;
  }

  // 4. assets
  if (bad.length) { report.assets.push({ w, bad: [...new Set(bad)] }); failed += bad.length; }

  await ctx.close();
}
await browser.close();

// ---------------------------------------------------------------- output
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nBUILD GATE  ${url}\n${'='.repeat(60)}`);
  console.log(`1. GUTTER    ${report.gutter.pass ? 'PASS' : 'FAIL'}   ${report.gutter.new} new, ${report.gutter.known} pre existing`);
  if (!report.gutter.pass) console.log(report.gutter.out.split('\n').map((l) => '   ' + l).join('\n'));

  console.log(`2. OVERFLOW  ${report.overflow.length ? 'FAIL' : 'PASS'}`);
  for (const o of report.overflow) console.log(`   @${o.w}px scrollWidth ${o.scrollWidth} > ${o.clientWidth}`);

  const freshTotal = report.a11y.reduce((n, a) => n + a.fresh.length, 0);
  const knownTotal = report.a11y.reduce((n, a) => n + a.known.length, 0);
  console.log(`3. A11Y      ${freshTotal ? 'FAIL' : 'PASS'}   ${freshTotal} new, ${knownTotal} pre existing`);
  if (!baseline) console.log('   (no baseline yet for this url, so everything counts as new. run once with --baseline)');
  for (const a of report.a11y.filter((x) => x.fresh.length)) {
    console.log(`   NEW @${a.w}px  [${a.impact}] ${a.id} x${a.fresh.length}  ${a.help}`);
    for (const n of a.fresh.slice(0, 4)) console.log(`        ${n.target}\n          ${n.detail}`);
    if (a.fresh.length > 4) console.log(`        ...and ${a.fresh.length - 4} more`);
  }
  const byRule = {};
  for (const a of report.a11y) for (const n of a.known) byRule[a.id] = (byRule[a.id] || 0) + 1;
  for (const [id, n] of Object.entries(byRule)) console.log(`   known  ${id} x${n}  (baselined, needs a deliberate design fix)`);

  console.log(`4. ASSETS    ${report.assets.length ? 'FAIL' : 'PASS'}`);
  for (const a of report.assets) for (const b of a.bad) console.log(`   @${a.w}px ${b}`);

  console.log('='.repeat(60));
  console.log(failed ? `GATE FAILED, ${failed} issue(s). DO NOT DEPLOY.` : `GATE PASSED across ${WIDTHS.length} widths.`);
}
if (writeBaseline) {
  const known = [];
  for (const a of report.a11y) for (const n of [...a.fresh, ...a.known]) known.push(`${a.w}|${a.id}|${n.target}`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const knownGutterOut = (report.gutterFindings || []).map(gutterSig);
  fs.writeFileSync(BASE_FILE, JSON.stringify({ url, recorded: new Date().toISOString(), widths: WIDTHS, known, knownGutter: knownGutterOut }, null, 2));
  console.log(`\nbaseline written: ${known.length} known a11y + ${knownGutterOut.length} known gutter finding(s) -> ${BASE_FILE}`);
  console.log('these are now REPORTED not blocking. anything new hard fails.');
  process.exit(0);
}
process.exit(failed ? 1 : 0);
