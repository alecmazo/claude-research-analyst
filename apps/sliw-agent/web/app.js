/* Sliw Agent desk UI — Corporate Lead Engine + Wedding Agent */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const API_BASE = (window.SLIW_API_BASE || "/api").replace(/\/$/, "");
const TOKEN_KEY = "dga_v2_token";
const USER_KEY = "dga_v2_user";
const SLIW_ALLOWED_EMAILS = ["alecmazo1@gmail.com", "edytasliw@gmail.com"];

const STAGE_ORDER = [
  "research", "scored", "packaged", "drafted", "approved", "contacted",
  "replied", "interested", "discovery_booked", "won", "nurture", "lost",
];

const VIEW_META = {
  edyta: { title: "Edyta’s desk", eyebrow: "Warm leads only" },
  week: { title: "This week", eyebrow: "Desk cadence" },
  dashboard: { title: "Dashboard", eyebrow: "Corporate book" },
  engine: { title: "Lead Engine", eyebrow: "Grow the pipeline" },
  pipeline: { title: "Pipeline", eyebrow: "Corporate CRM" },
  run: { title: "New outreach", eyebrow: "Corporate" },
  outreach: { title: "Drafts", eyebrow: "Approval required" },
  packages: { title: "Packages", eyebrow: "What we sell" },
  weddings: { title: "Weddings", eyebrow: "Wedding Agent" },
  "wedding-run": { title: "New wedding lead", eyebrow: "Wedding Agent" },
  partners: { title: "Partnerships", eyebrow: "Channels" },
  talent: { title: "Talent bible", eyebrow: "Source of truth" },
};

const state = {
  prospects: [],
  weddingProspects: [],
  summary: null,
  talent: null,
  outreach: [],
  leads: [],
  partners: [],
  edytaHome: null,
  thisWeek: null,
  user: null,
};

function toast(msg, ms = 3400) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tierClass(t) {
  return `pill tier-${(t || "c").toLowerCase()}`;
}

function primaryPackage(p) {
  return (p.recommended_packages || [])[0]?.name || "—";
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  const v2 = localStorage.getItem(TOKEN_KEY);
  if (v2) h["x-auth-v2-token"] = v2;
  try {
    const v1 = localStorage.getItem("dga_token") || sessionStorage.getItem("dga_token");
    if (v1) h["x-auth-token"] = v1;
  } catch (_) {}
  return h;
}

