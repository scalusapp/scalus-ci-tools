#!/usr/bin/env node
/* ==========================================================================
   SRA — Scalus Review Agent :: live publication checker
   --------------------------------------------------------------------------
   Runs the house standards against a REAL rendered page, headless, no window.
   Runtime measurement is the only truth here. A CSS grep cannot tell you the
   burger stranded itself in the middle of the bar, because every Scalus site
   has its own design system on purpose. Measuring the boxes can.

     node review.mjs <url> [more urls] [--json] [--widths=375,390,466,890] [--desktop]
                            [--only=header,overflow,tap,console,images,copy,head,radius]
                            [--quiet] [--concurrency=4]

   Exit code 0 = every page passed. 1 = at least one FAIL. WARNs never fail.

   Born 7 Sep 2026, after two client sites both
   shipped with the mobile header controls floating 70 to 85px short of the
   right edge. See CHECKS.md for what each rule is and why it exists.
   ========================================================================== */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/* Playwright is installed globally on this machine, not per project, so a bare
   ESM import cannot resolve it from wherever SRA is invoked. Same fallback
   ladder snap-page.js uses. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = require(path.join(g, 'playwright')));
}

/* The house width set.
     375, 390  the two phone widths Tim designs to
     466       iPhone Duo folded, the outer screen (1398/3, portrait)
     890       iPhone Duo unfolded (2670/3). The Duo opens like a book, so the
               inner panel is used in LANDSCAPE: 164.6mm wide by 117.8mm tall,
               the same height as folded with the width doubled. Apple lists the
               panel 1878x2670 in its portrait convention, so the long edge is
               the horizontal one once it is open.
   Corrected 11 Sep 2026. This set previously ran 626 and 669 as the unfolded
   width. Both were wrong: 626 is the unfolded HEIGHT (1878/3) and 669 was a
   guess. Nothing had ever been measured at the real open width, so every pass
   at "the Duo widths" before this date only ever proved the folded screen. */
const DEFAULT_WIDTHS = '375,390,466,890';

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const has  = (n) => argv.includes(`--${n}`);

const urls        = argv.filter(a => !a.startsWith('--'));
const asJson      = has('json');
const quiet       = has('quiet');
const withDesktop = has('desktop');
const widths      = flag('widths', DEFAULT_WIDTHS).split(',').map(n => parseInt(n, 10)).filter(Boolean);
const only        = flag('only', '').split(',').filter(Boolean);
const concurrency = Math.max(1, parseInt(flag('concurrency', '4'), 10));
const run         = (name) => !only.length || only.includes(name);

if (!urls.length) {
  console.error('SRA :: usage: node review.mjs <url> [...] [--json] [--widths=375,390,466,890] [--desktop] [--only=...]');
  process.exit(2);
}

/* --------------------------------------------------------------------------
   The house standards, as numbers. Change them HERE and every caller moves.
   -------------------------------------------------------------------------- */
export const STANDARD = {
  // The logo's left gutter and the control cluster's right gutter must match.
  // 14px of slack absorbs a border or an optical inset; beyond that the eye
  // reads it as "the menu is floating in the middle of the bar".
  gutterSkew:   14,
  minGutter:     8,   // neither side may kiss the screen edge
  minLogoGap:   14,   // clear air between the wordmark and the first control
  minTap:       40,   // header controls stay thumb sized (44 is the target)
  maxOverflow:   2,   // px of horizontal scroll tolerated (rounding only)

  /* Concentric corners. A rounded child inside a rounded parent must satisfy
     inner radius = outer radius minus the gap, or the ring of space between the
     two curves pinches at the corner and swells along the edges. SDT reference
     @guhmp4, 11 Sep 2026, and Tim's call the same day that every element we
     draw follows it from here on. The standalone auditor with the full table is
     ~/bin/concentric-check.js; this is the gate.
     Under 2px is rounding and antialiasing. Over 4px the eye reads it. */
  radiusTol:     2,
  radiusFail:    4,
  /* A child inset almost to the end of the parent's arc is already sitting on
     two straight edges, so the equation stops binding and the ideal radius
     collapses towards zero. Demanding a 0.5px radius on a rounded icon chip is
     not a standard, it is a bug: a client site failed on exactly that
     (outer 16, gap 15.5) the day the rule went in. Below this the child is
     free. */
  radiusFreeAt:  3,
};

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* --------------------------------------------------------------------------
   In-page probe. Returns raw measurements only; every verdict is made in
   node, so the thresholds live in one place.
   -------------------------------------------------------------------------- */
