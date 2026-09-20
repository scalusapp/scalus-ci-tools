#!/usr/bin/env node
/**
 * layout-check.mjs — catch text that sits flush against the viewport edge.
 *
 * WHY THIS EXISTS: a horizontal-overflow check (scrollWidth > clientWidth) passes
 * happily while text is jammed against the left edge with zero gutter, because
 * nothing actually overflows. That is exactly how a broken client section
 * shipped on 29 Jul 2026. Overflow and gutter are two different bugs, so the sweep
 * must test both.
 *
 * It measures every element that renders its OWN text and flags any whose left edge
 * is inside the minimum gutter, or whose right edge is inside it. Full bleed
 * containers are ignored, only the text itself is judged.
 *
 *   node ~/.scalus/layout-check.mjs <url> [--gutter 20] [--widths 390,768,1024,1280,1440]
 *
 * Exit code 1 if anything is flagged, so it can gate a deploy.
 */

import { execSync } from 'node:child_process';
import { createRequire as _cr } from 'node:module';
const require = _cr(import.meta.url);
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const url = argv.find((a) => a.startsWith('http'));
if (!url) { console.error('usage: layout-check.mjs <url> [--gutter N] [--widths a,b,c]'); process.exit(2); }

const GUTTER = Number(arg('gutter', 20));
const WIDTHS = String(arg('widths', '360,390,414,640,768,834,900,1024,1100,1180,1280,1366,1440,1680'))
  .split(',').map(Number);
// --json emits structured findings so build-gate.mjs can baseline individual
// gutter violations instead of treating the whole check as one pass/fail.
const asJson = argv.includes('--json');
const allFindings = [];

const browser = await chromium.launch({ headless: true });
let problems = 0;

for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // reveal-on-scroll sections must be materialised or they measure as hidden
  // Materialise scroll-reveal sections ONLY. A blanket opacity override also un-hides
  // closed off-canvas menus and floods the report with phantom violations.
  await page.evaluate(() => {
    document.querySelectorAll('.rv,.reveal,.hide').forEach((e) => {
      e.classList.add('in', 'is-in', 'visible');
      e.classList.remove('hide');
      e.style.opacity = '1';
      e.style.transform = 'none';
    });
  });
  await page.waitForTimeout(200);

  const found = await page.evaluate((gutter) => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      // only judge elements that render their OWN text
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      // Skip things whose edge position is by design rather than a layout bug:
      //  - pinned bars and floating header pills set their own tighter padding
      //  - items inside a horizontal scroller or clipped marquee track extend past it
      let byDesign = false;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.position === 'fixed' || acs.position === 'sticky') { byDesign = true; break; }
        if (['auto','scroll','hidden','clip'].includes(acs.overflowX) && a.scrollWidth > a.clientWidth + 4) { byDesign = true; break; }
      }
      if (byDesign) continue;
      if (el.closest('[aria-hidden="true"],[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 4) continue;
      // Entirely off canvas: a closed slide out menu or drawer, not a gutter bug.
      if (r.right <= 0 || r.left >= vw) continue;
      const tooLeft = r.left < gutter;
      const tooRight = r.right > vw - gutter;
      if (tooLeft || tooRight) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 40),
          left: Math.round(r.left), right: Math.round(r.right), vw,
          side: tooLeft && tooRight ? 'both' : tooLeft ? 'left' : 'right',
          text: own.slice(0, 52),
        });
      }
    }
    return out;
  }, GUTTER);

  if (found.length) {
    problems += found.length;
    for (const f of found) allFindings.push({ ...f, width: w, selector: `${f.tag}${f.cls ? '.' + f.cls.trim().split(/\s+/)[0] : ''}` });
    if (asJson) { await ctx.close(); continue; }
    console.log(`\n@${w}px  ${found.length} block(s) inside the ${GUTTER}px gutter:`);
    for (const f of found.slice(0, 8)) {
      console.log(`  ${f.side.padEnd(5)} left=${String(f.left).padStart(4)} right=${String(f.right).padStart(4)} vw=${f.vw}  <${f.tag}${f.cls ? '.' + f.cls : ''}>  "${f.text}"`);
    }
    if (found.length > 8) console.log(`  ...and ${found.length - 8} more`);
  }
  await ctx.close();
}

await browser.close();
if (asJson) { console.log(JSON.stringify(allFindings)); process.exit(problems ? 1 : 0); }
console.log(problems ? `\nFAIL: ${problems} gutter violation(s)` : `PASS: text clears a ${GUTTER}px gutter at all ${WIDTHS.length} widths`);
process.exit(problems ? 1 : 0);
