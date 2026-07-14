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

/* ── Company brand marks (logo via domain, initials fallback) ─────────────── */

/** Well-known domains when website is missing or wrong. */
const COMPANY_DOMAINS = {
  airbnb: "airbnb.com",
  salesforce: "salesforce.com",
  stripe: "stripe.com",
  genentech: "gene.com",
  google: "google.com",
  meta: "meta.com",
  facebook: "meta.com",
  apple: "apple.com",
  microsoft: "microsoft.com",
  amazon: "amazon.com",
  netflix: "netflix.com",
  uber: "uber.com",
  lyft: "lyft.com",
  adobe: "adobe.com",
  oracle: "oracle.com",
  nvidia: "nvidia.com",
  intel: "intel.com",
  cisco: "cisco.com",
  zoom: "zoom.us",
  slack: "slack.com",
  shopify: "shopify.com",
  square: "squareup.com",
  block: "block.xyz",
  paypal: "paypal.com",
  visa: "visa.com",
  mastercard: "mastercard.com",
  nike: "nike.com",
  "lululemon": "lululemon.com",
  "goldman sachs": "goldmansachs.com",
  jpmorgan: "jpmorgan.com",
  "jp morgan": "jpmorgan.com",
  "morgan stanley": "morganstanley.com",
  "bank of america": "bankofamerica.com",
  wells: "wellsfargo.com",
  "wells fargo": "wellsfargo.com",
  disney: "disney.com",
  "warner bros": "warnerbros.com",
  netflix: "netflix.com",
  spotify: "spotify.com",
  twitter: "x.com",
  x: "x.com",
  linkedin: "linkedin.com",
  tesla: "tesla.com",
  openai: "openai.com",
  anthropic: "anthropic.com",
  "databricks": "databricks.com",
  snowflake: "snowflake.com",
  "roblox": "roblox.com",
  "electronic arts": "ea.com",
  ea: "ea.com",
  activision: "activision.com",
  "the trade desk": "thetradedesk.com",
  "tiktok": "tiktok.com",
  bytedance: "bytedance.com",
};