const PROBE = `(DEVICE_W) => {
  /* NEVER trust window.innerWidth on a phone. When a page overflows, Chrome
     widens the layout viewport to fit it, so a 375px iPhone reports 520 and
     every gutter, every right edge and the overflow check itself get measured
     against a width the device does not have. Use the width we actually set. */
  const vw = Math.min(window.innerWidth || DEVICE_W, DEVICE_W);
  const vis = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 4 && r.height > 4; };
  const cls = el => (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 48);

  /* ---- CHROME ON DEMAND: earn the bar back before measuring it ----
     From 19 Sep 2026 the Scalus top bar is not on screen at the top of the
     page at all: it is hidden by html.ch-nav-off and only comes back on a
     scroll up. Measured as it sits, the bar reports its hidden transform
     (translated off the top and scaled to .9), which reads as a 64px gutter
     skew and failed a header that is perfectly pinned when you can see it.
     So the classes come off for the measurement and go straight back on, the
     same way a reviewer scrolls up to look at the bar. Harmless on any site
     that has never heard of these classes. */
  const chromeOff = ['ch-nav-off', 'ch-dock-off', 'ch-focus', 'ch-boot']
    .filter(c => document.documentElement.classList.contains(c));
  chromeOff.forEach(c => document.documentElement.classList.remove(c));
  /* the transition is 340ms, and nothing here waits, so kill it for the read */
  const noAnim = document.createElement('style');
  noAnim.textContent = '*{transition:none!important;animation:none!important}';
  document.head.appendChild(noAnim);
  void document.documentElement.offsetHeight;

  /* ---- the site header: widest sticky/fixed bar sitting at the top ---- */
  let hdr = null, best = 1e9;
  for (const el of document.querySelectorAll('header,[class*="header"],[class*="hdr"],[id*="header"],nav,[class*="navbar"],[class*="topbar"]')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < vw * 0.6 || r.height < 28 || r.height > 160 || r.top > 140) continue;
    const score = r.top + (cs.position === 'fixed' || cs.position === 'sticky' ? 0 : 200) + (el.tagName === 'HEADER' ? 0 : 40);
    if (score < best) { best = score; hdr = el; }
  }

  /* The INK extent of an element, not its padded/stretched box. A brand link
     is very often a flex item that stretches halfway across the bar while the
     wordmark inside it is 40px wide. Measuring the box would report a
     collision that nobody can see. Measure what actually draws. */
  const ink = el => {
    const parts = [];
    const push = r => { if (r && r.width > 0.5 && r.height > 0.5) parts.push(r); };
    for (const d of el.querySelectorAll('img,svg,picture,span,b,strong,i,em,div,p')) if (vis(d)) push(d.getBoundingClientRect());
    // own text nodes count as ink too
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; const rng = document.createRange();
    while ((n = w.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      rng.selectNodeContents(n); push(rng.getBoundingClientRect());
    }
    if (!parts.length) return el.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: Math.max(r.left, Math.min(...parts.map(p => p.left))),
             right: Math.min(r.right, Math.max(...parts.map(p => p.right))),
             top: r.top, bottom: r.bottom,
             get width() { return this.right - this.left; }, height: r.height };
  };

  /* A CONTROL that paints itself is its own ink. A coral pill button, a round
     burger with a fill and a border, a chip: what the eye reads as the control
     is the painted box, not the glyphs sitting inside its padding. Measuring the
     glyphs reported a right gutter one padding deeper than it looks and failed
     three correctly pinned live headers at the iPhone Duo widths on 11 Sep 2026
     (a round burger, and pill shaped controls on other builds).
     This deliberately does NOT apply to the brand. A brand link is very often a
     stretched flex item that also carries a background, and measuring that box
     is the exact false collision ink() was written to stop. */
  const ctrlInk = el => {
    const cs = getComputedStyle(el);
    /* alpha by parsing, never by pattern: a regex looking for a trailing ", 0)"
       also matches rgb(255, 77, 0), and a client's orange button read as
       invisible because of it. */
    const alphaOf = c => { const i = c.indexOf('('); if (i < 0) return 1;
      const parts = c.slice(i + 1, c.lastIndexOf(')')).split(',');
      return parts.length > 3 ? parseFloat(parts[3]) : 1; };
    const solid = c => !!c && c !== 'transparent' && alphaOf(c) > 0.02;
    const painted = solid(cs.backgroundColor)
      || (cs.backgroundImage && cs.backgroundImage !== 'none')
      || ['Top', 'Right', 'Bottom', 'Left'].some(side =>
           parseFloat(cs['border' + side + 'Width']) > 0
           && cs['border' + side + 'Style'] !== 'none'
           && solid(cs['border' + side + 'Color']));
    return painted ? el.getBoundingClientRect() : ink(el);
  };

  let header = null;
  if (hdr) {
    const hr = hdr.getBoundingClientRect();
    const inBar = r => r.top < hr.bottom && r.bottom > hr.top;

    /* A control's REAL tap area, pseudo elements included.
       getBoundingClientRect only measures the element's own box, so the very
       common "keep the icon small, expand the hit area with an absolutely
       positioned ::after" pattern reads as a 24px target when the finger
       actually gets 44px. That produced a false header.tap warning on every
       page of a client site on 10 Sep 2026, measured and disproved with
       elementFromPoint. Walk outwards from the centre instead, and count any
       point that hit tests back to this element. */
    const hitSize = el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { w: 0, h: 0 };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      /* the point must land on the control itself or something inside it.
         An ancestor (the header bar's own background) does NOT count, or every
         control measures as wide as the header. A CSS pseudo element has no
         node of its own, so a hit on ::after returns the originating element
         and satisfies h === el, which is exactly the case this exists for. */
      const owns = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
      if (!owns(cx, cy)) return { w: Math.round(r.width), h: Math.round(r.height) };
      const LIMIT = 60;                       // never walk further than a sane target
      let t = cy, b = cy, l = cx, rt = cx;
      while (t  > 1 && cy - t  < LIMIT && owns(cx, t  - 1)) t--;
      while (b  < innerHeight - 2 && b  - cy < LIMIT && owns(cx, b  + 1)) b++;
      while (l  > 1 && cx - l  < LIMIT && owns(l  - 1, cy)) l--;
      while (rt < innerWidth  - 2 && rt - cx < LIMIT && owns(rt + 1, cy)) rt++;
      return { w: Math.round(rt - l + 1), h: Math.round(b - t + 1) };
    };
    const box = o => ({ tag: o.el.tagName.toLowerCase(), cls: cls(o.el),
      l: Math.round(o.r.left), r: Math.round(o.r.right), w: Math.round(o.r.width), h: Math.round(o.r.height) });

    /* brand = left-most visible mark OR, when the logo is set as type, the
       left-most link that carries the site name. Both are real Scalus
       patterns, so a text wordmark must not read as "no logo". */
    let marks = [...hdr.querySelectorAll('img,svg,picture')].filter(vis)
      .map(el => ({ el, r: el.getBoundingClientRect() })).filter(o => inBar(o.r));
    let brand = null;
    const brandLink = [...hdr.querySelectorAll('a[class*="brand"],a[class*="logo"],a[href="/"],a[href$="//"]')].filter(vis)
      .map(el => ({ el, r: el.getBoundingClientRect() })).filter(o => inBar(o.r)).sort((a, b) => a.r.left - b.r.left)[0];
    marks.sort((a, b) => a.r.left - b.r.left);
    if (brandLink && (!marks.length || brandLink.r.left <= marks[0].r.left + 2)) brand = brandLink;
    else brand = marks[0] || null;

    /* controls = outermost visible interactive boxes that are NOT the brand
       and are NOT a full-bleed drawer link (an open-menu panel measures the
       whole width and would fake an overlap). */
    let ctrls = [...hdr.querySelectorAll('a,button')].filter(vis)
      .map(el => ({ el, r: el.getBoundingClientRect() })).filter(o => inBar(o.r));
    if (brand) ctrls = ctrls.filter(o => !o.el.contains(brand.el) && !brand.el.contains(o.el) && o.el !== brand.el);
    ctrls = ctrls.filter(o => !ctrls.some(p => p !== o && p.el.contains(o.el)));
    ctrls = ctrls.filter(o => o.r.width < vw * 0.7);

    /* gutters and the collision gap are judged on ink, so padding and stretched
       flex items never fake a pass or a fail */
    const brandInk = brand ? ink(brand.el) : null;
    const ctrlInkRects = ctrls.map(o => ctrlInk(o.el));
    const rightMost = ctrlInkRects.length ? Math.max(...ctrlInkRects.map(r => r.right)) : null;
    const ctrlLeft  = ctrlInkRects.length ? Math.min(...ctrlInkRects.map(r => r.left))  : null;
    header = {
      sel: hdr.tagName.toLowerCase() + (cls(hdr) ? '.' + cls(hdr).trim().split(/\\s+/)[0] : ''),
      height: Math.round(hr.height),
      brand: brand ? { ...box(brand), inkL: Math.round(brandInk.left), inkR: Math.round(brandInk.right) } : null,
      ctrls: ctrls.map(box),
      leftGutter:  brandInk ? Math.round(brandInk.left) : null,
      rightGutter: rightMost !== null ? Math.round(vw - rightMost) : null,
      logoGap: (brandInk && ctrlLeft !== null) ? Math.round(ctrlLeft - brandInk.right) : null,
      minTap: ctrls.length ? Math.round(Math.min(...ctrls.map(o => { const hs = hitSize(o.el); return Math.min(hs.w, hs.h); }))) : null,
      minTapBox: ctrls.length ? Math.round(Math.min(...ctrls.map(o => Math.min(o.r.width, o.r.height)))) : null,
    };
  }
  /* the bar goes back to hiding, so every check after this one sees the page
     exactly as a visitor sitting at the top of it does */
  noAnim.remove();
  chromeOff.forEach(c => document.documentElement.classList.add(c));
  void document.documentElement.offsetHeight;

  /* ---- horizontal overflow, and who caused it ----
     GROUND TRUTH IS THE SCROLL, NOT scrollWidth. body.scrollWidth happily
     reports 420 on a 390 screen while html clips and the page does not move a
     pixel — that false alarm is what made two client sites look broken
     on 7 Sep 2026. So: measure the documentElement (the thing that actually
     scrolls), then confirm by trying to scroll and reading how far it went. */
  const de = document.documentElement;
  /* Three signals, because a phone can express "too wide" in three ways:
       1. the document genuinely scrolls sideways
       2. Chrome widens the layout viewport to swallow the overflow instead of
          scrolling, which is why innerWidth comes back as 520 on a 375 screen
       3. the scroll probe at the bottom of this function actually moves
     Any one of them means the page is wider than the phone. */
  const layoutSpill = Math.max(0, Math.round((window.innerWidth || DEVICE_W) - DEVICE_W));
  const overflow = Math.max(Math.round(de.scrollWidth - de.clientWidth), layoutSpill);
  const spillers = [];
  if (overflow > 2) {
    /* An element hanging past the right edge only drags the DOCUMENT sideways
       when nothing above it clips. A marquee inside overflow:hidden is doing
       exactly what it was built to do, and naming it sends the fix to the
       wrong element — which is how the a client site ticker looked guilty on
       7 Sep 2026 while the real spiller was three rows down the list. */
    const clipped = el => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        const ox = cs.overflowX;
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
          if (p.getBoundingClientRect().right <= vw + 2) return true;
        }
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right <= vw + 2) continue;
      if (getComputedStyle(el).position === 'fixed') continue;
      if (clipped(el)) continue;
      spillers.push({ tag: el.tagName.toLowerCase(), cls: cls(el), over: Math.round(r.right - vw) });
      if (spillers.length >= 6) break;
    }
    // the deepest offenders are the useful ones; a parent only spills because a child does
    spillers.sort((a, b) => a.over - b.over);
  }

  /* Confirm by actually trying to scroll. This runs AFTER the spiller loop on
     purpose: scrolling right moves every getBoundingClientRect and would hide
     the very elements we are trying to name. Restore the position afterwards. */
  const beforeX = window.scrollX;
  window.scrollTo({ left: 99999, top: window.scrollY, behavior: 'instant' });
  const reachedX = Math.round(window.scrollX);
  window.scrollTo({ left: beforeX, top: window.scrollY, behavior: 'instant' });
  const scrolls = Math.max(overflow, reachedX, layoutSpill);

  /* ---- broken images ---- */
  const broken = [...document.images]
    .filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('src'))
    .slice(0, 8).map(i => i.getAttribute('src'));

  /* ---- head basics ---- */
  const meta = n => (document.querySelector('meta[name="' + n + '"]') || {}).content || '';
  const head = {
    title: (document.title || '').trim(),
    description: meta('description').trim(),
    canonical: (document.querySelector('link[rel=canonical]') || {}).href || '',
    viewport: meta('viewport'),
    robots: meta('robots'),
    h1: [...document.querySelectorAll('h1')].filter(vis).length,
    scalusAttribution: /by\\s+scalus|supported by scalus/i.test(document.body.innerText || ''),
  };

  /* ---- Tim's standing rule: no hyphen and no dash in visible copy ---- */
  const dashes = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const skip = /^(script|style|noscript|code|pre)$/i;
  let node;
  while ((node = walk.nextNode())) {
    const p = node.parentElement;
    if (!p || skip.test(p.tagName)) continue;
    if (!p.offsetParent && getComputedStyle(p).position !== 'fixed') continue;
    const t = node.nodeValue;
    if (!t) continue;
    // a dash BETWEEN words is copy; 03-9123 style runs and css-ish tokens are not
    const m = t.match(/[A-Za-z]{2,}\\s*[-\\u2013\\u2014]\\s*[A-Za-z]{2,}/g);
    if (m) for (const hit of m) { if (dashes.length < 12) dashes.push(hit.trim()); }
  }

  /* ---- concentric corners: inner radius = outer radius minus the gap ----
     Raw pairs only. The thresholds live in STANDARD, like every other rule.
     Ported from ~/bin/concentric-check.js so a deploy is gated on the same
     equation the auditor prints. */
  const radius = (() => {
    const pxv = v => parseFloat(v) || 0;
    /* a capsule or a circle is a shape in its own right, never half of a
       concentric pair: pinning its radius to a parent would just un round it */
    const isPill = (rad, w, h) => rad >= Math.min(w, h) / 2 - 1;
    const lab = el => { const c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      return el.tagName.toLowerCase() + (c.length ? '.' + c.slice(0, 2).join('.') : ''); };
    /* getBoundingClientRect is post transform, getComputedStyle is authored, so
       anything inside a scale() has to be converted back or it reads as a false
       violation and the printed number is not the one to type in the CSS */
    const scaleOf = el => { let sx = 1, sy = 1, n = el;
      while (n && n !== document.documentElement) {
        const t = getComputedStyle(n).transform;
        if (t && t !== 'none') { const mx = new DOMMatrixReadOnly(t);
          sx *= Math.hypot(mx.a, mx.b) || 1; sy *= Math.hypot(mx.c, mx.d) || 1; }
        n = n.parentElement; }
      return { sx: sx || 1, sy: sy || 1 }; };
    const info = new Map();
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || pxv(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      const corners = { tl: pxv(cs.borderTopLeftRadius), tr: pxv(cs.borderTopRightRadius),
                        br: pxv(cs.borderBottomRightRadius), bl: pxv(cs.borderBottomLeftRadius) };
      const sc = scaleOf(el);
      info.set(el, { rect: r, corners, sc,
        pill: isPill(Math.max(...Object.values(corners)), r.width / sc.sx, r.height / sc.sy) });
    }
    const CORNERS = [['tl', 'top', 'left'], ['tr', 'top', 'right'], ['br', 'bottom', 'right'], ['bl', 'bottom', 'left']];
    const hits = [];
    for (const [el, child] of info) {
      if (child.pill || Math.max(...Object.values(child.corners)) <= 0) continue;
      let parent = null, pEl = el.parentElement;
      while (pEl) { const p = info.get(pEl);
        if (p && !p.pill && Math.max(...Object.values(p.corners)) > 0) { parent = p; break; }
        pEl = pEl.parentElement; }
      if (!parent) continue;
      const c = child.rect, p = parent.rect;
      /* it has to be nesting, not overlap */
      if (c.left < p.left - 0.5 || c.right > p.right + 0.5) continue;
      if (c.top < p.top - 0.5 || c.bottom > p.bottom + 0.5) continue;
      const sx = child.sc.sx, sy = child.sc.sy;
      const gaps = { top: (c.top - p.top) / sy, left: (c.left - p.left) / sx,
                     right: (p.right - c.right) / sx, bottom: (p.bottom - c.bottom) / sy };
      for (const pair of CORNERS) {
        const corner = pair[0], ga = gaps[pair[1]], gb = gaps[pair[2]];
        /* unequal gaps means the child is not centred into that corner, so no
           single radius can be concentric with it */
        if (Math.abs(ga - gb) > 1.5) continue;
        const gap = (ga + gb) / 2;
        if (gap < 0.5 || gap > 120) continue;
        const outer = parent.corners[corner];
        /* inset further than the parent's curve = two straight edges, nothing
           to be concentric with, free to be shaped however it likes */
        if (outer <= 0 || gap >= outer) continue;
        const actual = child.corners[corner], ideal = Math.max(0, outer - gap);
        /* inset almost to the end of the arc: effectively straight edges, free */
        if (ideal < 3) continue;
        const delta = actual - ideal;
        if (Math.abs(delta) <= 0.5) continue;
        hits.push({ parent: lab(pEl), child: lab(el), corner,
          outer: +outer.toFixed(1), gap: +gap.toFixed(1),
          is: +actual.toFixed(1), should: +ideal.toFixed(1), delta: +delta.toFixed(1) });
      }
    }
    /* one CSS bug paints dozens of corners, so report the shape of the problem */
    const g = new Map();
    for (const h of hits) {
      const k = h.parent + '>' + h.child + '@' + h.outer + '/' + h.gap;
      if (!g.has(k)) g.set(k, Object.assign({}, h, { count: 0 }));
      g.get(k).count++;
    }
    return [...g.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
  })();

  return { vw, layoutW: window.innerWidth, header, overflow: scrolls, spillers, broken, head, radius, dashes: [...new Set(dashes)] };
}`;

