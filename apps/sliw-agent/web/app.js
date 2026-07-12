/* Sliw Agent — free-flow desk: library + one-lead step pipeline */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const API = (window.SLIW_API_BASE || "/api").replace(/\/$/, "");
const TOKEN_KEY = "dga_v2_token";
const USER_KEY = "dga_v2_user";
const ALLOWED = ["alecmazo1@gmail.com", "edytasliw@gmail.com"];

const state = {
  library: [],
  ready: [],
  workstream: null,
  focusId: null,
  edyta: null,
  wedding: [],
  partners: [],
};

function toast(msg, ms = 3200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function busy(on, text = "Working…") {
  const el = $("#busy");
  if (!el) return;
  el.hidden = !on;
  if (on) el.querySelector(".busy-card").textContent = text;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tierClass(t) {
  return `pill tier-${(t || "c").toLowerCase()}`;
}

function headers() {
  const h = { "Content-Type": "application/json" };
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) h["x-auth-v2-token"] = t;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path.startsWith("/") ? path : "/" + path}`, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  if (res.status === 401 && window.SLIW_REQUIRE_DGA_LOGIN) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.replace("/?next=" + encodeURIComponent(location.pathname));
    throw new Error("Session expired");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.status === 204 ? null : res.json();
}

function ensureAuth() {
  if (!window.SLIW_REQUIRE_DGA_LOGIN) {
    $("#brand-user").textContent = "Local desk";
    return true;
  }
  const tok = localStorage.getItem(TOKEN_KEY);
  if (!tok) {
    location.replace("/?next=" + encodeURIComponent(location.pathname));
    return false;
  }
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    if (u) {
      $("#brand-user").textContent = u.name || u.email || "Desk";
      if (u.email && !ALLOWED.includes(String(u.email).toLowerCase())) {
        toast("Not authorized for Sliw");
        setTimeout(() => location.replace(u.role === "lp" ? "/lp" : "/gp"), 600);
        return false;
      }
    }
  } catch (_) {}
  return true;
}

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const titles = {
    work: ["Work", "Free flow — next step only"],
    library: ["Lead library", "All qualified companies"],
    edyta: ["Edyta’s desk", "Warm leads only"],
    weddings: ["Weddings", "Parallel book"],
    partners: ["Partners", "Channels"],
  };
  const [t, e] = titles[name] || [name, ""];
  $("#view-title").textContent = t;
  $("#view-eyebrow").textContent = e;
  if (name === "library") renderLibrary();
  if (name === "edyta") renderEdyta();
  if (name === "weddings") renderWeddings();
  if (name === "partners") renderPartners();
  if (name === "work") renderReady();
}

/* ── Work queue + step panel ─────────────────────────────────────────────── */

function renderReady() {
  const list = $("#ready-list");
  const items = state.ready || [];
  if (!items.length) {
    list.innerHTML = `<p class="muted">No A/B leads in CRM yet. Open <strong>Lead library</strong> or hit <strong>Refresh leads</strong>.</p>`;
    return;
  }
  list.innerHTML = items.map((p) => `
    <button type="button" class="ready-item ${state.focusId === p.id ? "active" : ""}" data-id="${esc(p.id)}">
      <div class="ready-top">
        <strong>${esc(p.company)}</strong>
        <span class="${tierClass(p.tier)}">${esc(p.tier)}</span>
      </div>
      <div class="ready-meta">Score ${p.score ?? "—"} · ${esc(p.package || "—")}</div>
      <div class="ready-next">${esc(p.next_step?.title || p.stage || "")}</div>
    </button>`).join("");
  list.querySelectorAll(".ready-item").forEach((b) => {
    b.addEventListener("click", () => focusLead(b.dataset.id));
  });
}

async function focusLead(id) {
  state.focusId = id;
  renderReady();
  busy(true, "Loading pipeline…");
  try {
    const ws = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
    state.workstream = ws;
    renderWorkstream();
  } catch (e) {
    toast(e.message);
  } finally {
    busy(false);
  }
}

function renderWorkstream() {
  const ws = state.workstream;
  if (!ws) return;
  $("#work-empty").hidden = true;
  $("#work-panel").hidden = false;

  const p = ws.prospect || {};
  $("#ws-company").textContent = p.company || "—";
  $("#ws-tier").textContent = `Tier ${p.tier || "—"} · score ${p.score ?? "—"}`;
  $("#ws-meta").textContent = [
    p.industry, p.geo, (p.recommended_packages || [])[0]?.name,
  ].filter(Boolean).join(" · ");
  $("#ws-pct").textContent = `${ws.progress?.pct ?? 0}%`;

  $("#ws-steps").innerHTML = (ws.steps || []).map((s, i) => `
    <li class="${s.done ? "done" : ""} ${ws.next_step?.id === s.id ? "current" : ""}">
      <span class="step-n">${s.done ? "✓" : i + 1}</span>
      <span class="step-t">${esc(s.title)}</span>
    </li>`).join("");

  const n = ws.next_step || {};
  $("#ws-next-title").textContent = n.title || "Done";
  $("#ws-next-detail").textContent = n.detail || "";
  $("#ws-output").hidden = true;
  $("#ws-form").hidden = true;
  $("#ws-form").innerHTML = "";

  const actions = $("#ws-actions");
  actions.innerHTML = (ws.actions || []).map((a) =>
    `<button type="button" class="btn ${a.id.includes("live") || a.id === "mark_contacted" || a.id === "build_sequences" || a.id === "qualify_reply" || a.id === "save_contact" ? "primary" : "ghost"} sm" data-act="${esc(a.id)}">${esc(a.label)}</button>`
  ).join("") || `<span class="muted">No actions — pick another lead or mark won.</span>`;

  // Always show copy if draft exists
  if (p.outreach_path || p.sequence_paths) {
    actions.innerHTML += ` <button type="button" class="btn ghost sm" data-act="copy_draft">Copy draft email</button>`;
  }

  actions.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => runAction(btn.dataset.act));
  });

  // Pre-load form for contact / reply
  if ((ws.actions || []).some((a) => a.type === "form_contact")) {
    showContactForm();
  }
  if ((ws.actions || []).some((a) => a.type === "form_reply")) {
    showReplyForm();
  }

  // Show draft preview if available
  loadDraftPreview(p);
}

function showContactForm() {
  const f = $("#ws-form");
  f.hidden = false;
  const c = (state.workstream?.prospect?.contacts || [])[0] || {};
  f.innerHTML = `
    <div class="form-row">
      <label>Name<input id="c-name" value="${esc(c.name || "")}" placeholder="Jordan Lee" /></label>
      <label>Title<input id="c-title" value="${esc(c.title || "")}" placeholder="Head of People" /></label>
    </div>
    <div class="form-row">
      <label>Email<input id="c-email" value="${esc(c.email || "")}" type="email" placeholder="jordan@company.com" /></label>
      <label>LinkedIn<input id="c-li" value="${esc(c.linkedin || "")}" placeholder="https://linkedin.com/in/…" /></label>
    </div>`;
}

function showReplyForm() {
  const f = $("#ws-form");
  f.hidden = false;
  f.innerHTML = `
    <label>Paste their reply
      <textarea id="c-reply" rows="4" placeholder="Thanks — can we talk next week?"></textarea>
    </label>`;
}

async function loadDraftPreview(p) {
  if (!p?.id) return;
  try {
    const full = await api(`/prospects/${encodeURIComponent(p.id)}`);
    const email = full.outreach?.email;
    const out = $("#ws-output");
    if (email?.body) {
      out.hidden = false;
      out.innerHTML = `<div class="email-preview"><strong>${esc(email.subject || "")}</strong>\n\n${esc(email.body)}</div>`;
      state._lastEmail = email;
    }
    if (full.brief_md) {
      out.hidden = false;
      out.innerHTML = (out.innerHTML || "") + `<div class="brief-box" style="margin-top:12px">${esc(full.brief_md)}</div>`;
    }
    state._focusFull = full;
  } catch (_) {}
}

async function runAction(act) {
  const id = state.focusId;
  if (!id) return;
  try {
    if (act === "save_contact") {
      const body = {
        name: $("#c-name")?.value || "",
        title: $("#c-title")?.value || "",
        email: $("#c-email")?.value || "",
        linkedin: $("#c-li")?.value || "",
      };
      if (!body.name && !body.email && !body.linkedin) {
        return toast("Add at least a name, email, or LinkedIn");
      }
      busy(true, "Saving contact…");
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/contact`, {
        method: "POST", body: JSON.stringify(body),
      });
      toast("Contact saved");
      renderWorkstream();
    } else if (act === "gamma_dry" || act === "gamma_live") {
      const p = state.workstream.prospect;
      busy(true, act === "gamma_live" ? "Generating Gamma…" : "Building prompt…");
      await api("/prospects/pipeline", {
        method: "POST",
        body: JSON.stringify({
          company: p.company,
          industry: p.industry || "",
          geo: p.geo || "",
          employee_range: p.employee_range || "",
          website: p.website || "",
          notes: p.notes || "",
          signals: p.signals || [],
          custom_hook: p.notes || "",
          generate_gamma: true,
          live_gamma: act === "gamma_live",
          draft_email: false,
          book: "corporate",
        }),
      });
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      toast(act === "gamma_live" ? "Gamma deck ready" : "Gamma prompt saved");
      renderWorkstream();
    } else if (act === "skip_gamma" || act === "draft_cold" || act === "build_sequences") {
      busy(true, "Drafting…");
      if (act === "build_sequences" || act === "skip_gamma") {
        await api(`/prospects/${encodeURIComponent(id)}/sequences`, { method: "POST", body: "{}" });
      } else {
        const p = state.workstream.prospect;
        await api("/prospects/pipeline", {
          method: "POST",
          body: JSON.stringify({
            company: p.company,
            industry: p.industry || "",
            geo: p.geo || "",
            signals: p.signals || [],
            draft_email: true,
            generate_gamma: false,
            book: "corporate",
            contact_name: (p.contacts || [])[0]?.name || "",
            contact_email: (p.contacts || [])[0]?.email || "",
            contact_title: (p.contacts || [])[0]?.title || "",
          }),
        });
      }
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      toast("Draft ready — copy and send from Gmail");
      renderWorkstream();
    } else if (act === "mark_contacted") {
      busy(true);
      await api(`/prospects/${encodeURIComponent(id)}/stage`, {
        method: "POST", body: JSON.stringify({ stage: "contacted", note: "Sent by desk" }),
      });
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      toast("Marked contacted");
      renderWorkstream();
      await softRefresh();
    } else if (act === "copy_draft") {
      let body = state._lastEmail?.body;
      if (!body && state._focusFull?.outreach?.email?.body) {
        body = state._focusFull.outreach.email.body;
      }
      if (!body) {
        const full = await api(`/prospects/${encodeURIComponent(id)}`);
        body = full.outreach?.email?.body;
        state._lastEmail = full.outreach?.email;
      }
      if (!body) return toast("No draft yet — build sequence first");
      await navigator.clipboard.writeText(body);
      toast("Email copied — paste into Gmail, then mark contacted");
    } else if (act === "qualify_reply") {
      const reply_text = $("#c-reply")?.value?.trim();
      if (!reply_text) return toast("Paste their reply first");
      busy(true, "Qualifying…");
      const out = await api(`/prospects/${encodeURIComponent(id)}/interested`, {
        method: "POST", body: JSON.stringify({ reply_text }),
      });
      toast(out.qualification?.ready_for_edyta ? "Warm lead — Edyta brief ready" : `→ ${out.qualification?.recommended_stage}`);
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      renderWorkstream();
      await softRefresh();
    } else if (act === "open_brief") {
      const full = await api(`/prospects/${encodeURIComponent(id)}`);
      if (full.brief_md) {
        $("#ws-output").hidden = false;
        $("#ws-output").innerHTML = `<div class="brief-box">${esc(full.brief_md)}</div>`;
      } else toast("No brief yet");
    } else if (act === "rescore") {
      const p = state.workstream.prospect;
      busy(true, "Re-scoring…");
      await api("/prospects/pipeline", {
        method: "POST",
        body: JSON.stringify({
          company: p.company,
          industry: p.industry || "",
          geo: p.geo || "",
          signals: p.signals || [],
          draft_email: false,
          book: "corporate",
        }),
      });
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      renderWorkstream();
      toast("Re-scored");
    }
  } catch (e) {
    toast(e.message);
  } finally {
    busy(false);
  }
}

