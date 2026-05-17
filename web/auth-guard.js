/**
 * DGA Capital — auth guard for portfolio.dgacapital.com dashboards
 * =================================================================
 *
 * Loaded from <head> on /gp and /lp before the body renders. Responsibilities:
 *
 *   1. Each page sets window.PAGE_ROLE = 'gp' | 'lp' inline before this
 *      script runs.
 *   2. Read the v2 token from localStorage (cached across browser sessions
 *      until LOGOUT clears it or the 12h server TTL expires).
 *   3. If missing → redirect to /  (login).
 *   4. Verify the token with /api/auth/v2/me. If invalid/expired, clear
 *      and redirect to /.
 *   5. If the user's role doesn't match the page, redirect them to the
 *      correct dashboard (e.g. LP visiting /gp → bounced to /lp).
 *   6. Expose window.DGA_USER  and window.dgaFetch(path, opts).
 *   7. Inject the role bar INTO the existing .topbar-right container
 *      (so it lives in the natural flow and doesn't overlap the nav
 *      links underneath). If the page has no .topbar-right (e.g. a
 *      future minimal layout), fall back to fixed-position top-right.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'dga_v2_token';
  var USER_KEY  = 'dga_v2_user';

  // Migrate any sessionStorage token from the previous build so users
  // don't get bumped back to the login screen.
  try {
    var legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy && !localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, legacy);
      var legacyUser = sessionStorage.getItem(USER_KEY);
      if (legacyUser) localStorage.setItem(USER_KEY, legacyUser);
    }
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  } catch (_) {}

  var token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.replace('/');
    return;
  }

  // Wrapped fetch that auto-includes the v2 token. Use everywhere.
  window.dgaFetch = function (path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, {
      'x-auth-v2-token': localStorage.getItem(TOKEN_KEY) || '',
    });
    return fetch(path, opts);
  };

  // Hydrate the cached user record while we wait for /me to confirm
  try {
    var cached = localStorage.getItem(USER_KEY);
    if (cached) window.DGA_USER = JSON.parse(cached);
  } catch (_) {}

  // Verify token + role async. If anything fails, fall back to /.
  (async function () {
    try {
      var r = await window.dgaFetch('/api/auth/v2/me');
      if (!r.ok) throw new Error('me ' + r.status);
      var me = await r.json();
      window.DGA_USER = me;
      localStorage.setItem(USER_KEY, JSON.stringify(me));

      var expected = (window.PAGE_ROLE || '').toLowerCase();
      if (expected && me.role !== expected) {
        // Admin can visit both /gp and /lp — never bounce them
        if (me.role === 'admin') {
          // fall through — admin is allowed everywhere
        } else {
          // Wrong dashboard for this role → bounce to the right one
          window.location.replace(me.role === 'gp' ? '/gp' : '/lp');
          return;
        }
      }

      // Once DOM is parsed, inject the role bar + handle must_change prompt
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          renderRoleBar();
          _handleMustChange(me);
          if (me.impersonated) _renderImpersonationBanner(me);
        });
      } else {
        renderRoleBar();
        _handleMustChange(me);
        if (me.impersonated) _renderImpersonationBanner(me);
      }
    } catch (err) {
      console.warn('[auth-guard] verification failed:', err);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.replace('/');
    }
  })();

  function renderRoleBar() {
    if (document.getElementById('dga-role-bar')) return;
    var me = window.DGA_USER || {};

    // Inject styles once
    if (!document.getElementById('dga-role-bar-styles')) {
      var st = document.createElement('style');
      st.id = 'dga-role-bar-styles';
      st.textContent = [
        '.dga-role-group {',
        '  display: inline-flex; align-items: center; gap: 8px;',
        '  margin-left: 8px;',
        '}',
        '.dga-rb-name {',
        '  color: #475569;',
        '  font-size: 11px; font-weight: 700;',
        '  letter-spacing: 0.5px;',
        '  padding: 4px 9px;',
        '  background: rgba(0,0,0,0.05);',
        '  border-radius: 5px;',
        '  white-space: nowrap;',
        '}',
        '.dga-rb-badge {',
        '  font-size: 9px; font-weight: 800;',
        '  letter-spacing: 1.3px;',
        '  padding: 4px 9px;',
        '  border-radius: 5px;',
        '  text-transform: uppercase;',
        '  white-space: nowrap;',
        '}',
        '.dga-rb-badge.gp {',
        '  background: #5BB8D4;',
        '  color: #0A1628;',
        '  box-shadow: 0 0 6px rgba(91,184,212,0.30);',
        '}',
        '.dga-rb-badge.lp {',
        '  background: rgba(91,184,212,0.12);',
        '  color: #2d7d96;',
        '  border: 1px solid rgba(91,184,212,0.30);',
        '}',
        '.dga-rb-badge.admin {',
        '  background: linear-gradient(135deg, #c9a84c, #d9bc76);',
        '  color: #0A1628;',
        '  box-shadow: 0 0 8px rgba(201,168,76,0.40);',
        '}',
        '.dga-rb-switch {',
        '  background: transparent;',
        '  color: #5BB8D4;',
        '  border: 1px solid rgba(91,184,212,0.40);',
        '  padding: 4px 10px; border-radius: 5px;',
        '  font-size: 10px; font-weight: 700;',
        '  letter-spacing: 1.1px; cursor: pointer;',
        '  text-transform: uppercase;',
        '  transition: background .15s, color .15s, border-color .15s;',
        '}',
        '.dga-rb-switch:hover { background: rgba(91,184,212,0.12); }',
        '.dga-rb-logout {',
        '  background: transparent;',
        '  color: #64748b;',
        '  border: 1px solid #e2e8f0;',
        '  padding: 4px 10px; border-radius: 5px;',
        '  font-size: 10px; font-weight: 700;',
        '  letter-spacing: 1.3px; cursor: pointer;',
        '  text-transform: uppercase;',
        '  transition: background .15s, color .15s, border-color .15s;',
        '}',
        '.dga-rb-logout:hover { background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.40); color: #dc2626; }',
        // Fixed-position fallback (only used when no .topbar-right found)
        '#dga-role-bar.dga-rb-floating {',
        '  position: fixed; top: 13px; right: 22px; z-index: 9999;',
        '  display: flex; gap: 9px; align-items: center; pointer-events: none;',
        '}',
        '#dga-role-bar.dga-rb-floating > * { pointer-events: auto; }',
      ].join('\n');
      document.head.appendChild(st);
    }

    // Build the group element
    var role = me.role || '';
    var badgeLabel = role === 'gp' ? '⚡ GP' : role === 'admin' ? '⚡ ADMIN' : '🔒 LP';
    var switchBtn  = '';
    if (role === 'admin') {
      var curPage = (window.PAGE_ROLE || 'gp').toLowerCase();
      var switchTarget = curPage === 'gp' ? '/lp' : '/gp';
      var switchLabel  = curPage === 'gp' ? 'VIEW: LP' : 'VIEW: GP';
      switchBtn = '<button class="dga-rb-switch" id="dga-switch-btn" title="Switch dashboard view">'
                + switchLabel + '</button>';
    }
    var group = document.createElement('span');
    group.id = 'dga-role-bar';
    group.className = 'dga-role-group';
    group.innerHTML = ''
      + '<span class="dga-rb-name">' + escapeHtml(getInitials(me.name || '')) + '</span>'
      + '<span class="dga-rb-badge ' + role + '">' + badgeLabel + '</span>'
      + switchBtn
      + '<button class="dga-rb-logout" id="dga-logout-btn" title="Sign out">LOGOUT</button>';

    // Try to inject into the topbar's right side so it lives in the natural
    // flow and doesn't overlap the nav links. Insert BEFORE the status-dot
    // (if present) so the green health indicator stays last.
    var hostCandidates = [
      document.querySelector('.topbar-right'),
      document.querySelector('.topbar nav'),
      document.querySelector('.topbar'),
    ];
    var host = hostCandidates.find(Boolean);

    if (host) {
      // Insert just before the status dot (which is the last element)
      var statusDot = host.querySelector('.status-dot');
      if (statusDot) host.insertBefore(group, statusDot);
      else host.appendChild(group);
    } else {
      // No topbar found — float it as before
      group.classList.add('dga-rb-floating');
      document.body.appendChild(group);
    }
    document.getElementById('dga-logout-btn').addEventListener('click', logout);
    var switchEl = document.getElementById('dga-switch-btn');
    if (switchEl) {
      switchEl.addEventListener('click', function () {
        var curPage = (window.PAGE_ROLE || 'gp').toLowerCase();
        window.location.href = curPage === 'gp' ? '/lp' : '/gp';
      });
    }
  }

  function _renderImpersonationBanner(me) {
    if (document.getElementById('dga-imp-banner')) return;
    var st = document.createElement('style');
    st.textContent = [
      '#dga-imp-banner {',
      '  position: fixed; top: 0; left: 0; right: 0; z-index: 99999;',
      '  background: #78350f;',
      '  border-bottom: 2px solid #f59e0b;',
      '  color: #fde68a;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 12px; font-weight: 700;',
      '  letter-spacing: 0.3px;',
      '  padding: 7px 16px;',
      '  text-align: center;',
      '  pointer-events: none;',
      '}',
      'body { padding-top: 34px !important; }',
    ].join('\n');
    document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.id = 'dga-imp-banner';
    bar.textContent = '👁  Admin preview — viewing as ' + escapeHtml(me.name || me.email || 'LP') + '  ·  Read-only impersonation session';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function _handleMustChange(me) {
    // If the server flagged must_change_password and we're on the LP page,
    // surface a non-blocking notification banner pointing to Account tab.
    // The LP page's own init code handles the tab redirect.
    if (!me.must_change_password) return;
    if ((window.PAGE_ROLE || '') !== 'lp') return;
    // LP page _checkMustChange() handles the tab switch — nothing more to do here.
  }

  function getInitials(name) {
    return name.split(/\s+/).filter(Boolean).map(function (w) {
      return w[0].toUpperCase();
    }).join('').slice(0, 2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c];
    });
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    window.location.replace('/');
  }

  window.dgaLogout = logout;
})();