/* --------------------------------------------------------------------------
   Verdicts
   -------------------------------------------------------------------------- */
function judge(m, width, consoleErrors) {
  const F = [], W = [];
  const fail = (rule, msg) => F.push({ level: 'FAIL', rule, width, msg });
  const warn = (rule, msg) => W.push({ level: 'WARN', rule, width, msg });

  if (run('header')) {
    const h = m.header;
    if (!h) warn('header.missing', 'no header bar found to measure');
    else if (!h.ctrls.length) warn('header.controls', `no header controls found in ${h.sel}`);
    else {
      const { leftGutter: L, rightGutter: R, logoGap: G, minTap: T } = h;
      if (L !== null && R !== null) {
        if (Math.abs(R - L) > STANDARD.gutterSkew)
          fail('header.gutters', `logo sits ${L}px from the left but the controls stop ${R}px from the right (skew ${Math.abs(R - L)}px, max ${STANDARD.gutterSkew}px). Pin the control cluster to the right edge.`);
        if (Math.min(L, R) < STANDARD.minGutter)
          fail('header.gutters', `header content touches the screen edge (left ${L}px, right ${R}px, min ${STANDARD.minGutter}px)`);
      } else if (R !== null && R < STANDARD.minGutter) {
        fail('header.gutters', `controls stop ${R}px from the right edge (min ${STANDARD.minGutter}px)`);
      }
      if (G !== null && G < STANDARD.minLogoGap)
        fail('header.collision', `only ${G}px between the logo and the first control (min ${STANDARD.minLogoGap}px)${G < 0 ? ' — they overlap' : ''}`);
      if (run('tap') && T !== null && T < STANDARD.minTap)
        warn('header.tap', `smallest header control is ${T}px (target 44px)`);
    }
  }

  if (run('overflow')) {
    if (m.overflow > STANDARD.maxOverflow) {
      const who = m.spillers.map(s => `${s.tag}.${(s.cls || '').split(/\s+/)[0]} (+${s.over}px)`).join(', ');
      fail('overflow', `page scrolls sideways by ${m.overflow}px${who ? ` — ${who}` : ''}`);
    }
  }

  if (run('images') && m.broken.length)
    fail('images.broken', `${m.broken.length} image(s) fail to load: ${m.broken.slice(0, 3).join(', ')}`);

  if (run('console') && consoleErrors.length)
    warn('console', `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 2).join(' | ')}`);

  if (run('head')) {
    const h = m.head;
    if (!h.title) fail('head.title', 'no page title');
    else if (h.title.length > 65) warn('head.title', `title is ${h.title.length} chars (aim under 60)`);
    if (!h.description) fail('head.description', 'no meta description');
    if (!h.viewport) fail('head.viewport', 'no viewport meta, the page cannot be responsive');
    if (!h.canonical) warn('head.canonical', 'no canonical link');
    if (h.h1 === 0) warn('head.h1', 'no visible h1');
    if (h.h1 > 1) warn('head.h1', `${h.h1} visible h1 elements`);
    if (/noindex/i.test(h.robots || '')) warn('head.robots', 'page is noindex');
  }

  if (run('radius') && m.radius && m.radius.length) {
    const say = v => `${v.parent} > ${v.child} ${v.corner} is ${v.is}px, should be ${v.should}px (outer ${v.outer}, gap ${v.gap})`;
    const hard = m.radius.filter(v => Math.abs(v.delta) > STANDARD.radiusFail);
    const soft = m.radius.filter(v => Math.abs(v.delta) > STANDARD.radiusTol && Math.abs(v.delta) <= STANDARD.radiusFail);
    if (hard.length)
      fail('radius.concentric', `${hard.length} nested corner(s) not concentric: ${hard.slice(0, 2).map(say).join(' | ')}. Inner radius = outer radius minus the gap.`);
    if (soft.length)
      warn('radius.concentric', `${soft.length} nested corner(s) off by ${STANDARD.radiusTol} to ${STANDARD.radiusFail}px: ${soft.slice(0, 2).map(say).join(' | ')}`);
  }

  if (run('copy') && m.dashes.length)
    warn('copy.dashes', `hyphen or dash in visible copy: ${m.dashes.slice(0, 4).map(s => `"${s}"`).join(', ')}`);

  return [...F, ...W];
}