function companyInitials(name) {
  const parts = String(name || "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function brandHue(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function extractDomain(website, company) {
  const raw = String(website || "").trim();
  if (raw) {
    try {
      const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const host = new URL(withProto).hostname.replace(/^www\./i, "").toLowerCase();
      if (host && host.includes(".")) return host;
    } catch {
      /* fall through */
    }
  }
  const key = String(company || "").trim().toLowerCase();
  if (COMPANY_DOMAINS[key]) return COMPANY_DOMAINS[key];
  // soft match: "Airbnb Inc" → airbnb
  for (const [k, domain] of Object.entries(COMPANY_DOMAINS)) {
    if (key === k || key.startsWith(k + " ") || key.includes(" " + k + " ")) return domain;
  }
  return "";
}

function logoCandidates(domain) {
  if (!domain) return [];
  const d = encodeURIComponent(domain);
  // Prefer clearer brand marks first; favicons as reliable fallback
  return [
    `https://unavatar.io/${d}?fallback=false`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

/**
 * Brand mark HTML: logo image with multi-source fallback → initials tile.
 * size: "sm" | "md" | "lg"
 */
function brandMarkHtml(company, website, { size = "md" } = {}) {
  const domain = extractDomain(website, company);
  const initials = companyInitials(company);
  const hue = brandHue(company);
  const urls = logoCandidates(domain);
  const first = urls[0] || "";
  const rest = urls.slice(1).join("|");
  const img = first
    ? `<img class="brand-logo-img" src="${esc(first)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallbacks="${esc(rest)}" onerror="window.__brandLogoFallback && window.__brandLogoFallback(this)" />`
    : "";
  return `<span class="brand-mark brand-mark-${size}${first ? "" : " is-fallback"}" style="--brand-hue:${hue}" title="${esc(company || "")}${domain ? " · " + esc(domain) : ""}">
    ${img}
    <span class="brand-initials" aria-hidden="true">${esc(initials)}</span>
  </span>`;
}

window.__brandLogoFallback = function (img) {
  const parent = img.closest(".brand-mark");
  const chain = (img.dataset.fallbacks || "").split("|").filter(Boolean);
  if (chain.length) {
    img.dataset.fallbacks = chain.slice(1).join("|");
    img.src = chain[0];
    return;
  }
  img.remove();
  if (parent) parent.classList.add("is-fallback");
};

function brandWashStyle(company) {
  const hue = brandHue(company);
  return `--brand-hue:${hue};--brand-a:hsla(${hue},42%,38%,0.55);--brand-b:hsla(${(hue + 40) % 360},35%,22%,0.75)`;
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
  if (name === "weddings") {
    if (!state.wedding?.length) {
      loadWeddingRows().then((rows) => {
        state.wedding = rows;
        renderWeddings();
      });
    } else {
      renderWeddings();
    }
  }
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
    const parts = [];
    if (m.data_dir) {
      parts.push(`Local: ${m.data_dir}`);
    }
    const dbx = m.dropbox || {};
    const dbxPath = m.dropbox_path || dbx.path || "/Apps/Sliw/master_packages.pdf";
    if (dbx.ok || m.dropbox_ok) {
      parts.push(`Dropbox: ${dbxPath} ✓`);
    } else if (dbx.configured || dbx.folder) {
      const err = dbx.error || m.dropbox_error;
      parts.push(err
        ? `Dropbox: ${dbxPath} (mirror error: ${err})`
        : `Dropbox: ${dbxPath} (mirrored on next upload)`);
    } else {
      parts.push(`Dropbox: ${dbxPath} (set DROPBOX_* env to enable)`);
    }
    if (m.dropbox_shared_url) {
      parts.push("Shared link ready");
    }
    storage.textContent = parts.join(" · ");
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
    <button type="button" class="ready-item ${state.focusId === p.id ? "active" : ""}" data-id="${esc(p.id)}" style="${brandWashStyle(p.company)}">
      <span class="ready-item-wash" aria-hidden="true"></span>
      <span class="ready-item-inner">
        ${brandMarkHtml(p.company, p.website, { size: "md" })}
        <span class="ready-item-copy">
          <span class="ready-top">
            <strong>${esc(p.company)}</strong>
            <span class="${tierClass(p.tier)}">${esc(p.tier)}</span>
          </span>
          <span class="ready-meta">Score ${p.score ?? "—"} · ${esc(p.package || "—")}</span>
          <span class="ready-next">${esc(p.next_step?.title || p.stage || "")}</span>
        </span>
      </span>
    </button>`).join("");
  list.querySelectorAll(".ready-item").forEach((b) => {
    b.addEventListener("click", () => focusLead(b.dataset.id));
  });
}

async function focusLead(id, { autoAgent = true } = {}) {
  id = String(id || "").trim();
  if (!id) {
    toast("Missing lead id — re-import wedding seeds");
    return;
  }
  state.focusId = id;
  // Always land on Work so wedding clicks leave the Weddings tab
  showView("work");
  renderReady();
  if (typeof renderWeddings === "function") {
    try { renderWeddings(); } catch (_) {}
  }
  busy(true, "Loading pipeline…");
  try {
    let ws = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
    state.workstream = ws;
    await renderWorkstream();
    // Auto-run sales agent when contacts/drafts missing — you should not fill contacts manually
    const needAgent = (ws.next_step?.id === "agent" || ws.next_step?.id === "qualify") && autoAgent;
    if (needAgent) {
      const isWedding = (ws.prospect?.book || "") === "wedding";
      busy(true, isWedding
        ? "Wedding agent finding planner contacts & drafting pitch…"
        : "Sales agent finding contacts & drafting pitch…");
      try {
        const result = await api(`/prospects/${encodeURIComponent(id)}/sales-agent`, {
          method: "POST",
          body: JSON.stringify({ live_gamma: false, build_sequences: false }),
        });
        toast(`Agent ready: ${result.primary_contact?.email || result.primary_contact?.name || "contact"} · mode ${result.marketing_mode || "wedding"}`);
        state._lastAgent = result;
        state._lastEmail = result.email_preview; // cold_1 only
        state.workstream = await api(`/prospects/${encodeURIComponent(id)}/workstream`);
        // One render: contacts + single labeled first-touch (no duplicate body)
        await renderWorkstream();
      } catch (e) {
        toast("Agent: " + e.message);
        // Still show the lead panel even if agent fails
        try { await renderWorkstream(); } catch (_) {}
      }
    }
  } catch (e) {
    toast("Could not open lead: " + e.message);
    console.error("focusLead failed", id, e);
  } finally {
    busy(false);
  }
}

/** Normalize wedding API payload → clickable card rows (always has id). */
function normalizeWeddingRows(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : (payload?.items || payload?.prospects || []);
  return (raw || []).map((p) => {
    const pkg = (p.recommended_packages || [])[0] || {};
    return {
      id: p.id,
      company: p.company,
      website: p.website || "",
      industry: p.industry || "",
      geo: p.geo || "",
      score: p.score,
      tier: p.tier,
      stage: p.stage,
      package: p.package || pkg.name || "",
      channel_label: p.channel_label || p.industry || "",
      agent_note: p.agent_note || "",
      book: "wedding",
      has_draft: !!(p.has_draft || p.outreach_path || p.sequence_paths),
      has_contact: !!(p.has_contact || (p.contacts && p.contacts.length)),
    };
  }).filter((p) => p.id && p.company);
}

async function loadWeddingRows() {
  try {
    const ready = await api("/wedding/ready?limit=40");
    return normalizeWeddingRows(ready);
  } catch (_) {
    // Older deploy without /wedding/ready
    try {
      const list = await api("/wedding/prospects");
      return normalizeWeddingRows(list);
    } catch (e2) {
      console.error(e2);
      return [];
    }
  }
}

function openWeddingLead(id) {
  const lead = (state.wedding || []).find((p) => p.id === id);
  toast(lead ? `Opening ${lead.company}…` : "Opening wedding lead…");
  focusLead(id, { autoAgent: true });
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

  const head = $("#work-client-head");
  if (head) {
    head.style.cssText = brandWashStyle(p.company);
    head.classList.add("has-brand");
  }
  const art = $("#ws-brand-art");
  if (art) {
    art.innerHTML = brandMarkHtml(p.company, p.website, { size: "lg" });
  }

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
  const isWedding = (p.book || agent?.book) === "wedding";
  const pitchUrl = agent?.pitch_url || agent?.master_deck_url || p.master_deck_url || p.gamma_url
    || (isWedding ? "https://edytasliwinska.com/weddings" : "https://edytasliwinska.com/corporate");
  const siteLabel = isWedding ? "Weddings page" : "Corporate page";
  const siteHref = isWedding ? "https://edytasliwinska.com/weddings" : "https://edytasliwinska.com/corporate";
  out.innerHTML += `
    <div class="agent-card">
      <p class="eyebrow">${isWedding ? "Wedding assets (planner / venue pitch)" : "Assets (links in the email — not attachments)"}</p>
      <p class="muted">
        ${pitchUrl ? `<a href="${esc(pitchUrl)}" target="_blank" rel="noopener">Packages overview</a>` : "—"}
        · <a href="${esc(siteHref)}" target="_blank" rel="noopener">${esc(siteLabel)}</a>
        ${isWedding ? " · Partnership-first outreach" : ""}
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
  if (!grid) return;
  const summary = $("#wedding-summary");
  if (summary) {
    const planners = rows.filter((p) => /planner/i.test(p.industry || "")).length;
    const venues = rows.filter((p) => /venue|winery|hotel/i.test(p.industry || "")).length;
    const a = rows.filter((p) => p.tier === "A").length;
    summary.textContent = rows.length
      ? `${rows.length} leads · ${planners} planners · ${venues} venues · ${a} tier A`
      : "No wedding leads yet — Import & score seeds";
  }
  if (!rows.length) {
    grid.innerHTML = `<div class="panel empty-state" style="grid-column:1/-1">
      <h3>No wedding leads scored yet</h3>
      <p class="muted">Click <strong>Import &amp; score seeds</strong> to load Bay Area planners + venues into the wedding CRM.</p>
    </div>`;
    return;
  }
  grid.innerHTML = rows.map((p) => {
    const isPlanner = /planner/i.test(p.industry || "");
    const isVenue = /venue|winery|hotel|lodge/i.test(p.industry || "");
    const channel = isPlanner ? "Planner partner" : isVenue ? "Venue partner" : (p.channel_label || p.industry || "Wedding");
    const id = esc(p.id);
    return `
    <article class="prospect-card wedding-card ${state.focusId === p.id ? "active" : ""}" data-work="${id}" role="button" tabindex="0" aria-label="Open ${esc(p.company)} in Work">
      <div class="wedding-card-top">
        ${brandMarkHtml(p.company, p.website, { size: "md" })}
        <div class="wedding-card-copy">
          <div class="top">
            <h4>${esc(p.company)}</h4>
            <span class="${tierClass(p.tier)}">${esc(p.tier || "—")}</span>
          </div>
          <p class="meta">${esc(channel)} · ${esc(p.geo || "Bay Area")}</p>
        </div>
        <div class="score-ring" title="ICP score">${p.score ?? "—"}</div>
      </div>
      <p class="wedding-card-pkg">${esc(p.package || "—")}</p>
      <div class="foot">
        <span>${esc(p.stage || "scored")}${p.has_draft ? " · draft ready" : ""}${p.has_contact ? " · contacts" : ""}</span>
        <button type="button" class="btn primary sm wedding-open-btn" data-work="${id}">Open in Work →</button>
      </div>
    </article>`;
  }).join("");
  // Handlers are delegated on #wedding-grid (boot) so re-renders always work
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

    const [ready, edyta, lib, weddingRows, partners, me] = await Promise.all([
      api("/work/ready?limit=8"),
      api("/edyta-home"),
      api("/library"),
      loadWeddingRows(),
      api("/partnerships").catch(() => []),
      api("/me").catch(() => null),
    ]);
    state.ready = ready.items || [];
    state.edyta = edyta;
    state.library = lib.rows || [];
    state.wedding = weddingRows || [];
    state.partners = partners;
    if (me?.name) $("#brand-user").textContent = me.name;
    $("#lib-summary").textContent =
      `${lib.total} qualified · ${lib.in_crm} in CRM · ${lib.pending} pending · ${lib.tier_a} tier A`;
    renderReady();
    renderEdyta();
    renderWeddings();
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

  // Wedding cards: event delegation (survives re-render; whole card + Open button)
  const weddingGrid = $("#wedding-grid");
  if (weddingGrid && !weddingGrid.dataset.bound) {
    weddingGrid.dataset.bound = "1";
    weddingGrid.addEventListener("click", (ev) => {
      const hit = ev.target.closest("[data-work]");
      if (!hit || !weddingGrid.contains(hit)) return;
      const id = hit.getAttribute("data-work") || hit.dataset.work;
      if (!id) {
        toast("This card has no lead id — re-import seeds");
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      openWeddingLead(id);
    });
    weddingGrid.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const hit = ev.target.closest("[data-work]");
      if (!hit || !weddingGrid.contains(hit)) return;
      const id = hit.getAttribute("data-work") || hit.dataset.work;
      if (!id) return;
      ev.preventDefault();
      openWeddingLead(id);
    });
  }

  $("#btn-wedding-import")?.addEventListener("click", async () => {
    busy(true, "Importing & scoring Bay Area planners…");
    try {
      const r = await api("/wedding/library/import?limit=40&rescore=true", { method: "POST" });
      state.wedding = await loadWeddingRows();
      renderWeddings();
      toast(
        `Wedding desk: +${r.imported || 0} new · ${r.rescored || 0} rescored · `
        + `${r.planners || 0} planners · ${r.tier_a || 0} tier A`
      );
    } catch (e) { toast(e.message); }
    finally { busy(false); }
  });

  $("#btn-wedding-refresh")?.addEventListener("click", async () => {
    try {
      state.wedding = await loadWeddingRows();
      renderWeddings();
      toast(`Wedding list refreshed (${state.wedding.length})`);
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
