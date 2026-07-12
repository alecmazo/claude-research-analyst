# Location

**This project lives at:**

```
~/Desktop/sliw-agent
```

Full path: `/Users/dplvideo/Desktop/sliw-agent`  
(Dropbox Desktop: `Library/CloudStorage/Dropbox/Mac/Desktop/sliw-agent`)

## Web desk (recommended)

**Double-click** `Start Sliw Agent.command` on your Desktop folder,  
or in Terminal:

```bash
cd ~/Desktop/sliw-agent
pip3 install -r requirements.txt
python3 -m uvicorn sliw_agent.server:app --host 127.0.0.1 --port 8787
```

Then open **http://127.0.0.1:8787**

The web UI includes: dashboard, pipeline CRM, new outreach form, packages,
Edyta’s warm leads, email drafts, and talent bible.

CLI still works:

```bash
cd ~/Desktop/sliw-agent
python3 -m sliw_agent bible
```

---

# Sliw Agent

**Hollywood-style representation desk for Edyta Śliwińska** — corporate event outings, team-building, and wellness experiences.

Think **CAA / William Morris for experiential talent**: the agent finds the right corporations, packages Edyta for that room, builds a custom marketing deck (Gamma), drafts outreach, and only puts **interested, decision-capable leads** on Edyta’s calendar.

Website sources internalized:

| Page | URL |
|------|-----|
| Home | https://edytasliwinska.com |
| Corporate | https://edytasliwinska.com/corporate |
| About | https://edytasliwinska.com/about |
| Package site (Gamma) | https://edyta-corporate-dance-866y3wq.gamma.site/ |
| Contact | admin@edytasliwinska.com · +1 (218) 304-8372 · San Rafael studio |

---

## What the agent does (CAA desk model)

```
┌─────────────┐    ┌──────────┐    ┌────────────────┐    ┌─────────────┐
│ 1. Prospect │ →  │ 2. Score │ →  │ 3. Package     │ →  │ 4. Draft    │
│    research │    │    ICP   │    │    Gamma deck  │    │    outreach │
└─────────────┘    └──────────┘    └────────────────┘    └──────┬──────┘
                                                                │
                     human approves & sends  ◄──────────────────┘
                                │
                                ▼
                     ┌──────────────────┐    ┌────────────────────┐
                     │ 5. Qualify reply │ →  │ 6. Edyta brief +   │
                     │    filter leads  │    │    discovery call  │
                     └──────────────────┘    └────────────────────┘
```

| Step | Owner | Output |
|------|--------|--------|
| Think through prospects | Agent | CRM records + ICP tier A–D |
| Get contact information | Agent + human | Names/titles/emails (LinkedIn, company site, warm intros) |
| Marketing packages | Agent + **Gamma API** | Custom `Edyta × Company` presentation |
| Contact corporations | **Human-approved** send | Email draft → Gmail / desk |
| Filter interested leads | Agent | Stage `interested` + one-page brief for Edyta |

**Hard rule:** the agent never auto-sends cold email. Draft → approve → send.

---

## Packages the agent sells

From Edyta’s corporate positioning:

1. **The Icebreaker** — 60–90 min team bonding mixer  
2. **The Leadership Ballroom** — half-day executive seminar  
3. **The Tech-Decompress** — 4-week weekly wellness series  
4. **Dancing with the Office Stars** — premium holiday/gala + exec prep  
5. **Custom Collaboration Lab** — fully bespoke workshop  

CTA always: **complimentary 15-minute discovery call with Edyta**.

---

## Quick start

```bash
cd ~/Desktop/sliw-agent
pip3 install -r requirements.txt

# Talent bible (what the agent "knows")
python3 -m sliw_agent bible

# Score Bay Area seed corps (Salesforce, Genentech, Stripe, …)
python3 -m sliw_agent seed

# Full pipeline for one company (score + Gamma prompt dry-run + email draft)
python3 -m sliw_agent pipeline \
  --company "Genentech" \
  --industry "biotech" \
  --geo "South San Francisco" \
  --employees "14000" \
  --signals "wellness program,leadership development" \
  --contact-name "Jane Doe" \
  --contact-title "Head of Employee Experience" \
  --contact-email "jane@example.com" \
  --hook "Campus wellness that teams actually look forward to" \
  --gamma

# Burn Gamma credits — live deck
python3 -m sliw_agent pipeline --company "Genentech" --gamma --live

# When a reply comes in — qualify & prep Edyta
python3 -m sliw_agent interested --id <prospect_id> \
  --reply "This sounds amazing — can we find time next week?"

# Leads ready for Edyta
python3 -m sliw_agent leads
python3 -m sliw_agent list
python3 -m sliw_agent summary
```

### Env (same monorepo `.env`)