/* -------------------------------------------------------------------------- */
async function reviewOne(browser, url) {
  const findings = [];
  const measures = {};
  const views = [
    ...widths.map(w => ({ w, mobile: true })),
    ...(withDesktop ? [{ w: 1440, mobile: false }] : []),
  ];

  for (const v of views) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.mobile ? 844 : 900 },
      deviceScaleFactor: 2, isMobile: v.mobile, hasTouch: v.mobile,
      ...(v.mobile ? { userAgent: IPHONE_UA } : {}),
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', msg => { if (msg.type() === 'error') errs.push(msg.text().slice(0, 120)); });
    page.on('pageerror', e => errs.push(String(e).split('\n')[0].slice(0, 120)));
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (res && res.status() >= 400) findings.push({ level: 'FAIL', rule: 'http', width: v.w, msg: `HTTP ${res.status()}` });
      await page.waitForTimeout(2200);
      // PROBE is a function-expression STRING; Playwright evaluates a string as an
      // expression and drops any arg, so call it inline with the width baked in.
      const m = await page.evaluate(`(${PROBE})(${v.w})`);
      measures[v.w] = m;
      findings.push(...judge(m, v.w, errs));
    } catch (e) {
      findings.push({ level: 'FAIL', rule: 'load', width: v.w, msg: String(e).split('\n')[0].slice(0, 140) });
    }
    await ctx.close();
  }

  // one line per rule, not per width, when both widths say the same thing
  const seen = new Map();
  for (const f of findings) {
    const k = f.rule + '|' + f.msg.replace(/\d+/g, '#');
    if (!seen.has(k)) seen.set(k, { ...f, widths: [f.width] });
    else seen.get(k).widths.push(f.width);
  }
  const merged = [...seen.values()];
  return { url, pass: !merged.some(f => f.level === 'FAIL'), findings: merged, measures };
}

const browser = await chromium.launch({ headless: true });
const results = [];
const queue = [...urls];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let u; (u = queue.shift()); ) {
    const r = await reviewOne(browser, u);
    results.push(r);
    if (!asJson && !quiet) print(r);
  }
}));
await browser.close();

function print(r) {
  const bad = r.findings.filter(f => f.level === 'FAIL');
  const warnings = r.findings.filter(f => f.level === 'WARN');
  const tag = bad.length ? 'FAIL' : (warnings.length ? 'WARN' : ' OK ');
  console.log(`[${tag}] ${r.url}`);
  for (const f of [...bad, ...warnings]) console.log(`       ${f.level}  ${f.rule}  ${f.msg}  (@${f.widths.join('/')})`);
}

results.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
if (asJson) console.log(JSON.stringify({ standard: STANDARD, results }, null, 2));
else if (!quiet) {
  const failed = results.filter(r => !r.pass);
  console.log(`\nSRA :: ${results.length} page(s), ${results.length - failed.length} passed, ${failed.length} failed`);
}
process.exit(results.some(r => !r.pass) ? 1 : 0);
