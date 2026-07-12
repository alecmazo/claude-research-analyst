/* Sliw Agent desk UI */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const API_BASE = (window.SLIW_API_BASE || "/api").replace(/\/$/, "");
const TOKEN_KEY = "dga_v2_token";
const USER_KEY = "dga_v2_user";

const state = {
  prospects: [],
  summary: null,
  talent: null,
  outreach: [],
  leads: [],
  briefs: [],
  user: null,
};

/** Ensure DGA portfolio login when hosted on Railway under /sliw */
function ensureAuth() {
  if (!window.SLIW_REQUIRE_DGA_LOGIN) return true;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    // Bounce to portfolio login; return here after login
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace("/?next=" + next);
    return false;
  }
  return true;
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  const v2 = localStorage.getItem(TOKEN_KEY);
  if (v2) h["x-auth-v2-token"] = v2;
  // legacy single-password shell token (if present)
  try {
    const v1 = localStorage.getItem("dga_token") || sessionStorage.getItem("dga_token");
    if (v1) h["x-auth-token"] = v1;
  } catch (_) {}
  return h;
}

const STAGE_ORDER = [
  "research", "scored", "packaged", "drafted", "approved", "contacted",
  "replied", "interested", "discovery_booked", "won", "nurture", "lost",
];

const VIEW_META = {
  dashboard: { title: "Dashboard", eyebrow: "Corporate desk" },
  pipeline: { title: "Pipeline", eyebrow: "Prospect CRM" },
  run: { title: "New outreach", eyebrow: "Run the desk" },
  packages: { title: "Packages", eyebrow: "What we sell" },
  leads: { title: "Edyta’s leads", eyebrow: "Warm only" },
  outreach: { title: "Drafts", eyebrow: "Approval required" },
  talent: { title: "Talent bible", eyebrow: "Source of truth" },
};

