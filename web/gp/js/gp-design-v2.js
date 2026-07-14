/* Design v2 delight layer — toast, theme, ticker tape */
(function() {
  // ── Toast system ───────────────────────────────────────────────────
  const ICONS = { success:'✓', error:'⚠', warn:'!', info:'ⓘ', default:'' };
  function _typeFromMsg(s) {
    const t = String(s || '').toLowerCase();
    if (t.includes('fail') || t.includes('error') || t.includes('❌') || t.startsWith('⚠')) return 'error';
    if (t.includes('warn') || t.includes('⚠'))   return 'warn';
    if (t.includes('saved') || t.includes('✓') || t.includes('success') || t.includes('done')) return 'success';
    return 'info';
  }
  window.toast = function(message, opts) {
    const root = document.getElementById('toast-root');
    if (!root) { return; }
    const type = (opts && opts.type) || _typeFromMsg(message);
    const ttl  = (opts && opts.ttl)  || 4200;
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    const icon = ICONS[type] || ICONS.default;
    el.innerHTML =
      '<span class="toast-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="toast-msg"></span>' +
      '<button class="toast-close" aria-label="Dismiss">✕</button>';
    el.querySelector('.toast-msg').textContent = String(message);
    el.querySelector('.toast-close').addEventListener('click', () => _dismiss(el));
    root.appendChild(el);
    let timer = setTimeout(() => _dismiss(el), ttl);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(() => _dismiss(el), 2000); });
  };
  function _dismiss(el) {
    el.classList.add('toast-out');
    setTimeout(() => { try { el.remove(); } catch {} }, 260);
  }

  // ── alert() override: route 60+ legacy calls through toasts ────────
  // Preserves original alert via window._nativeAlert for any caller that
  // really needs blocking behavior. confirm() and prompt() stay native
  // because they need return values.
  if (!window._nativeAlert) {
    window._nativeAlert = window.alert.bind(window);
    window.alert = function(msg) {
      try { window.toast(msg); } catch { window._nativeAlert(msg); }
    };
  }

  // ── Dark mode ──────────────────────────────────────────────────────
  const THEME_KEY = 'dga_theme';
  function getTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'dark' || v === 'light') return v;
    } catch {}
    // Light terminal is the product default (user preference 2026-07-13)
    return 'light';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = (t === 'dark') ? '☀️' : '🌙';
      btn.title = 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' mode';
    }
  }
  // Apply ASAP — before any pixels paint — to avoid a light flash on dark
  applyTheme(getTheme());
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = (getTheme() === 'dark') ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch {}
      applyTheme(next);
      try { window.toast(`Switched to ${next} mode`, { type: 'info', ttl: 1800 }); } catch {}
    });
    applyTheme(getTheme());   // re-apply once DOM has the button
  });

  // ── Ticker tape: enable infinite-scroll on the index ribbon once it
  //    has been populated. The ribbon contents get duplicated so the
  //    -50% translate animation creates a seamless loop. Pause on hover.
  function activateTickerTape() {
    const ribbon = document.getElementById('ribbon');
    if (!ribbon || ribbon.dataset.ticker === '1') return;
    const items = Array.from(ribbon.children);
    if (items.length < 4) return;  // not enough to animate
    const track = document.createElement('div');
    track.className = 'ribbon-track';
    items.forEach(it => track.appendChild(it));
    // Duplicate the items for seamless loop
    items.forEach(it => track.appendChild(it.cloneNode(true)));
    ribbon.appendChild(track);
    ribbon.dataset.ticker = '1';
  }
  // Try activating periodically until indices have rendered (poll for ~10s)
  let _tickerTries = 0;
  const _tickerInterval = setInterval(() => {
    activateTickerTape();
    _tickerTries++;
    const ribbon = document.getElementById('ribbon');
    if ((ribbon && ribbon.dataset.ticker === '1') || _tickerTries > 50) {
      clearInterval(_tickerInterval);
    }
  }, 250);

  // ── Helper: render a skeleton block (for callers that want skeletons) ──
  window.dgaSkel = function(rows = 3) {
    let out = '<div class="skel-card">';
    for (let i = 0; i < rows; i++) {
      const widths = ['skel-w-80', 'skel-w-60', 'skel-w-40'];
      const sizes = i === 0 ? 'skel-line-lg' : 'skel-line';
      out += `<div class="skel ${sizes} ${widths[i % widths.length]}"></div>`;
    }
    return out + '</div>';
  };

  // ── Hero helper — inject above tab toolbars if missing ─────────────
  // Tab panels already have h2 in .tab-toolbar; we enrich them with a
  // subtitle on first display. Configured here per tab.
  const HERO_COPY = {
    research:  { title: 'Research',           sub: 'Generate, review, and refresh ticker reports. Pull new ideas from your watchlist, positions, and the morning brief.' },
    builder:   { title: 'Portfolio Builder',  sub: 'Compose a target sleeve from sector weights and conviction filters. Save scenarios to revisit.' },
    lab:       { title: 'LLM Lab',            sub: 'A/B test Grok vs Claude on any saved report and generate podcast episodes from your research.' },
    ideas:     { title: 'Ideas',              sub: 'Daily morning brief, scan results, and market intelligence — the discovery surface.' },
    positions: { title: 'Positions',          sub: 'Live view of every fund and managed-account book. Aggregated and per-LP cuts.' },
    fund:      { title: 'Funds & Accounts',   sub: 'Per-fund overview: NAV, performance, capital flows, and LP roster.' },
    reports:   { title: 'Quarterly Reports',  sub: 'Compose, preview, and send investor letters per fund and per quarter.' },
    memos:     { title: 'DGA Capital Memos',  sub: 'PDF memos generated from your podcast scripts — assign to an account, attach a GP note, email it out.' },
    settings:  { title: 'Settings',           sub: 'Account, automation, distribution, and compliance configuration.' },
  };
  function _injectHero() {
    document.querySelectorAll('.tab-panel').forEach(panel => {
      const id = (panel.id || '').replace(/^tab-/, '');
      const copy = HERO_COPY[id];
      if (!copy) return;
      const toolbar = panel.querySelector('.tab-toolbar');
      if (!toolbar) return;
      if (panel.dataset.hero === '1') return;
      const h2 = toolbar.querySelector('h2');
      const sub = document.createElement('div');
      sub.className = 'hero-sub';
      sub.style.cssText = 'font-size:14.5px;color:var(--text-secondary);line-height:1.6;margin-top:4px;max-width:720px;';
      sub.textContent = copy.sub;
      // Insert subtitle right after the h2 (or after toolbar if no h2)
      if (h2 && h2.nextSibling) toolbar.insertBefore(sub, h2.nextSibling);
      else toolbar.appendChild(sub);
      panel.dataset.hero = '1';
    });
  }
  // Run after a tick so the static markup is parsed; then once more after
  // tab routing JS finishes wiring tabs.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_injectHero, 0);
    setTimeout(_injectHero, 500);
  });

  // ── Onboarding tour ───────────────────────────────────────────────
  // Sequential popovers highlighting the main surfaces. Triggered
  // automatically on first visit (no localStorage flag); can be
  // re-run manually via window.startDGATour() — wired into Settings.
  const TOUR_KEY = 'dga_tour_completed_v1';
  const TOUR_STEPS = [
    { selector: 'header.topbar',
      eyebrow: 'Welcome to DGA Capital',
      title:   "Let's take 30 seconds.",
      body:    "Quick tour of the GP terminal — what each tab does and where to find your work. You can replay this anytime from Settings." },
    { selector: '.topbar-link[data-tab="research"]',
      eyebrow: '① Research',
      title:   'Generate ticker reports',
      body:    'Pull research from Grok and Claude side-by-side. Today\'s movers feed into the Idea Generator on the right.' },
    { selector: '.topbar-link[data-tab="lab"]',
      eyebrow: '② LLM Lab',
      title:   'Turn reports into podcasts',
      body:    'Pick any ticker with both reports, generate a script in your chosen format (Debate, Memo, Catalysts...), then synthesize audio.' },
    { selector: '.topbar-link[data-tab="memos"]',
      eyebrow: '③ Memos',
      title:   'Branded PDF memos',
      body:    'Every podcast script can be exported as a DGA Capital PDF memo — assign to an account, attach a GP note, email it out.' },
    { selector: '.topbar-link[data-tab="positions"]',
      eyebrow: '④ Positions & Fund',
      title:   'Live book + per-fund cuts',
      body:    'See every fund and managed account in one view. Drill into a specific fund from the Fund tab.' },
    { selector: '#theme-toggle',
      eyebrow: '⑤ Make it yours',
      title:   "Dark mode + Settings",
      body:    'Switch themes here. Distribution (RSS), compliance disclaimer, automation schedule, and LP management all live under Settings.' },
    { selector: 'header.topbar',
      eyebrow: '✓ You\'re set',
      title:   "Let's go.",
      body:    "If you ever need to replay this tour, look for the 'Take the tour' button in Settings." },
  ];
  let _tourIdx = 0;
  let _tourCleanup = [];
  function _cleanupTour() {
    _tourCleanup.forEach(fn => { try { fn(); } catch {} });
    _tourCleanup = [];
  }
  function _renderTourStep(idx) {
    _cleanupTour();
    if (idx < 0 || idx >= TOUR_STEPS.length) return _endTour(true);
    _tourIdx = idx;
    const step = TOUR_STEPS[idx];
    const target = document.querySelector(step.selector);
    const backdrop = document.getElementById('tour-backdrop');
    if (backdrop) backdrop.classList.add('active');
    // Highlight target
    if (target) {
      target.classList.add('tour-target-highlight');
      _tourCleanup.push(() => target.classList.remove('tour-target-highlight'));
    }
    // Build popover
    let pop = document.getElementById('tour-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'tour-pop';
      pop.className = 'tour-pop';
      document.body.appendChild(pop);
    }
    pop.innerHTML =
      '<div class="tour-pop-eyebrow"></div>' +
      '<div class="tour-pop-title"></div>' +
      '<div class="tour-pop-body"></div>' +
      '<div class="tour-pop-actions">' +
        '<span class="tour-pop-prog"></span>' +
        '<button class="tour-skip">Skip tour</button>' +
        '<button class="tour-next"></button>' +
      '</div>';
    pop.querySelector('.tour-pop-eyebrow').textContent = step.eyebrow || '';
    pop.querySelector('.tour-pop-title').textContent   = step.title;
    pop.querySelector('.tour-pop-body').textContent    = step.body;
    pop.querySelector('.tour-pop-prog').textContent    = `${idx + 1} / ${TOUR_STEPS.length}`;
    pop.querySelector('.tour-next').textContent = (idx === TOUR_STEPS.length - 1) ? 'Done' : 'Next →';
    pop.querySelector('.tour-skip').onclick = () => _endTour(false);
    pop.querySelector('.tour-next').onclick = () => _renderTourStep(idx + 1);
    // Position pop near target — below by default; flip up if off-screen
    requestAnimationFrame(() => {
      pop.classList.add('active');
      const rect = target ? target.getBoundingClientRect() : null;
      const popRect = pop.getBoundingClientRect();
      let top, left;
      if (rect && rect.height < window.innerHeight / 2) {
        // Try positioning below the target
        top = rect.bottom + 14;
        left = Math.max(16, Math.min(rect.left, window.innerWidth - popRect.width - 16));
        if (top + popRect.height > window.innerHeight - 16) {
          // Flip above
          top = Math.max(16, rect.top - popRect.height - 14);
        }
      } else {
        // Center on screen
        top = Math.max(16, (window.innerHeight - popRect.height) / 2);
        left = Math.max(16, (window.innerWidth - popRect.width) / 2);
      }
      pop.style.top  = top  + 'px';
      pop.style.left = left + 'px';
    });
  }
  function _endTour(completed) {
    _cleanupTour();
    const backdrop = document.getElementById('tour-backdrop');
    if (backdrop) backdrop.classList.remove('active');
    const pop = document.getElementById('tour-pop');
    if (pop) {
      pop.classList.remove('active');
      setTimeout(() => { try { pop.remove(); } catch {} }, 240);
    }
    try { localStorage.setItem(TOUR_KEY, completed ? 'done' : 'skipped'); } catch {}
    if (completed) {
      try { window.toast('Welcome aboard. Replay the tour anytime from Settings.',
                          { type: 'success', ttl: 5000 }); } catch {}
    }
  }
  window.startDGATour = function() {
    // Inject backdrop on demand
    let bd = document.getElementById('tour-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'tour-backdrop';
      document.body.appendChild(bd);
    }
    _renderTourStep(0);
  };
  // Auto-trigger on first visit (post-DOM, post-tabs)
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      try {
        if (!localStorage.getItem(TOUR_KEY)) {
          // Only run for GP / admin (not on LP pages)
          if (window.PAGE_ROLE === 'gp') window.startDGATour();
        }
      } catch {}
    }, 1200);
  });
})();
