/**
 * Generate Sliw Agent strategy & operations document (printable DOCX).
 * Run: node docs/generate_strategy_doc.mjs
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, LevelFormat, PageBreak,
} from "docx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = __dirname;

const gold = "C9A84C";
const ink = "0C0B0A";
const charcoal = "1A1816";
const mist = "6B6560";
const cream = "F7F3EC";
const border = { style: BorderStyle.SINGLE, size: 4, color: "D4C4A8" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const W = 9360; // content width US Letter 1" margins

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 160, before: opts.before ?? 0, line: opts.line },
    alignment: opts.align,
    ...opts.para,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: opts.size ?? 22,
        font: "Arial",
        color: opts.color ?? ink,
      }),
    ],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, size: 32, font: "Arial", color: ink })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [new TextRun({ text, bold: true, size: 26, font: "Arial", color: charcoal })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, size: 24, font: "Arial", color: mist })],
  });
}

function bullet(text, ref = "bullets") {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 80 },
    children: [new TextRun({ text, size: 20, font: "Arial", color: ink })],
  });
}

function cell(text, width, opts = {}) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: opts.bold,
            size: opts.size ?? 18,
            font: "Arial",
            color: opts.color ?? ink,
          }),
        ],
      }),
    ],
  });
}

function table(headers, rows, colWidths) {
  const total = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({
        children: headers.map((h, i) =>
          cell(h, colWidths[i], { bold: true, fill: cream, size: 18 })
        ),
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: r.map((c, i) => cell(String(c), colWidths[i])),
          })
      ),
    ],
  });
}

function spacer(after = 120) {
  return new Paragraph({ spacing: { after }, children: [] });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: ink },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: charcoal },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: mist },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
      {
        reference: "bullets2",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
      {
        reference: "numbers",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              border: {
                bottom: { style: BorderStyle.SINGLE, size: 12, color: gold, space: 8 },
              },
              spacing: { after: 200 },
              children: [
                new TextRun({
                  text: "SLIW AGENT  ·  Confidential operations brief",
                  size: 16,
                  font: "Arial",
                  color: gold,
                  bold: true,
                }),
                new TextRun({
                  text: "  |  Edyta Śliwińska representation desk",
                  size: 16,
                  font: "Arial",
                  color: mist,
                }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              border: {
                top: { style: BorderStyle.SINGLE, size: 6, color: "E5DCC8", space: 8 },
              },
              spacing: { before: 120 },
              children: [
                new TextRun({
                  text: "CAA-style corporate + wedding desk  ·  portfolio.dgacapital.com/sliw/  ·  Page ",
                  size: 14,
                  font: "Arial",
                  color: mist,
                }),
                new TextRun({
                  children: [PageNumber.CURRENT],
                  size: 14,
                  font: "Arial",
                  color: mist,
                }),
              ],
            }),
          ],
        }),
      },
      children: [
        // COVER
        p("SLIW AGENT", {
          size: 48,
          bold: true,
          color: ink,
          after: 80,
          align: AlignmentType.CENTER,
        }),
        p("Operations & Product Design Brief", {
          size: 28,
          color: gold,
          after: 200,
          align: AlignmentType.CENTER,
        }),
        p("Hollywood-style representation for Edyta Śliwińska", {
          size: 22,
          italics: true,
          color: mist,
          after: 80,
          align: AlignmentType.CENTER,
        }),
        p("Corporate team experiences  ·  Wedding first-dance packages", {
          size: 20,
          color: mist,
          after: 320,
          align: AlignmentType.CENTER,
        }),
        p(
          "This document explains what lives “below the line”: the desk model, engagement strategy, how Edyta uses the app, the Lead Engine, outreach rules, Gamma packaging, weekly cadence, and the parallel Wedding Agent product. Print or share with operators and talent.",
          { size: 20, after: 200 }
        ),
        p(`Prepared for launch  ·  ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, {
          size: 18,
          color: mist,
          after: 400,
        }),

        h1("1. What this is"),
        p(
          "Sliw Agent is a CAA / William Morris–style representation desk hosted at portfolio.dgacapital.com/sliw/. It is not a generic CRM. It researches corporations (and, separately, wedding clients), matches Edyta’s packages, builds Gamma marketing decks, drafts outreach for human approval, and filters warm leads so Edyta only spends time on conversations that can book."
        ),
        p("Access (production):", { bold: true, after: 80 }),
        bullet("alecmazo1@gmail.com — full desk + GP portal Sliw link"),
        bullet("edytasliw@gmail.com — full desk + LP portal Sliw link"),
        bullet("All other DGA portal logins: no Sliw nav, API denied"),
        p(
          "Sources of truth for talent positioning: edytasliwinska.com (Corporate, About, Weddings, Contact) and the corporate Gamma package site (Icebreaker, Leadership Ballroom, Tech-Decompress, Office Stars, Custom Collaboration Lab).",
          { after: 200 }
        ),

        h1("2. Brand positioning (never dilute)"),
        p(
          "Lead with team accelerator and star power — never “hire a dance teacher.” Dance is the vehicle; connection, leadership, wellness, and unforgettable culture moments are the product."
        ),
        h3("Corporate packages"),
        table(
          ["Package", "Duration", "Primary buyer"],
          [
            ["The Icebreaker", "60–90 min mixer", "Employee Exp / Events / CoS"],
            ["Leadership Ballroom", "Half-day exec seminar", "VP L&D / CHRO / HiPo"],
            ["Tech-Decompress", "4-week weekly series", "Wellness / Benefits / People"],
            ["Dancing with the Office Stars", "Holiday / gala + exec prep", "Events / EA / CSR"],
            ["Custom Collaboration Lab", "Bespoke workshop", "CHRO / OD / DEI / M&A"],
          ],
          [3200, 2800, 3360]
        ),
        spacer(200),
        h3("Wedding packages (parallel product)"),
        table(
          ["Package", "Offer", "Entry"],
          [
            ["Single private lesson", "Custom first-dance coaching", "$150 (site)"],
            ["Wedding lesson package ×10", "Full prep arc to the day", "$1,250 (site)"],
            ["Dream Wedding Dance", "Choreo + venue + day-of support", "Custom proposal"],
          ],
          [3200, 3800, 2360]
        ),
        spacer(200),
        p("Universal CTA: complimentary discovery conversation with Edyta (15 minutes for corporate; consult for wedding).", {
          italics: true,
        }),

        h1("3. What maximizes corporate engagement"),
        h2("3.1 Sell the outcome"),
        table(
          ["Lead with…", "Expected response"],
          [
            ["Corporate dance instructor", "Low"],
            ["Holiday party entertainment only", "Medium (seasonal)"],
            ["Culture / leadership / offsite people remember", "High"],
          ],
          [5000, 4360]
        ),
        spacer(160),
        h2("3.2 Triggers beat static lists"),
        bullet("Holiday / year-end party planning (Aug–Nov) → Office Stars, Icebreaker"),
        bullet("Offsites & retreats announced → Icebreaker, Leadership, Custom"),
        bullet("Post-funding / hiring spikes → Icebreaker, Tech-Decompress"),
        bullet("M&A / reorg → Icebreaker, Custom Lab"),
        bullet("Wellness / Mental Health month → Tech-Decompress"),
        bullet("Leadership / HiPo programs → Leadership Ballroom"),
        bullet("Charity galas → Office Stars"),
        h2("3.3 Volume targets (real pipeline, not 12 seeds)"),
        table(
          ["Stage", "Weekly target"],
          [
            ["New prospects researched", "25–40"],
            ["Tier A/B after scoring", "10–15"],
            ["Personalized Gamma decks", "3–5 (A-tier)"],
            ["Approved outbound sends", "8–12"],
            ["Follow-ups (day 4–7, day 12)", "All non-replies"],
            ["Discovery calls (early months)", "2–4 per month"],
          ],
          [5200, 4160]
        ),
        spacer(160),
        p(
          "90-day commercial goal: ~300 researched accounts, ~80 contacted, ~15–25 conversations, 3–6 booked sessions. Quality of package × buyer × trigger beats spray volume."
        ),
        h2("3.4 Channel priority"),
        bullet("Warm intro (DWTS / dance / nonprofit / past clients) — highest conversion"),
        bullet("Named People/Events/L&D contact — email + LinkedIn"),
        bullet("Gamma proposal link in body (not attachment spam)"),
        bullet("Partners: offsite planners, hotels, PE portfolio ops, HR consultants"),

        h1("4. Product architecture (below the line)"),
        p(
          "The web app is the desk surface. Behind it: Corporate Lead Engine, Wedding Agent (parallel book), Gamma packaging, outreach sequences, partnership list, and Edyta-only warm queue."
        ),
        h3("Pipeline (both books)"),
        p(
          "research → scored → packaged → drafted → approved → contacted → replied → interested → discovery_booked → won | lost | nurture"
        ),
        h3("Hard rules"),
        bullet("Never auto-send cold outreach — draft → human approve → send"),
        bullet("Never invent pricing, logos, or client testimonials not in the talent bible"),
        bullet("One primary package per first email"),
        bullet("Only interested / discovery_booked reach Edyta’s calendar with a brief"),
        bullet("Corporate and Wedding CRMs stay separate (different buyers, Gamma tones)"),

        h1("5. How Edyta interacts with the application"),
        h2("5.1 Her daily / thrice-weekly path (15–20 min)"),
        bullet("Open Sliw → Edyta’s desk (warm leads first)"),
        bullet("Read one-page brief: company/couple, package, contact, their words, questions"),
        bullet("Hold discovery; confirm package, date window, headcount or couple timeline, budget owner"),
        bullet("Desk (or she) updates stage to discovery_booked / won / nurture"),
        bullet("She designs and delivers; desk handles follow-up admin"),
        h2("5.2 What Edyta must not do"),
        bullet("Cold research or list building"),
        bullet("Chasing vague “maybe later” without a brief"),
        bullet("Discounting into commodity “activity vendor” territory"),
        h2("5.3 Desk operator (Alec / VA) owns"),
        bullet("Lead Engine runs, tier review, Gamma for A-tier, approve sends, sequences, partnerships"),
        bullet("Paste replies → qualify → generate Edyta brief"),
        h2("5.4 Metrics that matter to talent"),
        bullet("Warm leads this month"),
        bullet("Calls held"),
        bullet("Sessions / packages booked"),
        p("Not: raw emails sent (desk vanity).", { italics: true }),

        h1("6. Weekly operating cadence"),
        table(
          ["Day", "Desk action"],
          [
            ["Monday", "Lead Engine: research 25–40 new corporate prospects"],
            ["Tuesday", "Review A/B tiers; build 3–5 Gamma decks"],
            ["Wednesday", "Approve + send 8–12 cold / sequence emails"],
            ["Thursday", "Follow-ups; partnership touches"],
            ["Friday", "Warm queue → Edyta briefs; pipeline hygiene"],
          ],
          [2200, 7160]
        ),
        spacer(200),
        p(
          "The app’s “This week” view enforces this checklist so the desk does not devolve into an unprioritized CRM dump."
        ),

        h1("7. Phase roadmap (implemented at launch)"),
        h2("Phase 1 — Corporate Lead Engine"),
        bullet("Expanded prospect library (far beyond 12 demo seeds)"),
        bullet("Bulk score/import + manual add"),
        bullet("Multi-step sequences: cold → follow-up → break-up"),
        bullet("This week checklist"),
        bullet("Edyta-first home for warm leads"),
        bullet("Contact enrichment fields (name, title, email, LinkedIn)"),
        h2("Phase 2 — Engagement quality"),
        bullet("Reply paste → qualify → brief in one flow"),
        bullet("A/B subject line variants per package"),
        bullet("Partnership book (planners, hotels, PE ops, venues)"),
        h2("Phase 3 — Wedding Agent (parallel)"),
        bullet("Separate Wedding book in Sliw UI"),
        bullet("Packages from website pricing + Dream Dance custom"),
        bullet("Wedding Gamma proposals"),
        bullet("Sequences to couples and planners"),
        bullet("Edyta warm queue for wedding interest"),

        h1("8. Wedding Agent (parallel product)"),
        p(
          "Same CAA desk pattern, different ICP. Buyers are couples and wedding planners; products are first-dance lessons and full wedding dance packages; Gamma decks are romantic/premium couple proposals, not corporate culture decks."
        ),
        bullet("Lead sources: venues, planners, Bay Area wedding ecosystem, inbound from site"),
        bullet("CRM stages mirror corporate but never share prospect pools"),
        bullet("Edyta still only sees interested wedding clients with briefs"),

        h1("9. Technical placement (for operators)"),
        bullet("Code: Claude_Research_Analyst/apps/sliw-agent/ on GitHub main"),
        bullet("Production URL: /sliw/ on portfolio.dgacapital.com (Railway)"),
        bullet("API: /api/sliw/* behind DGA login + email allowlist"),
        bullet("CRM data: $STOCKS_FOLDER/sliw-agent/ (persistent volume)"),
        bullet("Gamma: shared GAMMA_API_KEY with DGA research (intentional)"),
        bullet("Kill switch: SLIW_ENABLED=0 leaves DGA Capital fully unaffected"),
        bullet("Isolation details: apps/sliw-agent/ISOLATION.md"),

        h1("10. Launch checklist"),
        bullet("Deploy Railway from latest main"),
        bullet("Log in as Alec or Edyta → open /sliw/"),
        bullet("Confirm name under “Sliw Agent” matches login"),
        bullet("Corporate → Load / expand prospect library → score"),
        bullet("Run This week → draft sequence for 5–10 A-tier accounts"),
        bullet("Approve sends manually from Gmail"),
        bullet("On reply: Qualify → Edyta brief"),
        bullet("Open Weddings tab → seed/add couples or planners as secondary book"),
        bullet("Protect brand: premium experiential talent, not discount instructor"),

        h1("11. One-line north stars"),
        p("Desk: Find the room. Package the talent. Only book real opportunities.", {
          bold: true,
        }),
        p("Edyta: Read the brief. Hold the call. Deliver star power on the floor.", {
          bold: true,
        }),
        p("App: Research, score, deck, draft, filter — never send without approval.", {
          bold: true,
          after: 400,
        }),

        p("— End of brief —", {
          align: AlignmentType.CENTER,
          color: mist,
          size: 18,
          after: 80,
        }),
        p("Sliw Agent  ·  Edyta Śliwińska  ·  Confidential", {
          align: AlignmentType.CENTER,
          color: gold,
          size: 16,
        }),
      ],
    },
  ],
});

const outDocx = path.join(outDir, "Sliw_Agent_Operations_Brief.docx");
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outDocx, buffer);
console.log("Wrote", outDocx);