| Variable | Purpose |
|----------|---------|
| `GAMMA_API_KEY` | Required for `--live` decks ([gamma.app/account](https://gamma.app/account)) |
| `GAMMA_FOLDER_ID` | Optional default folder |
| `SLIW_GAMMA_FOLDER_ID` | Optional Sliw-only folder override |

---

## How to initiate the agent (operating model)

### Phase 0 — Desk setup (one-time)

1. Confirm Edyta’s sending identity (her Gmail vs. a desk alias).  
2. Ensure `GAMMA_API_KEY` is in monorepo `.env` (already used by DGA research).  
3. Run `python3 -m sliw_agent seed` and review tier A/B targets.  
4. Decide weekly cadence: e.g. **Mon research, Wed decks, Thu send batch, Fri lead review**.

### Phase 1 — Weekly prospecting loop

1. **Source 5–15 corps** from ICP (Bay Area tech, biotech, professional services, healthcare; triggers: holiday parties, offsites, wellness, reorgs).  
2. `pipeline` each A/B target with real contacts when known.  
3. Review `data/outreach/*.md` drafts — personalize last 10%.  
4. Approve and send (manual Gmail or connected Gmail MCP later).  
5. Log replies with `interested` command.  
6. Hand Edyta only `leads` + brief files in `data/briefs/`.

### Phase 2 — Contact enrichment (agent + tools)

| Source | Use |
|--------|-----|
| Company careers / leadership pages | Titles |
| LinkedIn Sales Nav / manual search | People Ops, L&D, Events, Chief of Staff |
| Warm intros (DWTS / dance / nonprofit network) | Highest conversion |
| Event RFPs, gala sponsors, Chamber lists | Timing triggers |
| Grok web search inside this repo session | News hooks for personalization |

Target titles (from talent bible): Head of People, VP People Ops, Director Employee Experience, Event Manager, VP L&D, Wellness Manager, EA to CEO, CHRO.

### Phase 3 — Automation upgrades (optional next builds)

| Upgrade | Why |
|---------|-----|
| Gmail MCP send-as-draft | One-click desk drafts in Edyta’s mailbox |
| Scheduled task (Grok tasks / cron) | Weekly “find 10 new Bay Area offsite news hooks” |
| Apollo / Hunter / Clearbit | Scale emails (stay compliant — CAN-SPAM) |
| Shared Google Sheet CRM | Edyta-visible pipeline without JSON |
| Calendar link (Calendly) in CTA | Frictionless discovery booking |
| Reply inbox watcher | Auto `qualify_reply` on labeled threads |

### Phase 4 — Human / talent split (non-negotiable)

| Agent (desk) | Edyta (talent) |
|--------------|----------------|
| Research, score, package, draft | Discovery calls |
| Follow-ups, nurture, CRM hygiene | Pricing & custom design |
| Filter tire-kickers | Delivery on the floor |
| Protect brand & scarcity | Star power close |

---

## Repo layout

```

├── README.md                 ← this playbook
├── requirements.txt
├── data/
│   ├── seed_prospects.json   ← starter Bay Area corps
│   ├── crm.json              ← live pipeline (created on first run)
│   ├── decks/                ← Gamma prompts, PPTX, meta
│   ├── outreach/             ← email drafts (.json + .md)
│   └── briefs/               ← Edyta call one-pagers
└── sliw_agent/
    ├── talent_bible.py       ← brand, packages, ICP, mandate
    ├── scoring.py            ← ICP score + package match
    ├── crm.py                ← file CRM
    ├── gamma_packages.py     ← Gamma API marketing decks
    ├── outreach.py           ← drafts + lead filter + briefs
    ├── pipeline.py           ← end-to-end orchestrator
    └── cli.py                ← `python -m sliw_agent …`
```

---

## Grok skill

Skill: `.grok/skills/sliw-agent/SKILL.md` (also on Desktop project)  
Invoke with `/sliw-agent` or by asking Grok to run the Sliw corporate sales desk.

---

## Compliance & brand guardrails

- No fabricated client logos, testimonials, or prices.  
- No auto-send; honor unsubscribe / “not interested” immediately (`lost`).  
- Position as **premium experiential talent**, not commodity “dance instructor.”  
- Always offer easy outs and the free 15-minute discovery CTA.  
- Prefer fewer perfect pitches over spray-and-pray.

---

## Success metrics (desk KPIs)

| Metric | Healthy early target |
|--------|----------------------|
| Tier A/B prospects researched / week | 10+ |
| Personalized decks created / week | 3–5 |
| Approved sends / week | 5–10 |
| Reply rate | Track; aim to improve hooks |
| Interested leads → Edyta call | 2+ / month to start |
| Booked sessions | Primary commercial outcome |

---

## Railway (production)

Mounted into the main DGA Capital FastAPI app:

| URL | Purpose |
|-----|---------|
| `https://portfolio.dgacapital.com/sliw/` | Sliw Agent web desk |
| `https://portfolio.dgacapital.com/api/sliw/*` | API (requires DGA login) |

**Auth:** same login as `/` (email + password → `dga_v2_token`).  
GP / admin always; also allowlisted emails (default Edyta + Alec).

**Env vars (Railway → Variables):**

| Variable | Purpose |
|----------|---------|
| `SLIW_ALLOWED_EMAILS` | Comma list (default includes edytasliw@gmail.com, alecmazo1@gmail.com) |
| `SLIW_ALLOWED_LP_IDS` | Optional lp_id allowlist |
| `STOCKS_FOLDER` | CRM data stored under `$STOCKS_FOLDER/sliw-agent/` (persistent volume) |
| `GAMMA_API_KEY` | Optional live Gamma decks |

**Deploy:** push/redeploy `Claude_Research_Analyst` as usual. After deploy:

1. Log in at portfolio.dgacapital.com  
2. Open **Sliw** in the GP top nav, or go to `/sliw/`  
3. Click **Load seed corps**