async function api(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? path : "/" + path}`;
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (res.status === 401 && window.SLIW_REQUIRE_DGA_LOGIN) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.replace("/?next=" + encodeURIComponent(window.location.pathname));
    throw new Error("Session expired");
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

function isSliwAllowedEmail(email) {
  return SLIW_ALLOWED_EMAILS.includes(String(email || "").toLowerCase().trim());
}

function setBrandUser(name, email) {
  const el = $("#brand-user");
  if (!el) return;
  el.textContent = name || "Representation desk";
  el.title = email || name || "";
}

function ensureAuth() {
  if (!window.SLIW_REQUIRE_DGA_LOGIN) {
    setBrandUser("Local desk", "");
    return true;
  }
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.replace("/?next=" + encodeURIComponent(window.location.pathname));
    return false;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    if (cached) {
      setBrandUser(cached.name || cached.email, cached.email);
      if (cached.email && !isSliwAllowedEmail(cached.email)) {
        toast("Sliw Agent is not available for this account");
        setTimeout(() => {
          window.location.replace(
            cached.role === "gp" || cached.role === "admin" ? "/gp" : "/lp"
          );
        }, 500);
        return false;
      }
    }
  } catch (_) {}
  return true;
}

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const meta = VIEW_META[name] || { title: name, eyebrow: "Sliw" };
  $("#view-title").textContent = meta.title;
  $("#view-eyebrow").textContent = meta.eyebrow;
  if (name === "pipeline") renderPipeline();
  if (name === "edyta") renderEdyta();
  if (name === "week") renderWeek();
  if (name === "weddings") renderWeddings();
  if (name === "partners") renderPartners();
  if (name === "packages") renderPackages();
  if (name === "talent" && state.talent) renderTalent();
  if (name === "outreach") renderOutreach();
  if (name === "engine") renderEngine();
}

function renderDashboard() {
  const s = state.summary;
  if (!s) return;
  $("#hero-stats").innerHTML = `
    <div class="stat-tile"><div class="n">${s.total}</div><div class="l">Prospects</div></div>
    <div class="stat-tile"><div class="n">${s.leads}</div><div class="l">Warm leads</div></div>
    <div class="stat-tile"><div class="n">${s.tiers?.A || 0}</div><div class="l">Tier A</div></div>
    <div class="stat-tile"><div class="n">${s.avg_score || 0}</div><div class="l">Avg score</div></div>`;
  $("#kpi-row").innerHTML = `
    <div class="kpi"><div class="label">Drafted</div><div class="value">${s.stages?.drafted || 0}</div><div class="sub">Awaiting approval</div></div>
    <div class="kpi"><div class="label">Contacted</div><div class="value">${(s.stages?.contacted || 0) + (s.stages?.replied || 0)}</div><div class="sub">In motion</div></div>
    <div class="kpi"><div class="label">Won</div><div class="value">${s.stages?.won || 0}</div><div class="sub">Booked</div></div>`;
  const stages = s.stages || {};
  $("#stage-flow").innerHTML = STAGE_ORDER.map((st) => {
    const n = stages[st] || 0;
    return `<div class="stage-chip ${n ? "has" : ""}"><div class="count">${n}</div><div class="name">${st.replace(/_/g, " ")}</div></div>`;
  }).join("");
  const top = [...state.prospects].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
  const tbody = $("#dash-table tbody");
  tbody.innerHTML = top.map((p) => `
    <tr data-id="${escapeHtml(p.id)}">
      <td class="company-cell">${escapeHtml(p.company)}</td>
      <td><span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span></td>
      <td>${p.score ?? "—"}</td>
      <td>${escapeHtml((p.stage || "").replace(/_/g, " "))}</td>
      <td>${escapeHtml(primaryPackage(p))}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Import from Lead Engine</td></tr>`;
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openProspect(tr.dataset.id));
  });
  const badge = $("#leads-badge");
  const leadN = (state.edytaHome?.count) || s.leads || 0;
  if (leadN > 0) { badge.hidden = false; badge.textContent = leadN; }
  else badge.hidden = true;
}

function renderEdyta() {
  const home = state.edytaHome || { corporate_leads: [], wedding_leads: [], message: "" };
  $("#edyta-message").textContent = home.message || "";
  const all = [
    ...(home.corporate_leads || []).map((p) => ({ ...p, _book: "corporate" })),
    ...(home.wedding_leads || []).map((p) => ({ ...p, _book: "wedding" })),
  ];
  const list = $("#edyta-list");
  if (!all.length) {
    list.innerHTML = `<div class="panel empty-state"><div class="empty-icon">★</div><h3>No warm leads yet</h3><p>When corporations or couples reply with interest, they appear here with a call brief.</p></div>`;
    return;
  }
  list.innerHTML = all.map((p) => `
    <article class="lead-card">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <div>
          <h4>${escapeHtml(p.company)}</h4>
          <p class="muted">${escapeHtml(p._book)} · ${escapeHtml(p.stage || "")} · score ${p.score ?? "—"}</p>
        </div>
        <span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span>
      </div>
      <p style="margin-top:10px;color:var(--cream);font-size:14px">${escapeHtml(p.reply_summary || p.agent_note || "")}</p>
      <div class="actions">
        <button class="btn primary sm" data-open="${escapeHtml(p.id)}">Open brief</button>
        ${p.gamma_url ? `<a class="btn ghost sm" href="${escapeHtml(p.gamma_url)}" target="_blank" rel="noopener">Gamma</a>` : ""}
      </div>
    </article>`).join("");
  list.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openProspect(b.dataset.open)));
}

function renderWeek() {
  const tw = state.thisWeek;
  if (!tw) return;
  $("#week-totals").textContent =
    `${tw.totals?.prospects || 0} prospects · ${tw.totals?.tier_ab || 0} A/B · ${tw.totals?.interested || 0} warm`;
  $("#week-tasks").innerHTML = (tw.tasks || []).map((t) => `
    <div class="week-card ${t.done_hint ? "done" : ""}">
      <div class="week-day">${escapeHtml(t.day)}</div>
      <h4>${escapeHtml(t.title)}</h4>
      <p class="muted">${escapeHtml(t.target)} · <strong>${t.count}</strong></p>
      ${(t.items || []).slice(0, 6).map((i) =>
        `<button class="btn text sm" data-open="${escapeHtml(i.id)}">${escapeHtml(i.company || i.id)}</button>`
      ).join(" ")}
      ${t.action === "import_library" ? `<div style="margin-top:10px"><button class="btn primary sm" data-action="import">Import library</button></div>` : ""}
      ${t.action === "sequences" && (t.items || []).length ? `<div style="margin-top:10px"><button class="btn ghost sm" data-action="seq-batch" data-ids="${(t.items || []).slice(0, 5).map((i) => i.id).join(",")}">Build sequences (top 5)</button></div>` : ""}
    </div>`).join("");
  $("#week-tasks").querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openProspect(b.dataset.open)));
  $("#week-tasks").querySelectorAll("[data-action=import]").forEach((b) =>
    b.addEventListener("click", () => runLibraryImport(40)));
  $("#week-tasks").querySelectorAll("[data-action=seq-batch]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ids = (b.dataset.ids || "").split(",").filter(Boolean);
      for (const id of ids) {
        try { await api(`/prospects/${encodeURIComponent(id)}/sequences`, { method: "POST", body: "{}" }); }
        catch (e) { toast(e.message); }
      }
      toast(`Sequences built for ${ids.length}`);
      await refresh();
      showView("week");
    }));
}

function renderEngine() {
  /* stats filled on refresh */
}

function renderPipeline() {
  const stage = $("#filter-stage")?.value || "";
  const tier = $("#filter-tier")?.value || "";
  const q = ($("#filter-search")?.value || "").toLowerCase().trim();
  const sel = $("#filter-stage");
  if (sel && sel.options.length <= 1) {
    sel.innerHTML = `<option value="">All stages</option>` +
      STAGE_ORDER.map((s) => `<option value="${s}">${s.replace(/_/g, " ")}</option>`).join("");
  }
  let rows = state.prospects;
  if (stage) rows = rows.filter((p) => p.stage === stage);
  if (tier) rows = rows.filter((p) => p.tier === tier);
  if (q) rows = rows.filter((p) => (p.company || "").toLowerCase().includes(q));
  const grid = $("#prospect-grid");
  if (!rows.length) {
    grid.innerHTML = `<div class="panel empty-state" style="grid-column:1/-1"><h3>No matches</h3><p>Use Lead Engine to import prospects.</p></div>`;
    return;
  }
  grid.innerHTML = rows.map((p) => `
    <article class="prospect-card" data-id="${escapeHtml(p.id)}">
      <div class="top"><h4>${escapeHtml(p.company)}</h4><span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span></div>
      <div class="meta">${escapeHtml(p.industry || "—")}<br/>${escapeHtml(p.geo || "")}</div>
      <div class="foot"><span>${escapeHtml((p.stage || "").replace(/_/g, " "))}</span><span class="score-ring">${p.score ?? "—"}</span></div>
      <div class="meta" style="margin-top:8px;font-size:12px">${escapeHtml(primaryPackage(p))}</div>
    </article>`).join("");
  grid.querySelectorAll(".prospect-card").forEach((c) =>
    c.addEventListener("click", () => openProspect(c.dataset.id)));
}

function renderWeddings() {
  const rows = state.weddingProspects || [];
  $("#wedding-stats").textContent = `${rows.length} in wedding book`;
  const grid = $("#wedding-grid");
  if (!rows.length) {
    grid.innerHTML = `<div class="panel empty-state" style="grid-column:1/-1"><h3>No wedding leads</h3><p>Import library or add a couple / planner.</p></div>`;
    return;
  }
  grid.innerHTML = rows.map((p) => `
    <article class="prospect-card" data-id="${escapeHtml(p.id)}">
      <div class="top"><h4>${escapeHtml(p.company)}</h4><span class="pill">${escapeHtml(p.industry || "wedding")}</span></div>
      <div class="meta">${escapeHtml(p.geo || "")}<br/>${escapeHtml(primaryPackage(p))}</div>
      <div class="foot"><span>${escapeHtml((p.stage || "").replace(/_/g, " "))}</span></div>
    </article>`).join("");
  grid.querySelectorAll(".prospect-card").forEach((c) =>
    c.addEventListener("click", () => openProspect(c.dataset.id)));
}

function renderPartners() {
  const list = $("#partner-list");
  const rows = state.partners || [];
  if (!rows.length) {
    list.innerHTML = `<div class="panel empty-state"><h3>No partners yet</h3><p>Load seeds or add a channel partner.</p></div>`;
    return;
  }
  list.innerHTML = rows.map((p) => `
    <article class="lead-card">
      <h4>${escapeHtml(p.name)}</h4>
      <p class="muted">${escapeHtml(p.type || "")} · ${escapeHtml(p.geo || "")} · ${escapeHtml(p.status || "")}</p>
      <p style="margin-top:8px;color:var(--cream);font-size:14px">${escapeHtml(p.notes || "")}</p>
    </article>`).join("");
}

function renderPackages() {
  const pkgs = state.talent?.packages || [];
  $("#package-grid").innerHTML = pkgs.map((p, i) => `
    <article class="package-card">
      <div class="num">Corp 0${i + 1}</div>
      <h3>${escapeHtml(p.name)}</h3>
      <div class="duration">${escapeHtml(p.duration)}</div>
      <p class="one-liner">${escapeHtml(p.one_liner)}</p>
    </article>`).join("");
  const wp = state.talent?.wedding_packages || [];
  $("#wedding-package-grid").innerHTML = wp.map((p) => `
    <article class="package-card">
      <div class="num">${escapeHtml(p.price_label || "")}</div>
      <h3>${escapeHtml(p.name)}</h3>
      <p class="one-liner">${escapeHtml(p.one_liner)}</p>
    </article>`).join("");
}

function renderTalent() {
  const t = state.talent;
  if (!t) return;
  const talent = t.talent || {};
  $("#talent-layout").innerHTML = `
    <div class="talent-hero">
      <p class="eyebrow">Representing</p>
      <h2>${escapeHtml(talent.legal_name || "Edyta")}</h2>
      <p>${escapeHtml(talent.headline || "")}</p>
      <p>${escapeHtml(talent.brand_promise || "")}</p>
      <div class="talent-meta">
        <div><span>Studio</span><br/><strong>${escapeHtml(talent.studio_address || "")}</strong></div>
        <div><span>Contact</span><br/><strong>${escapeHtml(talent.email_public || "")}</strong></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Credentials</h3></div>
      <ul class="credential-list">${(t.credentials || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
    </div>`;
}

function renderOutreach() {
  const list = $("#outreach-list");
  if (!state.outreach?.length) {
    list.innerHTML = `<div class="panel empty-state"><h3>No drafts</h3><p>Run outreach or sequences.</p></div>`;
    return;
  }
  list.innerHTML = state.outreach.map((d) => {
    const email = d.email || {};
    return `<article class="draft-card">
      <h4>${escapeHtml(d.company || "—")}</h4>
      <p class="muted">${escapeHtml(d.sequence_step || "")} · ${escapeHtml(d.status || "draft")}</p>
      <p style="margin-top:10px;color:var(--champagne-light);font-weight:600">${escapeHtml(email.subject || "")}</p>
      <div class="email-preview">${escapeHtml(email.body || "")}</div>
      <div class="actions">
        <button class="btn ghost sm" data-copy-body>Copy body</button>
        ${d.prospect_id ? `<button class="btn primary sm" data-open="${escapeHtml(d.prospect_id)}">Open</button>` : ""}
      </div>
    </article>`;
  }).join("");
  list.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openProspect(b.dataset.open)));
  list.querySelectorAll("[data-copy-body]").forEach((b, i) => {
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.outreach[i]?.email?.body || "");
      toast("Copied");
    });
  });
}

function closeDrawer(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  ["drawer", "drawer-backdrop"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.hidden = true; el.setAttribute("hidden", ""); }
  });
}

async function openProspect(id) {
  try {
    const p = await api(`/prospects/${encodeURIComponent(id)}`);
    $("#drawer-title").textContent = p.company || "Prospect";
    const pkgs = (p.recommended_packages || [])
      .map((x) => `<li><strong>${escapeHtml(x.name)}</strong> — ${escapeHtml(x.one_liner || x.price_label || "")}</li>`)
      .join("");
    const contacts = (p.contacts || [])
      .map((c) => `<li>${escapeHtml(c.name || "")}${c.title ? " · " + escapeHtml(c.title) : ""}${c.email ? " · " + escapeHtml(c.email) : ""}${c.linkedin ? " · LI" : ""}</li>`)
      .join("") || "<li class='muted'>Add contact before send</li>";
    const emailBody = p.outreach?.email?.body || "";
    const brief = p.brief_md || "";

    $("#drawer-body").innerHTML = `
      <div class="drawer-section"><h5>Fit</h5>
        <p><span class="${tierClass(p.tier)}">${escapeHtml(p.tier || "—")}</span> score <strong>${p.score ?? "—"}</strong> · ${escapeHtml((p.stage || "").replace(/_/g, " "))} · ${escapeHtml(p.book || "corporate")}</p>
        <p style="margin-top:8px;color:var(--mist)">${escapeHtml(p.agent_note || "")}</p>
      </div>
      <div class="drawer-section"><h5>Packages</h5><ul>${pkgs || "<li>—</li>"}</ul></div>
      <div class="drawer-section"><h5>Contacts</h5><ul>${contacts}</ul></div>
      ${p.gamma_url ? `<div class="drawer-section"><h5>Gamma</h5><p><a href="${escapeHtml(p.gamma_url)}" target="_blank" rel="noopener">Open deck</a></p></div>` : ""}
      ${emailBody ? `<div class="drawer-section"><h5>Draft</h5><div class="email-preview">${escapeHtml((p.outreach?.email?.subject ? "Subject: " + p.outreach.email.subject + "\n\n" : "") + emailBody)}</div>
        <button class="btn ghost sm" id="copy-outreach" style="margin-top:8px">Copy email</button></div>` : ""}
      ${brief ? `<div class="drawer-section"><h5>Edyta brief</h5><div class="brief-box">${escapeHtml(brief)}</div></div>` : ""}
      <div class="drawer-section">
        <h5>Sequences</h5>
        <button class="btn ghost sm" id="btn-seq">Build cold / follow / break drafts</button>
      </div>
      <div class="drawer-section qualify-box">
        <h5>Qualify a reply</h5>
        <textarea id="reply-text" placeholder="Paste their reply…"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary sm" id="btn-qualify">Qualify → brief</button>
          <button class="btn ghost sm" id="btn-contacted">Mark contacted</button>
          <button class="btn ghost sm" id="btn-nurture">Nurture</button>
          <button class="btn ghost sm" id="btn-lost">Lost</button>
        </div>
      </div>`;

    const drawer = $("#drawer");
    const backdrop = $("#drawer-backdrop");
    drawer.hidden = false; drawer.removeAttribute("hidden");
    backdrop.hidden = false; backdrop.removeAttribute("hidden");

    $("#btn-seq")?.addEventListener("click", async () => {
      try {
        await api(`/prospects/${encodeURIComponent(id)}/sequences`, { method: "POST", body: "{}" });
        toast("Sequence drafts created");
        await refresh();
        openProspect(id);
      } catch (e) { toast(e.message); }
    });
    $("#btn-qualify")?.addEventListener("click", async () => {
      const reply_text = $("#reply-text").value.trim();
      if (!reply_text) return toast("Paste a reply first");
      try {
        const out = await api(`/prospects/${encodeURIComponent(id)}/interested`, {
          method: "POST", body: JSON.stringify({ reply_text }),
        });
        toast(out.qualification?.ready_for_edyta ? "Warm — brief ready" : `→ ${out.qualification?.recommended_stage}`);
        await refresh();
        openProspect(id);
      } catch (e) { toast(e.message); }
    });
    const stageBtn = async (stage) => {
      await api(`/prospects/${encodeURIComponent(id)}/stage`, {
        method: "POST", body: JSON.stringify({ stage }),
      });
      toast(`Marked ${stage}`);
      await refresh();
      openProspect(id);
    };
    $("#btn-contacted")?.addEventListener("click", () => stageBtn("contacted"));
    $("#btn-nurture")?.addEventListener("click", () => stageBtn("nurture"));
    $("#btn-lost")?.addEventListener("click", () => stageBtn("lost"));
    $("#copy-outreach")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(p.outreach?.email?.body || "");
      toast("Copied");
    });
  } catch (e) {
    toast(e.message);
  }
}

async function runLibraryImport(limit) {
  try {
    toast("Lead Engine running…");
    const draft = $("#engine-draft")?.checked || false;
    const res = await api("/library/import", {
      method: "POST",
      body: JSON.stringify({ limit: limit || Number($("#engine-limit")?.value || 40), draft_email: draft }),
    });
    $("#engine-result").textContent =
      `Imported ${res.imported}. Remaining in library after filter: ${res.library_remaining}`;
    toast(`Imported ${res.imported} prospects`);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

function bindForms() {
  $("#pipeline-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const signals = String(fd.get("signals") || "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const result = await api("/prospects/pipeline", {
        method: "POST",
        body: JSON.stringify({
          company: fd.get("company"),
          industry: fd.get("industry") || "",
          geo: fd.get("geo") || "",
          employee_range: fd.get("employee_range") || "",
          website: fd.get("website") || "",
          notes: "",
          custom_hook: fd.get("custom_hook") || "",
          signals,
          contact_name: fd.get("contact_name") || "",
          contact_title: fd.get("contact_title") || "",
          contact_email: fd.get("contact_email") || "",
          contact_linkedin: fd.get("contact_linkedin") || "",
          generate_gamma: !!fd.get("generate_gamma"),
          live_gamma: !!fd.get("live_gamma"),
          draft_email: !!fd.get("draft_email"),
          book: "corporate",
        }),
      });
      await refresh();
      const sc = result.score || {};
      $("#run-result").innerHTML = `
        <div class="result-block">
          <h3>${escapeHtml(result.company)}</h3>
          <div class="row"><span class="${tierClass(sc.tier)}">Tier ${escapeHtml(sc.tier || "—")}</span>
          <span class="pill">Score ${sc.score ?? "—"}</span></div>
          <p style="color:var(--mist);margin-top:10px">${escapeHtml(sc.agent_note || "")}</p>
          <button class="btn primary sm" style="margin-top:14px" id="run-open">Open prospect</button>
        </div>`;
      $("#run-open")?.addEventListener("click", () => openProspect(result.prospect_id));
      toast("Pipeline complete");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#wedding-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const signals = String(fd.get("signals") || "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const result = await api("/wedding/pipeline", {
        method: "POST",
        body: JSON.stringify({
          name: fd.get("name"),
          industry: fd.get("industry") || "Wedding couple",
          geo: fd.get("geo") || "",
          notes: fd.get("notes") || "",
          signals,
          package_hint: fd.get("package_hint") || "",
          contact_name: fd.get("contact_name") || "",
          contact_email: fd.get("contact_email") || "",
          draft_email: !!fd.get("draft_email"),
          generate_gamma: !!fd.get("generate_gamma"),
          live_gamma: !!fd.get("live_gamma"),
        }),
      });
      await refresh();
      $("#wedding-run-result").innerHTML = `
        <div class="result-block">
          <h3>${escapeHtml(result.company)}</h3>
          <p class="muted">Wedding book · ${escapeHtml(result.prospect_id)}</p>
          <ul style="margin-top:12px;list-style:none">${(result.packages || []).map((p) =>
            `<li style="margin-bottom:6px"><strong>${escapeHtml(p.name)}</strong> ${escapeHtml(p.price_label || "")}</li>`
          ).join("")}</ul>
          <button class="btn primary sm" id="w-open">Open</button>
        </div>`;
      $("#w-open")?.addEventListener("click", () => openProspect(result.prospect_id));
      toast("Wedding pipeline complete");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#partner-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/partnerships", {
        method: "POST",
        body: JSON.stringify({
          name: fd.get("name"),
          type: fd.get("type"),
          geo: fd.get("geo") || "",
          notes: fd.get("notes") || "",
          contact_email: fd.get("contact_email") || "",
          status: "prospect",
        }),
      });
      e.target.reset();
      toast("Partner saved");
      await refresh();
      showView("partners");
    } catch (err) {
      toast(err.message);
    }
  });
}

async function refresh() {
  const [
    summary, prospects, talent, outreach, edytaHome, thisWeek,
    weddingProspects, partners, libStats,
  ] = await Promise.all([
    api("/pipeline/summary"),
    api("/prospects"),
    api("/talent"),
    api("/outreach"),
    api("/edyta-home"),
    api("/this-week"),
    api("/wedding/prospects"),
    api("/partnerships"),
    api("/library/stats").catch(() => ({ total: 0 })),
  ]);
  state.summary = summary;
  state.prospects = prospects;
  state.talent = talent;
  state.outreach = outreach;
  state.edytaHome = edytaHome;
  state.thisWeek = thisWeek;
  state.weddingProspects = weddingProspects;
  state.partners = partners;
  if ($("#lib-count")) $("#lib-count").textContent = `${libStats.total || 0} in library`;
  renderDashboard();
  const active = $(".nav-item.active")?.dataset.view || "edyta";
  if (active !== "dashboard") showView(active);
  else renderDashboard();
}

function boot() {
  if (!ensureAuth()) return;

  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
  $$("[data-goto]").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.goto)));
  $("#drawer-close")?.addEventListener("click", closeDrawer);
  $("#drawer-backdrop")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#drawer") && !$("#drawer").hidden) closeDrawer(e);
  });
  $("#btn-refresh")?.addEventListener("click", async () => {
    try { await refresh(); toast("Refreshed"); } catch (e) { toast(e.message); }
  });
  $("#btn-engine-run")?.addEventListener("click", () => runLibraryImport(40));
  $("#btn-lib-import")?.addEventListener("click", () => runLibraryImport(Number($("#engine-limit")?.value || 40)));
  $("#btn-bulk")?.addEventListener("click", async () => {
    try {
      const rows = JSON.parse($("#bulk-json").value || "[]");
      const res = await api("/prospects/bulk", { method: "POST", body: JSON.stringify({ rows, draft_email: true }) });
      toast(`Bulk imported ${res.imported}`);
      await refresh();
    } catch (e) { toast(e.message); }
  });
  $("#btn-wedding-import")?.addEventListener("click", async () => {
    try {
      const r = await api("/wedding/library/import", { method: "POST" });
      toast(`Wedding library: ${r.imported}`);
      await refresh();
      showView("weddings");
    } catch (e) { toast(e.message); }
  });
  $("#btn-partner-seed")?.addEventListener("click", async () => {
    try {
      const r = await api("/partnerships/seed", { method: "POST" });
      toast(`Partners +${r.added}`);
      await refresh();
      showView("partners");
    } catch (e) { toast(e.message); }
  });
  $("#filter-stage")?.addEventListener("change", renderPipeline);
  $("#filter-tier")?.addEventListener("change", renderPipeline);
  $("#filter-search")?.addEventListener("input", renderPipeline);
  bindForms();

  api("/me")
    .then((me) => {
      state.user = me;
      setBrandUser(me?.name || me?.email || "Desk", me?.email);
    })
    .catch((e) => {
      setBrandUser("Access denied", "");
      if (window.SLIW_REQUIRE_DGA_LOGIN) {
        toast(e.message);
        setTimeout(() => { window.location.replace("/"); }, 900);
      }
    });

  refresh().catch((e) => toast(e.message));
}

document.addEventListener("DOMContentLoaded", boot);