// ── API ──────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? path : "/" + path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401 && window.SLIW_REQUIRE_DGA_LOGIN) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    const next = encodeURIComponent(window.location.pathname);
    window.location.replace("/?next=" + next);
    throw new Error("Session expired — sign in again");
  }
  if (res.status === 403) {
    let msg = "Access denied for this account";
    try {
      const j = await res.json();
      msg = j.detail || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail || JSON.stringify(j);
    } catch (_) {
      try { msg = await res.text(); } catch (__) {}
    }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function toast(msg, ms = 3200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function tierClass(tier) {
  return `pill tier-${(tier || "c").toLowerCase()}`;
}

function primaryPackage(p) {
  const pkgs = p.recommended_packages || [];
  return pkgs[0]?.name || "—";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Navigation ───────────────────────────────────────────────────────────────

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const meta = VIEW_META[name] || { title: name, eyebrow: "Sliw Agent" };
  $("#view-title").textContent = meta.title;
  $("#view-eyebrow").textContent = meta.eyebrow;
  if (name === "pipeline") renderPipeline();
  if (name === "leads") renderLeads();
  if (name === "outreach") renderOutreach();
  if (name === "packages" && state.talent) renderPackages();
  if (name === "talent" && state.talent) renderTalent();
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function renderDashboard() {
  const s = state.summary;
  if (!s) return;

  $("#hero-stats").innerHTML = `
    <div class="stat-tile"><div class="n">${s.total}</div><div class="l">Prospects</div></div>
    <div class="stat-tile"><div class="n">${s.leads}</div><div class="l">Warm leads</div></div>
    <div class="stat-tile"><div class="n">${s.tiers?.A || 0}</div><div class="l">Tier A</div></div>
    <div class="stat-tile"><div class="n">${s.avg_score || 0}</div><div class="l">Avg score</div></div>
  `;

  $("#kpi-row").innerHTML = `
    <div class="kpi">
      <div class="label">Drafted</div>
      <div class="value">${s.stages?.drafted || 0}</div>
      <div class="sub">Awaiting your approval</div>
    </div>
    <div class="kpi">
      <div class="label">Contacted</div>
      <div class="value">${(s.stages?.contacted || 0) + (s.stages?.replied || 0)}</div>
      <div class="sub">In conversation</div>
    </div>
    <div class="kpi">
      <div class="label">Won</div>
      <div class="value">${s.stages?.won || 0}</div>
      <div class="sub">Booked engagements</div>
    </div>
  `;

  const stages = s.stages || {};
  $("#stage-flow").innerHTML = STAGE_ORDER.map((st) => {
    const n = stages[st] || 0;
    return `<div class="stage-chip ${n ? "has" : ""}">
      <div class="count">${n}</div>
      <div class="name">${st.replace(/_/g, " ")}</div>
    </div>`;
  }).join("");

  if (s.updated_at) {
    const d = new Date(s.updated_at);
    $("#pipeline-updated").textContent = `Updated ${d.toLocaleString()}`;
  }

  const top = [...state.prospects]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 8);

  const tbody = $("#dash-table tbody");
  tbody.innerHTML = top.map((p) => `
    <tr data-id="${escapeHtml(p.id)}">
      <td class="company-cell">${escapeHtml(p.company)}</td>
      <td><span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span></td>
      <td>${p.score ?? "—"}</td>
      <td>${escapeHtml((p.stage || "").replace(/_/g, " "))}</td>
      <td>${escapeHtml(primaryPackage(p))}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">No prospects yet — load seed corps or run outreach.</td></tr>`;

  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openProspect(tr.dataset.id));
  });

  const badge = $("#leads-badge");
  if (s.leads > 0) {
    badge.hidden = false;
    badge.textContent = s.leads;
  } else {
    badge.hidden = true;
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

function fillStageFilter() {
  const sel = $("#filter-stage");
  const current = sel.value;
  sel.innerHTML = `<option value="">All stages</option>` +
    STAGE_ORDER.map((s) => `<option value="${s}">${s.replace(/_/g, " ")}</option>`).join("");
  sel.value = current;
}

function renderPipeline() {
  fillStageFilter();
  const stage = $("#filter-stage").value;
  const tier = $("#filter-tier").value;
  const q = ($("#filter-search").value || "").toLowerCase().trim();

  let rows = state.prospects;
  if (stage) rows = rows.filter((p) => p.stage === stage);
  if (tier) rows = rows.filter((p) => p.tier === tier);
  if (q) rows = rows.filter((p) => (p.company || "").toLowerCase().includes(q));

  const grid = $("#prospect-grid");
  if (!rows.length) {
    grid.innerHTML = `<div class="panel empty-state" style="grid-column:1/-1">
      <div class="empty-icon">◎</div>
      <h3>No matches</h3>
      <p>Load seed corps or run a new outreach pipeline.</p>
    </div>`;
    return;
  }

  grid.innerHTML = rows.map((p) => `
    <article class="prospect-card" data-id="${escapeHtml(p.id)}">
      <div class="top">
        <h4>${escapeHtml(p.company)}</h4>
        <span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span>
      </div>
      <div class="meta">
        ${escapeHtml(p.industry || "—")}<br />
        ${escapeHtml(p.geo || "")}
      </div>
      <div class="foot">
        <span>${escapeHtml((p.stage || "").replace(/_/g, " "))}</span>
        <span class="score-ring">${p.score ?? "—"}</span>
      </div>
      <div class="meta" style="margin:10px 0 0;font-size:12px">
        ${escapeHtml(primaryPackage(p))}
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".prospect-card").forEach((card) => {
    card.addEventListener("click", () => openProspect(card.dataset.id));
  });
}

// ── Packages / talent ────────────────────────────────────────────────────────

function renderPackages() {
  const pkgs = state.talent?.packages || [];
  $("#package-grid").innerHTML = pkgs.map((p, i) => `
    <article class="package-card">
      <div class="num">Package 0${i + 1}</div>
      <h3>${escapeHtml(p.name)}</h3>
      <div class="duration">${escapeHtml(p.duration)}</div>
      <p class="one-liner">${escapeHtml(p.one_liner)}</p>
      <ul>
        ${(p.best_for || []).slice(0, 4).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function renderTalent() {
  const t = state.talent;
  if (!t) return;
  const talent = t.talent || {};
  $("#talent-layout").innerHTML = `
    <div class="talent-hero">
      <p class="eyebrow">Representing</p>
      <h2>${escapeHtml(talent.legal_name || "Edyta Śliwińska")}</h2>
      <p>${escapeHtml(talent.headline || "")}</p>
      <p>${escapeHtml(talent.brand_promise || "")}</p>
      <div class="talent-meta">
        <div><span>Studio</span><br /><strong>${escapeHtml(talent.studio_address || "")}</strong></div>
        <div><span>Contact</span><br /><strong>${escapeHtml(talent.email_public || "")} · ${escapeHtml(talent.phone_primary || "")}</strong></div>
        <div><span>Web</span><br /><strong><a href="${escapeHtml(talent.corporate_page || "#")}" target="_blank" rel="noopener">${escapeHtml(talent.website || "")}</a></strong></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Credentials</h3></div>
      <ul class="credential-list">
        ${(t.credentials || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
      </ul>
      <div class="panel-head" style="margin-top:22px"><h3>Positioning</h3></div>
      <p style="color:var(--mist);line-height:1.6;white-space:pre-wrap;font-size:14px">${escapeHtml(t.positioning || "")}</p>
    </div>
  `;
}

// ── Leads / outreach ─────────────────────────────────────────────────────────

function renderLeads() {
  const list = $("#leads-list");
  if (!state.leads.length) {
    list.innerHTML = `<div class="panel empty-state">
      <div class="empty-icon">★</div>
      <h3>No warm leads yet</h3>
      <p>When a corporation replies with interest, qualify them here. Edyta only sees this list.</p>
    </div>`;
    return;
  }
  list.innerHTML = state.leads.map((p) => `
    <article class="lead-card">
      <div class="top" style="display:flex;justify-content:space-between;gap:12px;align-items:start">
        <div>
          <h4>${escapeHtml(p.company)}</h4>
          <p class="muted">${escapeHtml(p.industry || "")} · score ${p.score ?? "—"} · ${escapeHtml(p.stage || "")}</p>
        </div>
        <span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span>
      </div>
      <p style="margin-top:10px;color:var(--cream);font-size:14px">${escapeHtml(p.reply_summary || p.agent_note || "")}</p>
      <div class="actions">
        <button class="btn primary sm" data-open="${escapeHtml(p.id)}">Open prospect</button>
        ${p.gamma_url ? `<a class="btn ghost sm" href="${escapeHtml(p.gamma_url)}" target="_blank" rel="noopener">Gamma deck</a>` : ""}
      </div>
    </article>
  `).join("");

  list.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => openProspect(btn.dataset.open));
  });
}

function renderOutreach() {
  const list = $("#outreach-list");
  if (!state.outreach.length) {
    list.innerHTML = `<div class="panel empty-state">
      <div class="empty-icon">✉</div>
      <h3>No drafts yet</h3>
      <p>Run New outreach to generate a premium email for approval.</p>
    </div>`;
    return;
  }
  list.innerHTML = state.outreach.map((d) => {
    const email = d.email || {};
    return `<article class="draft-card">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
        <div>
          <h4>${escapeHtml(d.company || "—")}</h4>
          <p class="muted">${escapeHtml(d.status || "draft")} · ${escapeHtml(d.contact_email || "no email yet")}</p>
        </div>
        <span class="pill">${escapeHtml(d.sequence_step || "cold_1")}</span>
      </div>
      <p style="margin-top:12px;font-weight:600;color:var(--champagne-light);font-size:14px">
        ${escapeHtml(email.subject || "")}
      </p>
      <div class="email-preview">${escapeHtml(email.body || "")}</div>
      <div class="actions">
        <button class="btn ghost sm" data-copy="${escapeHtml(d.prospect_id || "")}">Copy body</button>
        ${d.prospect_id ? `<button class="btn primary sm" data-open="${escapeHtml(d.prospect_id)}">Open prospect</button>` : ""}
      </div>
    </article>`;
  }).join("");

  list.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => openProspect(btn.dataset.open));
  });
  list.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const draft = state.outreach.find((d) => d.prospect_id === btn.dataset.copy);
      const body = draft?.email?.body || "";
      try {
        await navigator.clipboard.writeText(body);
        toast("Email body copied — paste into Gmail after you approve");
      } catch {
        toast("Could not copy — select text manually");
      }
    });
  });
}

