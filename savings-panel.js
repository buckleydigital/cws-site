/* =====================================================================
   SAVINGS ESTIMATE PANEL — NEW, ADDITIVE LOGIC ONLY
   ---------------------------------------------------------------------
   This file is entirely new and self-contained. It does NOT modify,
   wrap, or re-implement any existing survey function (goToStep,
   pickOwner, pickBill, pickTimeline, submitPostcode, submitForm, ...).

   It works purely by:
     1. OBSERVING which `.step` is active (MutationObserver, read-only).
     2. READING the existing global `formData` object the survey already
        populates (avg_quarterly_bill, purchase_timeline, postcode).
     3. INJECTING its own DOM (a side panel + a mobile banner/sheet) and
        APPENDING copy to the live progress indicator.

   Nothing here touches the survey question markup, the step order, the
   form fields, or the submit pipeline.
   ===================================================================== */
(function () {
  'use strict';

  /* ── Estimate data, keyed by quarterly bill tier ── */
  var TIERS = {
    t1: { low: 900,  high: 1200, kw: 6.6,  tenYr: 9000  },
    t2: { low: 1400, high: 1800, kw: 6.6,  tenYr: 14000 },
    t3: { low: 1800, high: 2400, kw: 10,   tenYr: 18000 },
    t4: { low: 2400, high: 3200, kw: 13.3, tenYr: 24000 }
  };
  var PAYBACK = '3–5 yrs';

  /* Feed-in tariff by postcode first digit → [state, display string] */
  var FIT = {
    '2': ['NSW', '~5c'],
    '3': ['VIC', '~4.9c'],
    '4': ['QLD', '~6.7c'],
    '5': ['SA',  '~3c'],
    '6': ['WA',  '~2.75c'],
    '7': ['TAS', '~8.9c']
  };

  /* Map the survey's bill value to a tier. Tolerant of suffixes (e.g.
     "/quarter") so it stays correct; returns null for anything that is
     not one of the four quarterly residential tiers (e.g. business
     monthly bills) — in which case the panel simply stays a teaser. */
  function tierFromBill(bill) {
    if (!bill) return null;
    var b = String(bill);
    if (b.indexOf('Under $300') !== -1) return 't1';
    if (b.indexOf('$300') !== -1 && b.indexOf('$500') !== -1) return 't2';
    if (b.indexOf('$500') !== -1 && b.indexOf('$800') !== -1) return 't3';
    if (b.indexOf('$800') !== -1) return 't4';
    return null;
  }

  /* ── Formatting helpers ── */
  function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-AU'); }
  function fmtKw(n)    { return (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)) + 'kW'; }

  /* Count-up animation. `fmt` turns the running number into display text. */
  function countUp(el, to, fmt) {
    if (!el) return;
    var dur = 850, start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = fmt(to * eased);
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = fmt(to);
    }
    requestAnimationFrame(frame);
  }

  /* SVG check icon used on the appended fact lines */
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  /* ── Build the desktop panel DOM ── */
  function buildPanel() {
    var panel = document.createElement('aside');
    panel.className = 'sv-panel';
    panel.id = 'svPanel';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML =
      '<div class="sv-eyebrow"><span class="sv-dot"></span>Live Savings Estimate</div>' +
      '<div class="sv-teaser" id="svTeaser">Complete the quiz to see your estimated savings</div>' +
      '<div class="sv-figure" id="svFigure" hidden>' +
        '<div class="sv-saving-label">Estimated annual saving</div>' +
        '<div class="sv-saving-range">' +
          '<span id="svLow">$0</span>' +
          '<span class="sv-dash">–</span>' +
          '<span id="svHigh">$0</span>' +
          '<span class="sv-per">/yr</span>' +
        '</div>' +
        '<div class="sv-stats">' +
          '<div class="sv-stat"><div class="sv-stat-v" id="svSystem">–</div><div class="sv-stat-l">System size</div></div>' +
          '<div class="sv-stat"><div class="sv-stat-v">' + PAYBACK + '</div><div class="sv-stat-l">Payback period</div></div>' +
          '<div class="sv-stat"><div class="sv-stat-v" id="svTenYr">$0</div><div class="sv-stat-l">10-year return</div></div>' +
        '</div>' +
        '<div class="sv-extra" id="svStc" hidden>' + CHECK_SVG +
          '<span><strong>STC rebates currently available</strong> — your installer will confirm your eligibility</span>' +
        '</div>' +
        '<div class="sv-extra" id="svFit" hidden>' + CHECK_SVG + '<span></span></div>' +
      '</div>' +
      '<div class="sv-disclaimer">Estimates based on typical Australian households. Your installer will confirm exact figures.</div>';
    return panel;
  }

  /* ── Build the mobile banner + sheet DOM ── */
  function buildMobile() {
    var bar = document.createElement('div');
    bar.className = 'sv-mbar';
    bar.id = 'svMbar';
    bar.innerHTML =
      '<div class="sv-mbar-text">Est. saving: <strong id="svMbarNum">~$0/yr</strong></div>' +
      '<button type="button" class="sv-mbar-btn" id="svMbarBtn">View breakdown</button>';

    var sheet = document.createElement('div');
    sheet.className = 'sv-sheet';
    sheet.id = 'svSheet';
    sheet.innerHTML =
      '<div class="sv-sheet-backdrop" id="svSheetBackdrop"></div>' +
      '<div class="sv-sheet-card">' +
        '<div class="sv-sheet-grab"></div>' +
        '<button type="button" class="sv-sheet-close" id="svSheetClose" aria-label="Close">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</button>' +
        '<div id="svSheetBody"></div>' +
      '</div>';

    return { bar: bar, sheet: sheet };
  }

  /* ── State ── */
  var maxStep = 1;          // highest step reached (so reveals never regress)
  var lastTier = null;      // last rendered tier (re-animate only on change)
  var els = {};             // cached element refs

  function $(id) { return document.getElementById(id); }

  /* Determine the currently-active step number from the DOM (read-only). */
  function activeStep() {
    for (var i = 1; i <= 5; i++) {
      var s = $('step' + i);
      if (s && s.classList.contains('active')) return i;
    }
    return 1;
  }

  /* Append the "calculating" copy to the live progress indicator without
     altering the underlying step logic. updateProgress() rewrites this
     element on each navigation, so we re-append after it has run. */
  function decorateProgress(step) {
    var pc = $('progressCount');
    if (!pc) return;
    var suffix = ' · Calculating your savings…';
    if (step >= 2) {
      if (pc.textContent.indexOf(suffix) === -1) pc.textContent += suffix;
    }
  }

  /* Inject the savings summary above the Step 5 contact form (additive —
     it is prepended as a new first child of #step5 and never touches the
     existing fields or the submit button). */
  function ensureStep5Summary(tier) {
    var step5 = $('step5');
    if (!step5 || !tier) return;
    var box = $('svStep5');
    if (!box) {
      box = document.createElement('div');
      box.className = 'sv-step5';
      box.id = 'svStep5';
      box.innerHTML =
        '<div class="sv-step5-head">Your estimate is ready — get a real quote to confirm it</div>' +
        '<div class="sv-step5-grid">' +
          '<div class="sv-s5-item"><span class="sv-s5-v sv-s5-accent" id="svS5Saving"></span><span class="sv-s5-l">Annual saving</span></div>' +
          '<div class="sv-s5-item"><span class="sv-s5-v" id="svS5System"></span><span class="sv-s5-l">System size</span></div>' +
          '<div class="sv-s5-item"><span class="sv-s5-v" id="svS5Payback">' + PAYBACK + '</span><span class="sv-s5-l">Payback</span></div>' +
          '<div class="sv-s5-item"><span class="sv-s5-v" id="svS5TenYr"></span><span class="sv-s5-l">10-yr return</span></div>' +
        '</div>' +
        '<div class="sv-step5-extra">' +
          '<div id="svS5Stc"><strong>STC rebates currently available</strong> — your installer will confirm your eligibility</div>' +
          '<div id="svS5Fit" hidden></div>' +
        '</div>';
      step5.insertBefore(box, step5.firstChild);
    }
    var t = TIERS[tier];
    $('svS5Saving').textContent = '~' + fmtMoney(t.low) + '–' + fmtMoney(t.high) + '/yr';
    $('svS5System').textContent = '~' + fmtKw(t.kw);
    $('svS5TenYr').textContent  = fmtMoney(t.tenYr);

    var fitEl = $('svS5Fit');
    var fit = fitInfo();
    if (fit) {
      fitEl.innerHTML = 'Feed-in tariff in <strong>' + fit[0] + '</strong>: ' + fit[1] + '/kWh applies to your excess solar';
      fitEl.hidden = false;
    } else {
      fitEl.hidden = true;
    }
  }

  /* Resolve feed-in info from the postcode the survey stored. */
  function fitInfo() {
    var pc = (window.formData && window.formData.postcode) ||
             (($('postcode') || {}).value) || '';
    pc = String(pc).trim();
    if (!/^\d/.test(pc)) return null;
    return FIT[pc.charAt(0)] || null;
  }

  /* ── Core render: reflect current progress in the panel ── */
  function render() {
    var step = activeStep();
    if (step > maxStep) maxStep = step;
    decorateProgress(step);

    var tier = tierFromBill(window.formData && window.formData.avg_quarterly_bill);

    // The estimate is revealed once the bill step is complete (step 3+).
    var showFigure = tier && maxStep >= 3;

    if (!showFigure) {
      els.figure.hidden = true;
      els.teaser.hidden = false;
      els.mbar.classList.remove('sv-active');
      return;
    }

    els.teaser.hidden = true;
    els.figure.hidden = false;

    var t = TIERS[tier];

    // Animate the headline numbers on first appearance or when the tier changes.
    if (tier !== lastTier) {
      countUp($('svLow'),  t.low,   function (v) { return '~' + fmtMoney(v); });
      countUp($('svHigh'), t.high,  function (v) { return fmtMoney(v); });
      countUp($('svTenYr'), t.tenYr, function (v) { return fmtMoney(v); });
      countUp($('svSystem'), t.kw,  function (v) { return '~' + fmtKw(v); });
      lastTier = tier;
    }

    // STC line appears after the timeline step (step 4+).
    $('svStc').hidden = !(maxStep >= 4);

    // Feed-in line appears after the postcode step (step 5+); skipped
    // silently when the postcode prefix is unrecognised.
    var fit = (maxStep >= 5) ? fitInfo() : null;
    var fitEl = $('svFit');
    if (fit) {
      fitEl.querySelector('span').innerHTML =
        'Feed-in tariff in <strong>' + fit[0] + '</strong>: ' + fit[1] + '/kWh applies to your excess solar';
      fitEl.hidden = false;
    } else {
      fitEl.hidden = true;
    }

    // Mobile headline (upper end of the saving range).
    $('svMbarNum').textContent = '~' + fmtMoney(t.high) + '/yr';
    els.mbar.classList.add('sv-active');

    // Step 5 in-form summary.
    if (maxStep >= 5) ensureStep5Summary(tier);
  }

  /* ── Mobile sheet open/close: clones the current desktop figure ── */
  function openSheet() {
    var body = $('svSheetBody');
    var fig = $('svFigure');
    if (!body || !fig) return;
    body.innerHTML =
      '<div class="sv-eyebrow"><span class="sv-dot"></span>Live Savings Estimate</div>' +
      fig.outerHTML.replace('hidden=""', '').replace(/id="[^"]*"/g, '') +
      '<div class="sv-disclaimer">Estimates based on typical Australian households. Your installer will confirm exact figures.</div>';
    var clone = body.querySelector('.sv-figure');
    if (clone) clone.hidden = false;
    $('svSheet').classList.add('sv-open');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('svSheet').classList.remove('sv-open');
    document.body.style.overflow = '';
  }

  /* ── Init ── */
  function init() {
    var wrap = document.querySelector('.survey-wrap');
    if (!wrap || !document.getElementById('step1')) return; // not a survey page

    // Inject DOM
    wrap.appendChild(buildPanel());
    var mob = buildMobile();
    document.body.appendChild(mob.bar);
    document.body.appendChild(mob.sheet);

    els.panel  = $('svPanel');
    els.teaser = $('svTeaser');
    els.figure = $('svFigure');
    els.mbar   = $('svMbar');

    // Wire mobile sheet controls
    $('svMbarBtn').addEventListener('click', openSheet);
    $('svSheetClose').addEventListener('click', closeSheet);
    $('svSheetBackdrop').addEventListener('click', closeSheet);

    // Observe step activation (read-only) — fires after the survey's own
    // navigation + updateProgress() have run synchronously.
    var observer = new MutationObserver(function () { render(); });
    for (var i = 1; i <= 5; i++) {
      var s = $('step' + i);
      if (s) observer.observe(s, { attributes: true, attributeFilter: ['class'] });
    }

    // The postcode is captured during step 4's async lookup; re-render a
    // moment after the contact step appears so the feed-in line resolves.
    var s5 = $('step5');
    if (s5) {
      new MutationObserver(function () {
        if (s5.classList.contains('active')) setTimeout(render, 50);
      }).observe(s5, { attributes: true, attributeFilter: ['class'] });
    }

    render(); // initial teaser state
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
