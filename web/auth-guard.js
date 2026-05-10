/**
 * DGA Capital — auth guard for portfolio.dgacapital.com dashboards
 * =================================================================
 *
 * Each role-specific dashboard (/gp, /lp) loads this script in <head>
 * (so it runs before the body renders). It:
 *
 *   1. Sets window.PAGE_ROLE = 'gp' | 'lp' inline BEFORE this script
 *      is loaded, so we know what role this page expects.
 *   2. Reads the v2 token from sessionStorage.
 *   3. If missing → redirects to /  (login).
 *   4. Verifies the token with /api/auth/v2/me. If invalid or expired,
 *      clears it and redirects to /.
 *   5. If the user's role doesn't match the page, redirects to the
 *      correct dashboard (e.g. LP visiting /gp → bounced to /lp).
 *   6. Exposes window.DGA_USER = { lp_id, name, email, role,
 *      fund_memberships, managed_account_ids, must_change_password }.
 *   7. Adds a floating role badge + logout button to the top-right
 *      corner once the DOM is ready.
 *   8. Exposes window.dgaFetch(path, opts) — wrapped fetch that
 *      automatically sends x-auth-v2-token. Use this for any API
 *      call from inside the dashboards.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'dga_v2_token';
  var USER_KEY  = 'dga_v2_user';

  var token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.replace('/');
    return;
  }

  // Wrapped fetch that auto-includes the v2 token. Use everywhere.
  window.dgaFetch = function (path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, {
      'x-auth-v2-token': sessionStorage.getItem(TOKEN_KEY) || '',
    });
    return fetch(path, opts);
  };

  // Hydrate the cached user record while we wait for /me to confirm
  try {
    var cached = sessionStorage.getItem(USER_KEY);
    if (cached) window.DGA_USER = JSON.parse(cached);
  } catch (_) {}

  // Verify token + role async. If anything fails, fall back to /.
  (async function () {
    try {
      var r = await window.dgaFetch('/api/auth/v2/me');
      if (!r.ok) throw new Error('me ' + r.status);
      var me = await r.json();
      window.DGA_USER = me;
      sessionStorage.setItem(USER_KEY, JSON.stringify(me));

      var expected = (window.PAGE_ROLE || '').toLowerCase();
      if (expected && me.role !== expected) {
        // Wrong dashboard for this role → bounce to the right one
        window.location.replace(me.role === 'gp' ? '/gp' : '/lp');
        return;
      }

      // Once DOM is parsed, inject the role badge + logout
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderRoleBar);
      } else {
        renderRoleBar();
      }
    } catch (err) {
      console.warn('[auth-guard] verification failed:', err);
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
      window.location.replace('/');
    }
  })();

  function renderRoleBar() {
    if (document.getElementById('dga-role-bar')) return;
    var me = window.DGA_USER || {};
    var bar = document.createElement('div');
    bar.id = 'dga-role-bar';
    bar.innerHTML = ''
      + '<style>'
      + '#dga-role-bar { position: fixed; top: 13px; right: 22px; z-index: 9999; '
      + '  display: flex; gap: 9px; align-items: center; pointer-events: none; }'
      + '#dga-role-bar > * { pointer-events: auto; }'
      + '#dga-role-bar .rb-name { '
      + '  background: rgba(10,22,40,0.85); color: rgba(255,255,255,0.85); '
      + '  border: 1px solid rgba(255,255,255,0.15); '
      + '  padding: 6px 11px; border-radius: 6px; font-size: 11px; font-weight: 700; '
      + '  letter-spacing: 0.6px; backdrop-filter: blur(6px); }'
      + '#dga-role-bar .rb-badge { '
      + '  font-size: 10px; font-weight: 800; letter-spacing: 1.4px; '
      + '  padding: 6px 12px; border-radius: 6px; text-transform: uppercase; '
      + '  backdrop-filter: blur(6px); box-shadow: 0 2px 10px rgba(0,0,0,0.30); }'
      + '#dga-role-bar .rb-badge.gp { background: rgba(91,184,212,0.90); color: #0A1628; border: 1px solid #84CCE3; }'
      + '#dga-role-bar .rb-badge.lp { background: rgba(10,22,40,0.90); color: #5BB8D4; border: 1px solid rgba(91,184,212,0.50); }'
      + '#dga-role-bar .rb-logout { '
      + '  background: rgba(10,22,40,0.85); color: rgba(255,255,255,0.85); '
      + '  border: 1px solid rgba(255,255,255,0.18); '
      + '  padding: 6px 12px; border-radius: 6px; font-size: 10px; font-weight: 700; '
      + '  letter-spacing: 1.4px; cursor: pointer; text-transform: uppercase; '
      + '  transition: background .15s, border-color .15s; backdrop-filter: blur(6px); }'
      + '#dga-role-bar .rb-logout:hover { background: rgba(239,68,68,0.20); border-color: rgba(239,68,68,0.55); color: #fca5a5; }'
      + '</style>'
      + '<span class="rb-name">' + escapeHtml(me.name || '') + '</span>'
      + '<span class="rb-badge ' + (me.role || '') + '">'
      +   (me.role === 'gp' ? '⚡ GP MODE' : '🔒 LP MODE')
      + '</span>'
      + '<button class="rb-logout" id="dga-logout-btn">LOGOUT</button>';
    document.body.appendChild(bar);
    document.getElementById('dga-logout-btn').addEventListener('click', logout);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c];
    });
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    window.location.replace('/');
  }

  // Expose for explicit calls from dashboard code
  window.dgaLogout = logout;
})();