// ── Drawer ───────────────────────────────────────────────────────────────────

async function openProspect(id) {
  try {
    const p = await api(`/prospects/${encodeURIComponent(id)}`);
    $("#drawer-title").textContent = p.company || "Prospect";
    const pkgs = (p.recommended_packages || [])
      .map((x) => `<li><strong>${escapeHtml(x.name)}</strong> — ${escapeHtml(x.one_liner || "")}</li>`)
      .join("");
    const contacts = (p.contacts || [])
      .map((c) => `<li>${escapeHtml(c.name || "")}${c.title ? " · " + escapeHtml(c.title) : ""}${c.email ? " · " + escapeHtml(c.email) : ""}</li>`)
      .join("") || "<li class='muted'>No contacts yet</li>";

    const emailBody = p.outreach?.email?.body || p.outreach_md || "";
    const brief = p.brief_md || "";

    $("#drawer-body").innerHTML = `
      <div class="drawer-section">
        <h5>Fit</h5>
        <p>
          <span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span>
          &nbsp; score <strong>${p.score ?? "—"}</strong>
          &nbsp;·&nbsp; ${escapeHtml((p.stage || "").replace(/_/g, " "))}
        </p>
        <p style="margin-top:8px;color:var(--mist)">${escapeHtml(p.agent_note || "")}</p>
      </div>
      <div class="drawer-section">
        <h5>Company</h5>
        <p>${escapeHtml(p.industry || "—")}<br />${escapeHtml(p.geo || "")}<br />${escapeHtml(p.employee_range || "")}</p>
        ${p.website ? `<p style="margin-top:6px"><a href="${escapeHtml(p.website)}" target="_blank" rel="noopener">${escapeHtml(p.website)}</a></p>` : ""}
      </div>
      <div class="drawer-section">
        <h5>Packages</h5>
        <ul>${pkgs || "<li>—</li>"}</ul>
      </div>
      <div class="drawer-section">
        <h5>Contacts</h5>
        <ul>${contacts}</ul>
      </div>
      ${p.gamma_url ? `<div class="drawer-section"><h5>Gamma deck</h5><p><a href="${escapeHtml(p.gamma_url)}" target="_blank" rel="noopener">${escapeHtml(p.gamma_url)}</a></p></div>` : ""}
      ${emailBody ? `<div class="drawer-section"><h5>Outreach draft</h5><div class="email-preview">${escapeHtml(typeof emailBody === "string" && emailBody.includes("Subject:") ? emailBody : (p.outreach?.email?.subject ? "Subject: " + p.outreach.email.subject + "\n\n" : "") + (p.outreach?.email?.body || emailBody))}</div>
        <button class="btn ghost sm" id="copy-outreach" type="button" style="margin-top:10px">Copy email</button></div>` : ""}
      ${brief ? `<div class="drawer-section"><h5>Edyta brief</h5><div class="brief-box">${escapeHtml(brief)}</div></div>` : ""}
      <div class="drawer-section qualify-box">
        <h5>Qualify a reply</h5>
        <p class="muted" style="margin-bottom:6px">Paste their response. If warm, we prep Edyta’s brief.</p>
        <textarea id="reply-text" placeholder="Thanks — we'd love a discovery call next week…"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary sm" id="btn-qualify" type="button">Qualify reply</button>
          <button class="btn ghost sm" id="btn-contacted" type="button">Mark contacted</button>
          <button class="btn ghost sm" id="btn-nurture" type="button">Nurture</button>
          <button class="btn ghost sm" id="btn-lost" type="button">Lost</button>
        </div>
      </div>
    `;

    const drawer = $("#drawer");
    const backdrop = $("#drawer-backdrop");
    if (drawer) {
      drawer.hidden = false;
      drawer.removeAttribute("hidden");
    }
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.removeAttribute("hidden");
    }

    $("#btn-qualify")?.addEventListener("click", async () => {
      const reply_text = $("#reply-text").value.trim();
      if (!reply_text) return toast("Paste a reply first");
      try {
        const out = await api(`/prospects/${encodeURIComponent(id)}/interested`, {
          method: "POST",
          body: JSON.stringify({ reply_text }),
        });
        toast(out.qualification?.ready_for_edyta
          ? "Warm lead — Edyta brief ready"
          : `Staged as ${out.qualification?.recommended_stage}`);
        await refresh();
        openProspect(id);
      } catch (e) {
        toast(e.message);
      }
    });

    const stageBtn = async (stage) => {
      try {
        await api(`/prospects/${encodeURIComponent(id)}/stage`, {
          method: "POST",
          body: JSON.stringify({ stage }),
        });
        toast(`Marked ${stage}`);
        await refresh();
        openProspect(id);
      } catch (e) {
        toast(e.message);
      }
    };
    $("#btn-contacted")?.addEventListener("click", () => stageBtn("contacted"));
    $("#btn-nurture")?.addEventListener("click", () => stageBtn("nurture"));
    $("#btn-lost")?.addEventListener("click", () => stageBtn("lost"));

    $("#copy-outreach")?.addEventListener("click", async () => {
      const body = p.outreach?.email?.body || "";
      try {
        await navigator.clipboard.writeText(body);
        toast("Copied");
      } catch {
        toast("Copy failed");
      }
    });
  } catch (e) {
    toast(e.message);
  }
}

