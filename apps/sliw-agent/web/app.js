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
  materials: null,
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
    materials: ["Materials", "Master PDF & package links"],
  };
  const [t, e] = titles[name] || [name, ""];
  $("#view-title").textContent = t;
  $("#view-eyebrow").textContent = e;
  if (name === "library") renderLibrary();
  if (name === "edyta") renderEdyta();
  if (name === "weddings") renderWeddings();
  if (name === "partners") renderPartners();
  if (name === "materials") loadMaterials();
  if (name === "work") renderReady();
}

async function loadMaterials() {
  try {
    const meta = await api("/master-deck");
    state.materials = meta;
    renderMaterials();
  } catch (e) {
    toast(e.message);
  }
}

function renderMaterials() {
  const m = state.materials || {};
  // Accept file on disk OR any usable pdf_url
  const hasPdf = !!(m.pdf_uploaded || (m.pdf_bytes && m.pdf_bytes > 100) || m.pdf_url);
  const pdfHref = m.pdf_preview_url || m.pdf_url || "/sliw/media/master-packages.pdf";
  const title = $("#pdf-status-title");
  const detail = $("#pdf-status-detail");
  const view = $("#pdf-view-link");
  const del = $("#pdf-delete-btn");
  const frame = $("#pdf-preview-frame");
  const empty = $("#pdf-preview-empty");
  const storage = $("#pdf-storage-hint");

  if (title) {
    title.textContent = hasPdf ? "PDF ready ✓" : "No PDF on server yet";
  }
  if (detail) {
    if (hasPdf) {
      const kb = m.pdf_bytes ? `${Math.round(m.pdf_bytes / 1024)} KB` : "";
      const when = m.pdf_uploaded_at ? m.pdf_uploaded_at.replace("T", " ").slice(0, 16) + " UTC" : "";
      const orig = m.pdf_original_name || m.pdf_filename || "master_packages.pdf";
      detail.innerHTML = `<strong>${esc(orig)}</strong>${kb ? " · " + esc(kb) : ""}${when ? " · " + esc(when) : ""}<br/><span class="muted">Linked in new outreach emails (browser link, not attachment).</span>`;
    } else {
      detail.textContent = "Upload your master packages PDF. After a successful upload you’ll see a live preview here.";
    }
  }
  if (view) {
    view.hidden = !hasPdf;
    if (hasPdf) view.href = pdfHref;
  }
  if (del) del.hidden = !hasPdf;

  // Live preview card
  if (frame && empty) {
    if (hasPdf) {
      empty.hidden = true;
      frame.hidden = false;
      // cache-bust so replace shows new file
      frame.src = pdfHref + (pdfHref.includes("?") ? "&" : "?") + "t=" + Date.now();
    } else {
      frame.hidden = true;
      frame.removeAttribute("src");
      empty.hidden = false;
    }
  }
  if (storage) {
    storage.textContent = m.data_dir
      ? `Storage: ${m.data_dir} (must be on Railway volume / STOCKS_FOLDER to survive redeploys)`
      : "";
  }
  if (m.gamma_site && $("#gamma-site-link")) {
    $("#gamma-site-link").href = m.gamma_site;
  }
  if (m.corporate_page && $("#corporate-page-link")) {
    $("#corporate-page-link").href = m.corporate_page;
  }
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

async function focusLead(id, { autoAgent = true } = {}) {
  state.focusId = id;
  renderReady();
  busy(true, "Loading pipeline…");
  try {
    let ws = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
    state.workstream = ws;
    renderWorkstream();
    // Auto-run sales agent when contacts/drafts missing — you should not fill contacts manually
    const needAgent = (ws.next_step?.id === "agent" || ws.next_step?.id === "qualify") && autoAgent;
    if (needAgent) {
      busy(true, "Sales agent finding contacts & drafting pitch…");
      try {
        const result = await api(`/prospects/${encodeURIComponent(id)}/sales-agent`, {
          method: "POST",
          body: JSON.stringify({ live_gamma: false, build_sequences: false }),
        });
        toast(`Agent ready: ${result.primary_contact?.email || result.primary_contact?.name || "contact"} · mode ${result.marketing_mode}`);
        state._lastAgent = result;
        state._lastEmail = result.email_preview; // cold_1 only
        state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
        // One render: contacts + single labeled first-touch (no duplicate body)
        await renderWorkstream();
      } catch (e) {
        toast("Agent: " + e.message);
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    busy(false);
  }
}

function isHunterSource(src) {
  return String(src || "") === "hunter.io";
}

function hunterBadge(src) {
  if (!isHunterSource(src)) return "";
  return `<span class="hunter-badge" title="Verified via Hunter.io API">Hunter ✓</span>`;
}

function contactCardHtml(primary, contacts, research, diagnostics) {
  const c = primary || {};
  const list = (contacts || []).filter((x) => x && (x.email || x.name));
  const hasHunter = isHunterSource(c.source) || list.some((x) => isHunterSource(x.source));
  const hasReal = list.some((x) => x.email && x.source !== "role_inbox_guess" && x.source !== "hunter.io_error");
  const keyPresent = diagnostics?.hunter_key_present;
  const keyBadge = keyPresent
    ? (hasHunter
      ? `<span class="hunter-badge hunter-badge-lg" title="Hunter API used">Hunter ✓</span>`
      : `<span class="hunter-badge hunter-badge-warn" title="Key present but no personal email for this domain">Hunter key · no hit</span>`)
    : `<span class="hunter-badge hunter-badge-off" title="HUNTER_API_KEY not visible to server">Hunter key missing</span>`;
  return `
    <div class="contact-card ${hasReal ? "found" : "weak"} ${hasHunter ? "hunter" : ""}">
      <div class="contact-card-head">
        <p class="eyebrow">Send to</p>
        ${keyBadge}
      </div>
      <div class="contact-primary">
        <div class="contact-name">${esc(c.name || "No name found")}${isHunterSource(c.source) ? " " + hunterBadge(c.source) : ""}</div>
        <div class="contact-email">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "<span class='muted'>No email yet</span>"}</div>
        ${c.title ? `<div class="contact-title">${esc(c.title)}</div>` : ""}
      </div>
      ${research ? `<p class="muted" style="margin-top:8px">${esc(research)}</p>` : ""}
      ${diagnostics?.domain ? `<p class="muted" style="font-size:11px">Domain searched: <code>${esc(diagnostics.domain)}</code></p>` : ""}
      ${list.length ? `
        <p class="eyebrow" style="margin-top:12px">Contacts found</p>
        <ul class="contact-list">${list.slice(0, 6).map((x) => `
          <li>
            <strong>${esc(x.name || "—")}</strong>${isHunterSource(x.source) ? " " + hunterBadge(x.source) : ""}
            ${x.email ? ` · <a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : " · <span class='muted'>no email</span>"}
            ${x.title ? `<div class="muted">${esc(x.title)}</div>` : ""}
            <div class="muted" style="font-size:11px">${esc(x.source || "")}${x.confidence ? ` · ${x.confidence}%` : ""}</div>
          </li>`).join("")}
        </ul>` : ""}
    </div>`;
}

function emailBlockHtml(stepLabel, stepHint, email, copyAct) {
  if (!email?.body) return "";
  return `
    <div class="email-step-card">
      <div class="email-step-head">
        <div>
          <p class="eyebrow">${esc(stepLabel)}</p>
          <p class="muted" style="margin-top:2px">${esc(stepHint)}</p>
        </div>
        ${copyAct ? `<button type="button" class="btn ghost sm" data-act="${esc(copyAct)}">Copy this email</button>` : ""}
      </div>
      <div class="email-preview"><strong>${esc(email.subject || "")}</strong>\n\n${esc(email.body)}</div>
    </div>`;
}

/**
 * One clear panel: contacts once, then email sequence steps (not the same body twice).
 * cold_1 = first touch only until you send.
 * follow_2 = only after mark contacted + "Create follow-up".
 */
async function renderWorkstream() {
  const ws = state.workstream;
  if (!ws) return;
  $("#work-empty").hidden = true;
  $("#work-panel").hidden = false;

  const p = ws.prospect || {};
  const primary = ws.primary_contact || (p.contacts || [])[0] || {};
  const contacts = ws.contacts || p.contacts || [];

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
  const toLine = primary.email
    ? `To: ${primary.name || "Contact"} <${primary.email}>`
    : (primary.name ? `Contact: ${primary.name} (no email yet)` : (n.detail || ""));
  $("#ws-next-detail").textContent = toLine;

  $("#ws-form").hidden = true;
  $("#ws-form").innerHTML = "";

  const actions = $("#ws-actions");
  actions.innerHTML = (ws.actions || []).map((a) =>
    `<button type="button" class="btn ${a.id.includes("live") || a.id === "mark_contacted" || a.id === "copy_cold" || a.id === "qualify_reply" || a.id === "run_sales_agent" ? "primary" : "ghost"} sm" data-act="${esc(a.id)}">${esc(a.label)}</button>`
  ).join("") || `<span class="muted">No actions — pick another lead or mark won.</span>`;

  actions.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => runAction(btn.dataset.act));
  });

  if ((ws.actions || []).some((a) => a.type === "form_reply")) {
    showReplyForm();
  }

  const out = $("#ws-output");
  out.hidden = false;
  out.innerHTML = contactCardHtml(
    primary,
    contacts,
    p.contact_research || state._lastAgent?.contact_research || "",
    p.hunter_diagnostics || state._lastAgent?.hunter_diagnostics || null
  );

  // Pitch meta (no email body here — body lives only in sequence section below)
  const agent = state._lastAgent;
  const pitchUrl = agent?.pitch_url || agent?.master_deck_url || p.master_deck_url || p.gamma_url;
  out.innerHTML += `
    <div class="agent-card">
      <p class="eyebrow">Assets (links in the email — not attachments)</p>
      <p class="muted">
        ${pitchUrl ? `<a href="${esc(pitchUrl)}" target="_blank" rel="noopener">Packages overview</a>` : "—"}
        · <a href="https://edytasliwinska.com/corporate" target="_blank" rel="noopener">Corporate page</a>
      </p>
      <p class="muted" style="margin-top:8px">
        <strong>Email sequence:</strong> only <em>Email 1 — first touch</em> until you send.
        Email 2 appears after you mark contacted and create a follow-up. They are different messages.
      </p>
    </div>
    <div id="email-sequence-panel"></div>`;

  await loadEmailSequence(p.id);
}

async function loadEmailSequence(prospectId) {
  const panel = $("#email-sequence-panel");
  if (!panel || !prospectId) return;
  try {
    const full = await api(`/prospects/${encodeURIComponent(prospectId)}`);
    state._focusFull = full;

    // Cold = primary outreach file (always first touch)
    let cold = full.outreach?.email || null;
    if (cold) {
      cold = { ...cold, sequence_step: full.outreach?.sequence_step || "cold_1" };
      state._lastEmail = cold;
      state._coldEmail = cold;
    } else if (state._lastAgent?.email_preview?.body) {
      cold = { ...state._lastAgent.email_preview, sequence_step: "cold_1" };
      state._coldEmail = cold;
      state._lastEmail = cold;
    }

    // Follow-up only if stored separately (not the same as cold)
    let follow = null;
    const followPath = full.outreach_follow_2 || (full.sequence_paths && full.sequence_paths.follow_2);
    // If API embeds follow email later; for now check outreach_follow_2_email or similar
    if (full.followup_email?.body) {
      follow = { ...full.followup_email, sequence_step: "follow_2" };
    }
    if (state._followEmail?.body) {
      follow = state._followEmail;
    }

    // Never show the same body twice
    if (follow && cold && follow.body === cold.body) {
      follow = null;
    }

    let html = "";
    if (cold?.body) {
      html += emailBlockHtml(
        "Email 1 — First touch (send this now)",
        "Cold open. Do not send a follow-up until this one goes out.",
        cold,
        "copy_cold"
      );
    } else {
      html += `<p class="muted">No first-touch draft yet — run the sales agent.</p>`;
    }
    if (follow?.body) {
      html += emailBlockHtml(
        "Email 2 — Follow-up (only after Email 1 was sent)",
        "Gentle bump. Create this after you mark contacted.",
        follow,
        "copy_follow"
      );
    } else if ((full.stage === "contacted" || full.stage === "replied") && !follow) {
      html += `<p class="muted" style="margin-top:12px">No follow-up draft yet. Use <strong>Create follow-up email</strong> when ready.</p>`;
    }

    if (full.brief_md) {
      html += `<div class="brief-box" style="margin-top:12px">${esc(full.brief_md)}</div>`;
    }
    panel.innerHTML = html;
    panel.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => runAction(btn.dataset.act));
    });
  } catch (_) {
    panel.innerHTML = "";
  }
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

async function runAction(act) {
  const id = state.focusId;
  if (!id) return;
  try {
    if (act === "run_sales_agent" || act === "run_sales_agent_live_gamma") {
      busy(true, "Sales agent: finding contacts, pitch mode, drafts…");
      const result = await api(`/prospects/${encodeURIComponent(id)}/sales-agent`, {
        method: "POST",
        body: JSON.stringify({
          live_gamma: act === "run_sales_agent_live_gamma",
          build_sequences: false,
        }),
      });
      state._lastAgent = result;
      state._lastEmail = result.email_preview;
      state._coldEmail = result.email_preview;
      state._followEmail = null; // clear any old follow-up view
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      await renderWorkstream();
      toast(`First-touch ready (${result.marketing_mode})`);
    } else if (act === "mark_contacted") {
      busy(true);
      await api(`/prospects/${encodeURIComponent(id)}/stage`, {
        method: "POST", body: JSON.stringify({ stage: "contacted", note: "Sent by desk" }),
      });
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      toast("Marked contacted — waiting on reply");
      renderWorkstream();
      await softRefresh();
    } else if (act === "copy_cold" || act === "copy_draft") {
      const email = state._coldEmail || state._lastAgent?.email_preview || state._lastEmail;
      let body = email?.body;
      let subj = email?.subject || "";
      if (!body) {
        const full = await api(`/prospects/${encodeURIComponent(id)}`);
        body = full.outreach?.email?.body;
        subj = full.outreach?.email?.subject || "";
        state._coldEmail = full.outreach?.email;
      }
      if (!body) return toast("No first-touch draft — run sales agent first");
      await navigator.clipboard.writeText((subj ? `Subject: ${subj}\n\n` : "") + body);
      const to = state._lastAgent?.primary_contact?.email || state.workstream?.primary_contact?.email || "";
      toast(to ? `Email 1 (first touch) copied → ${to}` : "Email 1 (first touch) copied");
    } else if (act === "copy_follow") {
      const email = state._followEmail;
      if (!email?.body) return toast("No follow-up yet — create one after marking contacted");
      await navigator.clipboard.writeText(
        (email.subject ? `Subject: ${email.subject}\n\n` : "") + email.body
      );
      toast("Email 2 (follow-up) copied");
    } else if (act === "prepare_followup") {
      busy(true, "Creating follow-up (only after cold was sent)…");
      const out = await api(`/prospects/${encodeURIComponent(id)}/followup`, { method: "POST" });
      state._followEmail = { ...out.email_preview, sequence_step: "follow_2" };
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      await renderWorkstream();
      toast("Email 2 (follow-up) ready — different from first touch");
    } else if (act === "qualify_reply") {
      const reply_text = $("#c-reply")?.value?.trim();
      if (!reply_text) return toast("Paste their reply first");
      busy(true, "Qualifying…");
      const out = await api(`/prospects/${encodeURIComponent(id)}/interested`, {
        method: "POST", body: JSON.stringify({ reply_text }),
      });
      toast(out.qualification?.ready_for_edyta ? "→ Edyta pipeline + brief" : `→ ${out.qualification?.recommended_stage}`);
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      renderWorkstream();
      await softRefresh();
    } else if (act === "escalate_edyta") {
      busy(true, "Escalating to Edyta…");
      const out = await api(`/prospects/${encodeURIComponent(id)}/escalate-edyta`, {
        method: "POST",
        body: JSON.stringify({
          reply_text: $("#c-reply")?.value || "Desk escalated — discovery requested",
        }),
      });
      toast("On Edyta’s desk with brief");
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
      renderWorkstream();
      if (out.edyta_brief_path) {
        const full = await api(`/prospects/${encodeURIComponent(id)}`);
        if (full.brief_md) {
          $("#ws-output").hidden = false;
          $("#ws-output").innerHTML = `<div class="brief-box">${esc(full.brief_md)}</div>`;
        }
      }
      await softRefresh();
    } else if (act === "open_brief") {
      const full = await api(`/prospects/${encodeURIComponent(id)}`);
      if (full.brief_md) {
        $("#ws-output").hidden = false;
        $("#ws-output").innerHTML = `<div class="brief-box">${esc(full.brief_md)}</div>`;
      } else toast("No brief yet — escalate or qualify a warm reply");
    } else if (act === "save_contact") {
      // Manual override only if agent failed
      const body = {
        name: $("#c-name")?.value || "",
        title: $("#c-title")?.value || "",
        email: $("#c-email")?.value || "",
        linkedin: $("#c-li")?.value || "",
      };
      busy(true, "Saving…");
      state.workstream = await api(`/prospects/${encodeURIComponent(id)}/contact`, {
        method: "POST", body: JSON.stringify(body),
      });
      renderWorkstream();
      toast("Contact saved");
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

  $("#btn-agent-batch")?.addEventListener("click", async () => {
    busy(true, "Sales agent running on top 5 (contacts + pitches)…");
    try {
      const r = await api("/sales-agent/batch", {
        method: "POST",
        body: JSON.stringify({ limit: 5, live_gamma: false }),
      });
      toast(`Agent finished ${r.ran} leads` + (r.errors?.length ? ` (${r.errors.length} errors)` : ""));
      await fullRefresh();
      if (r.results?.[0]?.prospect_id) {
        showView("work");
        state._lastAgent = r.results[0];
        state._coldEmail = r.results[0].email_preview;
        await focusLead(r.results[0].prospect_id, { autoAgent: false });
      }
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

  // Master PDF upload
  $("#pdf-file-input")?.addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast("Please choose a PDF file");
      return;
    }
    busy(true, "Uploading master PDF…");
    const msg = $("#pdf-upload-msg");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const token = localStorage.getItem(TOKEN_KEY) || "";
      const res = await fetch(`${API}/master-deck/pdf`, {
        method: "POST",
        headers: token ? { "x-auth-v2-token": token } : {},
        body: fd,
      });
      if (!res.ok) {
        let err = res.statusText;
        try { err = (await res.json()).detail || err; } catch (_) {}
        throw new Error(err);
      }
      const data = await res.json();
      state.materials = data;
      renderMaterials();
      toast("Master PDF uploaded — linked in new outreach");
      if (msg) msg.textContent = `Uploaded. Public link: ${data.pdf_url || "/sliw/media/master-packages.pdf"}`;
    } catch (e) {
      toast(e.message);
      if (msg) msg.textContent = e.message;
    } finally {
      busy(false);
      ev.target.value = "";
    }
  });

  $("#pdf-delete-btn")?.addEventListener("click", async () => {
    if (!confirm("Remove the master PDF from the server?")) return;
    try {
      await api("/master-deck/pdf", { method: "DELETE" });
      toast("PDF removed");
      await loadMaterials();
    } catch (e) { toast(e.message); }
  });

  fullRefresh().then(() => {
    // Auto-open first ready lead for immediate flow
    if (state.ready?.[0]?.id) focusLead(state.ready[0].id);
  });
}

document.addEventListener("DOMContentLoaded", boot);
