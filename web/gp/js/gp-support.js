/* Support tickets FAB + trail */
(function () {
  'use strict';
  // GP-only support widget. LP page never loads this file.
  if ((window.PAGE_ROLE || '') !== 'gp') return;

  const _supErrors = [];
  const _pushErr = (entry) => {
    try {
      _supErrors.push(entry);
      if (_supErrors.length > 25) _supErrors.shift();
    } catch (_) {}
  };
  window.addEventListener('error', (e) => {
    _pushErr({
      type: 'error',
      msg: String((e && e.message) || 'error').slice(0, 400),
      src: String((e && e.filename) || '').slice(0, 200),
      line: e && e.lineno, col: e && e.colno,
      ts: new Date().toISOString(),
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    let msg = '';
    try { msg = String((e && e.reason && (e.reason.message || e.reason)) || e.reason || ''); }
    catch (_) { msg = 'rejection'; }
    _pushErr({ type: 'unhandledrejection', msg: msg.slice(0, 400), ts: new Date().toISOString() });
  });

  let _shotDataUrl = null;
  let _html2canvasLoading = null;

  function _loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_html2canvasLoading) return _html2canvasLoading;
    _html2canvasLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.async = true;
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('Could not load screenshot library'));
      document.head.appendChild(s);
    });
    return _html2canvasLoading;
  }

  function _activeTabId() {
    try {
      const on = document.querySelector('.tab-panel.active, .tab-panel[style*="display: block"], .nav-tab.active, [data-tab].active');
      if (on && on.id) return on.id;
      const visible = Array.from(document.querySelectorAll('.tab-panel')).find(el => {
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      });
      return (visible && visible.id) || '';
    } catch (_) { return ''; }
  }

  async function _captureSupportShot() {
    const meta = document.getElementById('dga-support-shot-meta');
    const prev = document.getElementById('dga-support-shot-preview');
    if (meta) meta.textContent = 'Capturing page…';
    // Hide chrome so the shot is of the app, not the modal/FAB
    const fab = document.getElementById('dga-support-fab');
    const bd = document.getElementById('dga-support-backdrop');
    const fabDisp = fab ? fab.style.display : '';
    const bdDisp = bd ? bd.style.display : '';
    try {
      if (fab) fab.style.display = 'none';
      if (bd) bd.style.visibility = 'hidden';
      const h2c = await _loadHtml2Canvas();
      const canvas = await h2c(document.body, {
        scale: Math.min(1, 1200 / Math.max(document.documentElement.scrollWidth, 1)),
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: document.documentElement.clientWidth,
        windowHeight: Math.min(document.documentElement.scrollHeight, 2400),
      });
      // Downscale / compress for upload budget
      let out = canvas;
      const maxW = 1280;
      if (canvas.width > maxW) {
        const c2 = document.createElement('canvas');
        c2.width = maxW;
        c2.height = Math.round(canvas.height * (maxW / canvas.width));
        const ctx = c2.getContext('2d');
        ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
        out = c2;
      }
      let quality = 0.58;
      let dataUrl = out.toDataURL('image/jpeg', quality);
      // Keep under ~700KB data-url
      while (dataUrl.length > 700000 && quality > 0.28) {
        quality -= 0.08;
        dataUrl = out.toDataURL('image/jpeg', quality);
      }
      _shotDataUrl = dataUrl;
      if (prev) {
        prev.innerHTML = '';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'Page screenshot';
        prev.appendChild(img);
      }
      if (meta) {
        const kb = Math.round((dataUrl.length * 0.75) / 1024);
        meta.textContent = 'Screenshot ready · ~' + kb + ' KB';
      }
      return dataUrl;
    } catch (e) {
      _shotDataUrl = null;
      if (prev) prev.innerHTML = '<div class="shot-ph">Screenshot unavailable — ticket can still be filed.<br>'
        + String((e && e.message) || e).slice(0, 120) + '</div>';
      if (meta) meta.textContent = 'Screenshot skipped';
      return null;
    } finally {
      if (fab) fab.style.display = fabDisp;
      if (bd) bd.style.visibility = bdDisp || '';
    }
  }

  function _openSupportModal() {
    const bd = document.getElementById('dga-support-backdrop');
    const status = document.getElementById('dga-support-status');
    if (status) status.textContent = '';
    if (bd) bd.classList.add('open');
    // Capture after a tick so modal chrome is hidden from shot
    setTimeout(() => { _captureSupportShot(); }, 80);
    const ta = document.getElementById('dga-support-desc');
    if (ta) setTimeout(() => { try { ta.focus(); } catch (_) {} }, 100);
  }

  function _closeSupportModal() {
    const bd = document.getElementById('dga-support-backdrop');
    if (bd) bd.classList.remove('open');
  }

  async function _submitSupportTicket() {
    const ta = document.getElementById('dga-support-desc');
    const status = document.getElementById('dga-support-status');
    const btn = document.getElementById('dga-support-submit');
    const desc = ((ta && ta.value) || '').trim();
    if (desc.length < 8) {
      if (status) status.innerHTML = '<span style="color:#b91c1c;">Please describe the issue in a sentence or two.</span>';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
    if (status) status.textContent = 'Uploading ticket…';
    if (!_shotDataUrl) {
      try { await _captureSupportShot(); } catch (_) {}
    }
    const body = {
      description: desc,
      page_url: location.href,
      page_path: location.pathname + location.search + location.hash,
      active_tab: _activeTabId(),
      user_agent: navigator.userAgent,
      viewport: {
        w: window.innerWidth, h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollY: window.scrollY || 0,
      },
      console_errors: _supErrors.slice(-20),
      context: {
        theme: (document.documentElement.getAttribute('data-theme') || ''),
        title: document.title,
        role: window.PAGE_ROLE || 'gp',
        user: (window.DGA_USER && (window.DGA_USER.email || window.DGA_USER.sub)) || null,
      },
      screenshot_b64: _shotDataUrl || null,
      screenshot_mime: 'image/jpeg',
      priority: 'normal',
    };
    try {
      const r = await window.dgaFetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || j.detail || 'Submit failed');
      if (status) {
        status.innerHTML = '<span style="color:#15803d;">✓ Ticket <code>'
          + (j.id || '') + '</code> filed'
          + (j.has_screenshot ? ' with screenshot' : '')
          + '. Auto-diagnosis running in background. See Settings → Support tickets for the trail.</span>';
      }
      if (window.toast) window.toast('Support ticket ' + (j.id || '') + ' filed', { type: 'success' });
      if (ta) ta.value = '';
      try { _loadSupportTrail(); } catch (_) {}
      setTimeout(_closeSupportModal, 1600);
    } catch (e) {
      if (status) status.innerHTML = '<span style="color:#b91c1c;">❌ '
        + String((e && e.message) || e).slice(0, 200) + '</span>';
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Submit ticket'; }
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function _loadSupportTrail() {
    const box = document.getElementById('support-trail-list');
    const badge = document.getElementById('support-trail-badge');
    if (!box) return;
    try {
      const j = await (await window.dgaFetch('/api/support/tickets?limit=30')).json();
      if (!j.ok) throw new Error(j.error || 'Failed');
      const tickets = j.tickets || [];
      if (badge) {
        badge.textContent = (j.open_count != null ? j.open_count + ' open' : tickets.length + ' total');
        badge.style.background = (j.open_count > 0) ? '#fef3c7' : '#dcfce7';
        badge.style.color = (j.open_count > 0) ? '#92400e' : '#166534';
      }
      if (!tickets.length) {
        box.innerHTML = '<div style="color:#94a3b8;">No tickets yet. Use the 🛟 Support button (bottom-right) when something breaks.</div>';
        return;
      }
      const _fmtPT = (typeof window.fmtDatePT === 'function') ? window.fmtDatePT
        : (typeof window.fmtDate === 'function' ? window.fmtDate
          : (s => {
              try {
                const d = new Date(String(s || '').replace(/\+00:00Z$/, 'Z'));
                if (isNaN(d)) return String(s || '—').slice(0, 16).replace('T', ' ');
                return d.toLocaleString('en-US', {
                  timeZone: 'America/Los_Angeles',
                  month: 'short', day: 'numeric', year: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                }) + ' PT';
              } catch (_) {
                return String(s || '—').slice(0, 16).replace('T', ' ');
              }
            }));
      box.innerHTML = tickets.map(t => {
        const trail = (t.fix_trail || []).slice(-6).reverse();
        const trailHtml = trail.length
          ? trail.map(ev => '<div class="sup-trail-line"><strong>'
            + _esc(_fmtPT(ev.ts)) + '</strong> · '
            + _esc(ev.actor) + ' · <em>' + _esc(ev.action) + '</em>'
            + (ev.detail ? ' — ' + _esc(String(ev.detail).slice(0, 180)) : '')
            + '</div>').join('')
          : '<div class="sup-trail-line">No trail events yet.</div>';
        const diag = t.diagnosis
          ? '<details style="margin-top:8px;"><summary style="cursor:pointer;font-weight:600;color:#334155;">Diagnosis</summary>'
            + '<pre style="white-space:pre-wrap;font-size:11px;margin:6px 0 0;color:#475569;max-height:180px;overflow:auto;">'
            + _esc(t.diagnosis) + '</pre></details>'
          : '';
        const shot = t.has_screenshot
          ? ' · <button type="button" class="sup-view-shot" data-id="' + _esc(t.id)
            + '" style="border:none;background:none;color:#0369a1;cursor:pointer;font-size:11px;padding:0;text-decoration:underline;">screenshot</button>'
          : '';
        const actions = (t.status !== 'fixed' && t.status !== 'closed')
          ? '<div style="margin-top:8px;"><button type="button" class="tab-btn sup-mark-fixed" data-id="'
            + _esc(t.id) + '" style="height:28px;font-size:11px;">Mark fixed</button></div>'
          : (t.fixed_summary
            ? '<div style="margin-top:6px;font-size:11.5px;color:#166534;">✓ ' + _esc(t.fixed_summary) + '</div>'
            : '');
        return '<div class="sup-ticket-card">'
          + '<div><span class="sup-id">' + _esc(t.id) + '</span>'
          + '<span class="sup-status ' + _esc(t.status || '') + '">' + _esc(t.status || '') + '</span>'
          + shot + '</div>'
          + '<div style="margin-top:6px;color:#0f172a;font-weight:600;line-height:1.4;">'
          + _esc((t.description || '').slice(0, 240)) + '</div>'
          + '<div style="margin-top:4px;font-size:11px;color:#94a3b8;">'
          + _esc(_fmtPT(t.created_at))
          + (t.fixed_at ? ' · fixed ' + _esc(_fmtPT(t.fixed_at)) : '')
          + (t.active_tab ? ' · ' + _esc(t.active_tab) : '')
          + (t.page_path ? ' · ' + _esc(t.page_path) : '')
          + '</div>'
          + diag
          + '<div style="margin-top:8px;"><div style="font-size:10.5px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase;color:#94a3b8;margin-bottom:2px;">Fix trail (Pacific)</div>'
          + trailHtml + '</div>'
          + actions
          + '</div>';
      }).join('');
      box.querySelectorAll('.sup-view-shot').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try {
            const r = await window.dgaFetch('/api/support/tickets/' + encodeURIComponent(id) + '/screenshot');
            if (!r.ok) throw new Error('No screenshot');
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank', 'noopener');
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60_000);
          } catch (e) {
            if (window.toast) window.toast('Screenshot unavailable', { type: 'error' });
          }
        });
      });
      box.querySelectorAll('.sup-mark-fixed').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const summary = window.prompt('What fixed it? (short note for the trail)', 'Fixed in latest deploy') || 'Marked fixed';
          try {
            const r = await window.dgaFetch('/api/support/tickets/' + encodeURIComponent(id) + '/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'fixed', fixed_summary: summary }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'Update failed');
            if (window.toast) window.toast('Ticket marked fixed', { type: 'success' });
            _loadSupportTrail();
          } catch (e) {
            if (window.toast) window.toast(String(e.message || e), { type: 'error' });
          }
        });
      });
    } catch (e) {
      box.innerHTML = '<div style="color:#b91c1c;">Could not load tickets: ' + _esc(e.message || e) + '</div>';
    }
  }
  window._loadSupportTrail = _loadSupportTrail;
  window.openDGASupport = _openSupportModal;

  function _wireSupport() {
    const fab = document.getElementById('dga-support-fab');
    const bd = document.getElementById('dga-support-backdrop');
    const cancel = document.getElementById('dga-support-cancel');
    const submit = document.getElementById('dga-support-submit');
    const recap = document.getElementById('dga-support-recapture');
    const fileBtn = document.getElementById('support-trail-file');
    const refresh = document.getElementById('support-trail-refresh');
    if (fab) fab.addEventListener('click', _openSupportModal);
    if (cancel) cancel.addEventListener('click', _closeSupportModal);
    if (bd) bd.addEventListener('click', (e) => { if (e.target === bd) _closeSupportModal(); });
    if (submit) submit.addEventListener('click', _submitSupportTicket);
    if (recap) recap.addEventListener('click', () => _captureSupportShot());
    if (fileBtn) fileBtn.addEventListener('click', _openSupportModal);
    if (refresh) refresh.addEventListener('click', _loadSupportTrail);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && bd && bd.classList.contains('open')) _closeSupportModal();
    });
    // Load trail when settings tab is first shown
    const settingsTab = document.getElementById('tab-settings');
    if (settingsTab) {
      const obs = new MutationObserver(() => {
        if (settingsTab.classList.contains('active') || settingsTab.style.display === 'block') {
          _loadSupportTrail();
        }
      });
      try { obs.observe(settingsTab, { attributes: true, attributeFilter: ['class', 'style'] }); } catch (_) {}
    }
    // Also refresh periodically while on settings
    setTimeout(_loadSupportTrail, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireSupport);
  } else {
    _wireSupport();
  }
})();