/* ── Library ─────────────────────────────────────────────────────────────── */

function renderLibrary() {
  const q = ($("#lib-search")?.value || "").toLowerCase();
  const tier = $("#lib-tier")?.value || "";
  const status = $("#lib-status")?.value || "";
  let rows = state.library || [];
  if (q) rows = rows.filter((r) => (r.company || "").toLowerCase().includes(q));
  if (tier) rows = rows.filter((r) => r.qualification?.tier === tier);
  if (status === "pending") rows = rows.filter((r) => !r.in_crm);
  if (status === "in_crm") rows = rows.filter((r) => r.in_crm);

  const tbody = $("#lib-table tbody");
  tbody.innerHTML = rows.map((r) => {
    const qual = r.qualification || {};
    return `<tr>
      <td class="company-cell">${esc(r.company)}</td>
      <td><span class="${tierClass(qual.tier)}">${esc(qual.tier || "—")}</span></td>
      <td>${qual.score ?? "—"}</td>
      <td>${esc(qual.primary_package || "—")}</td>
      <td class="muted" style="max-width:180px;font-size:12px">${esc((qual.matched_signals || r.signals || []).slice(0, 3).join(", "))}</td>
      <td>${r.in_crm ? `<span class="pill">CRM · ${esc((r.crm_stage || "").replace(/_/g, " "))}</span>` : `<span class="pill tier-c">Pending</span>`}</td>
      <td>${r.prospect_id
        ? `<button class="btn text sm" data-work="${esc(r.prospect_id)}">Work →</button>`
        : `<span class="muted">Sync first</span>`}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">Library empty — hit Refresh leads</td></tr>`;

  tbody.querySelectorAll("[data-work]").forEach((b) => {
    b.addEventListener("click", () => {
      showView("work");
      focusLead(b.dataset.work);
    });
  });
}

function renderEdyta() {
  const home = state.edyta || {};
  $("#edyta-message").textContent = home.message || "";
  const all = [
    ...(home.corporate_leads || []),
    ...(home.wedding_leads || []),
  ];
  const badge = $("#leads-badge");
  if (all.length) { badge.hidden = false; badge.textContent = all.length; }
  else badge.hidden = true;

  const list = $("#edyta-list");
  if (!all.length) {
    list.innerHTML = `<div class="panel empty-state"><h3>No warm leads</h3><p>When a reply is interested, it lands here with a brief.</p></div>`;
    return;
  }
  list.innerHTML = all.map((p) => `
    <article class="lead-card">
      <h4>${esc(p.company)}</h4>
      <p class="muted">${esc(p.stage)} · score ${p.score ?? "—"}</p>
      <p style="margin-top:8px;color:var(--cream)">${esc(p.reply_summary || p.agent_note || "")}</p>
      <button class="btn primary sm" style="margin-top:10px" data-work="${esc(p.id)}">Open in Work</button>
    </article>`).join("");
  list.querySelectorAll("[data-work]").forEach((b) =>
    b.addEventListener("click", () => { showView("work"); focusLead(b.dataset.work); }));
}

function renderWeddings() {
  const rows = state.wedding || [];
  const grid = $("#wedding-grid");
  if (!rows.length) {
    grid.innerHTML = `<div class="panel empty-state" style="grid-column:1/-1"><h3>No wedding leads</h3></div>`;
    return;
  }
  grid.innerHTML = rows.map((p) => `
    <article class="prospect-card">
      <h4>${esc(p.company)}</h4>
      <p class="meta">${esc(p.industry)} · ${esc(p.stage)}</p>
    </article>`).join("");
}

function renderPartners() {
  const rows = state.partners || [];
  $("#partner-list").innerHTML = rows.length
    ? rows.map((p) => `<article class="lead-card"><h4>${esc(p.name)}</h4><p class="muted">${esc(p.type)} · ${esc(p.geo)}</p><p style="margin-top:6px;color:var(--cream)">${esc(p.notes || "")}</p></article>`).join("")
    : `<div class="panel empty-state"><h3>No partners</h3></div>`;
}

async function softRefresh() {
  const [ready, edyta, lib] = await Promise.all([
    api("/work/ready?limit=8"),
    api("/edyta-home"),
    api("/library"),
  ]);
  state.ready = ready.items || [];
  state.edyta = edyta;
  state.library = lib.rows || [];
  $("#lib-summary").textContent =
    `${lib.total} qualified · ${lib.in_crm} in CRM · ${lib.pending} pending · ${lib.tier_a} tier A`;
  renderReady();
}

async function fullRefresh() {
  busy(true, "Loading desk…");
  try {
    // Auto-import anything pending so leads never linger
    try {
      const imp = await api("/library/import-all", { method: "POST" });
      if (imp.imported > 0) toast(`Synced ${imp.imported} new leads into CRM`);
    } catch (_) {}

    const [ready, edyta, lib, wedding, partners, me] = await Promise.all([
      api("/work/ready?limit=8"),
      api("/edyta-home"),
      api("/library"),
      api("/wedding/prospects").catch(() => []),
      api("/partnerships").catch(() => []),
      api("/me").catch(() => null),
    ]);
    state.ready = ready.items || [];
    state.edyta = edyta;
    state.library = lib.rows || [];
    state.wedding = wedding;
    state.partners = partners;
    if (me?.name) $("#brand-user").textContent = me.name;
    $("#lib-summary").textContent =
      `${lib.total} qualified · ${lib.in_crm} in CRM · ${lib.pending} pending · ${lib.tier_a} tier A`;
    renderReady();
    renderEdyta();
  } catch (e) {
    toast(e.message);
  } finally {
    busy(false);
  }
}

function boot() {
  if (!ensureAuth()) return;

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  $("#btn-sync-all")?.addEventListener("click", async () => {
    busy(true, "Importing all pending…");
    try {
      const r = await api("/library/import-all", { method: "POST" });
      toast(`Imported ${r.imported} into CRM`);
      await fullRefresh();
    } catch (e) { toast(e.message); }
    finally { busy(false); }
  });

  $("#btn-refresh-leads")?.addEventListener("click", async () => {
    busy(true, "Discovery agent searching for companies…");
    try {
      const r = await api("/leads/refresh", {
        method: "POST",
        body: JSON.stringify({ auto_import: true, draft_email: false }),
      });
      toast(`+${r.discovery_added} discovered · ${r.imported_to_crm} imported · ${r.qualified_tier_a} tier A`);
      await fullRefresh();
      showView("library");
    } catch (e) { toast(e.message); }
    finally { busy(false); }
  });

  $("#lib-search")?.addEventListener("input", renderLibrary);
  $("#lib-tier")?.addEventListener("change", renderLibrary);
  $("#lib-status")?.addEventListener("change", renderLibrary);

  $("#btn-wedding-import")?.addEventListener("click", async () => {
    try {
      const r = await api("/wedding/library/import", { method: "POST" });
      toast(`Wedding +${r.imported}`);
      state.wedding = await api("/wedding/prospects");
      renderWeddings();
    } catch (e) { toast(e.message); }
  });

  $("#btn-partner-seed")?.addEventListener("click", async () => {
    try {
      await api("/partnerships/seed", { method: "POST" });
      state.partners = await api("/partnerships");
      renderPartners();
      toast("Partners loaded");
    } catch (e) { toast(e.message); }
  });

  fullRefresh().then(() => {
    // Auto-open first ready lead for immediate flow
    if (state.ready?.[0]?.id) focusLead(state.ready[0].id);
  });
}

document.addEventListener("DOMContentLoaded", boot);