function closeDrawer(ev) {
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  const drawer = $("#drawer");
  const backdrop = $("#drawer-backdrop");
  if (drawer) {
    drawer.hidden = true;
    drawer.setAttribute("hidden", "");
  }
  if (backdrop) {
    backdrop.hidden = true;
    backdrop.setAttribute("hidden", "");
  }
}

// ── Run form ─────────────────────────────────────────────────────────────────

function bindForm() {
  $("#pipeline-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const signals = String(fd.get("signals") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const body = {
      company: fd.get("company"),
      industry: fd.get("industry") || "",
      geo: fd.get("geo") || "",
      employee_range: fd.get("employee_range") || "",
      website: fd.get("website") || "",
      notes: fd.get("notes") || "",
      custom_hook: fd.get("custom_hook") || "",
      signals,
      contact_name: fd.get("contact_name") || "",
      contact_title: fd.get("contact_title") || "",
      contact_email: fd.get("contact_email") || "",
      contact_linkedin: fd.get("contact_linkedin") || "",
      generate_gamma: !!fd.get("generate_gamma"),
      live_gamma: !!fd.get("live_gamma"),
      draft_email: !!fd.get("draft_email"),
    };

    const btn = $("#run-submit");
    btn.disabled = true;
    btn.textContent = body.live_gamma ? "Generating Gamma…" : "Running…";
    $("#run-result").innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div><h3>Working</h3><p>Scoring, packaging, drafting…</p></div>`;

    try {
      const result = await api("/prospects/pipeline", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh();
      renderRunResult(result);
      toast(`Pipeline complete · ${result.company}`);
    } catch (err) {
      $("#run-result").innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Run pipeline";
    }
  });
}

function renderRunResult(result) {
  const sc = result.score || {};
  const pkgs = (sc.recommended_packages || [])
    .map((p) => `<li><strong>${escapeHtml(p.name)}</strong> <span class="muted">(match ${p.match_score})</span></li>`)
    .join("");
  const gamma = result.gamma || {};
  let outreachHtml = "";
  // load full prospect for email if drafted
  const loadEmail = async () => {
    if (!result.prospect_id) return;
    try {
      const p = await api(`/prospects/${encodeURIComponent(result.prospect_id)}`);
      if (p.outreach?.email) {
        const box = $("#run-email-box");
        if (box) {
          box.innerHTML = `<div class="email-preview"><strong>${escapeHtml(p.outreach.email.subject || "")}</strong>\n\n${escapeHtml(p.outreach.email.body || "")}</div>
            <button class="btn ghost sm" type="button" id="run-copy" style="margin-top:10px">Copy email body</button>`;
          $("#run-copy")?.addEventListener("click", async () => {
            await navigator.clipboard.writeText(p.outreach.email.body || "");
            toast("Copied — paste into Gmail after approval");
          });
        }
      }
    } catch (_) {}
  };

  $("#run-result").innerHTML = `
    <div class="result-block">
      <p class="eyebrow">Result</p>
      <h3>${escapeHtml(result.company)}</h3>
      <div class="row">
        <span class="${tierClass(sc.tier)}">Tier ${escapeHtml(sc.tier || "—")}</span>
        <span class="pill">Score ${sc.score ?? "—"}</span>
        <span class="pill">${escapeHtml(result.prospect_id || "")}</span>
      </div>
      <p style="color:var(--mist);line-height:1.5;font-size:14px">${escapeHtml(sc.agent_note || "")}</p>
      <div class="result-kv">
        <div><dt>Industry</dt><dd>${escapeHtml(sc.matched_industry || "—")}</dd></div>
        <div><dt>Signals</dt><dd>${escapeHtml((sc.matched_signals || []).join(", ") || "—")}</dd></div>
        <div><dt>Gamma</dt><dd>${gamma.dry_run === false && gamma.gamma_url
          ? `<a href="${escapeHtml(gamma.gamma_url)}" target="_blank" rel="noopener">Open deck</a>`
          : gamma.prompt_path
            ? `Prompt saved (dry-run)`
            : result.skipped || "—"}</dd></div>
      </div>
      <h5 style="color:var(--champagne);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;margin:12px 0 8px">Packages</h5>
      <ul style="list-style:none;display:grid;gap:6px;font-size:14px;color:var(--cream)">${pkgs || "<li>—</li>"}</ul>
      <h5 style="color:var(--champagne);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;margin:18px 0 8px">Outreach draft</h5>
      <div id="run-email-box"><p class="muted">Loading draft…</p></div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary sm" type="button" id="run-open">Open in pipeline</button>
      </div>
    </div>
  `;
  $("#run-open")?.addEventListener("click", () => openProspect(result.prospect_id));
  loadEmail();
}

// ── Data load ────────────────────────────────────────────────────────────────

async function refresh() {
  const [summary, prospects, talent, outreach, leads, briefs] = await Promise.all([
    api("/pipeline/summary"),
    api("/prospects"),
    api("/talent"),
    api("/outreach"),
    api("/leads"),
    api("/briefs"),
  ]);
  state.summary = summary;
  state.prospects = prospects;
  state.talent = talent;
  state.outreach = outreach;
  state.leads = leads;
  state.briefs = briefs;
  renderDashboard();
  const active = $(".nav-item.active")?.dataset.view || "dashboard";
  if (active !== "dashboard") showView(active);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  if (!ensureAuth()) return;

  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.goto));
  });
  $("#drawer-close")?.addEventListener("click", closeDrawer);
  $("#drawer-backdrop")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#drawer") && !$("#drawer").hidden) {
      closeDrawer(e);
    }
  });
  $("#btn-refresh").addEventListener("click", async () => {
    try {
      await refresh();
      toast("Refreshed");
    } catch (e) {
      toast(e.message);
    }
  });
  $("#btn-seed").addEventListener("click", async () => {
    try {
      toast("Seeding Bay Area corps…");
      await api("/seed", { method: "POST", body: "{}" });
      await refresh();
      toast("Seed prospects loaded");
      showView("pipeline");
    } catch (e) {
      toast(e.message);
    }
  });
  $("#filter-stage")?.addEventListener("change", renderPipeline);
  $("#filter-tier")?.addEventListener("change", renderPipeline);
  $("#filter-search")?.addEventListener("input", renderPipeline);
  bindForm();

  // Show signed-in user when available
  api("/me")
    .then((me) => {
      state.user = me;
      const sub = document.querySelector(".brand-sub");
      if (sub && me?.name) sub.textContent = me.name;
    })
    .catch(() => {});

  refresh().catch((e) => toast(e.message));
}

document.addEventListener("DOMContentLoaded", boot);
