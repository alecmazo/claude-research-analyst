# `@dga/wall-street-format` (placeholder)

The Goldman / Morgan Stanley / Merrill institutional-research formatting
templates and prompts currently live inside `claude_analyst.py`'s
`load_system_prompt()` and the `report.docx`/Gamma rendering helpers.

This package will hold:

- The Goldman/MS/Merrill **system prompt** templates (the rules that
  shape every Grok-generated report).
- The **Word document renderer** (heading hierarchy, table styles,
  branded cover page).
- The **Gamma deck builder** (slide-by-slide structure for the PPTX).
- The **email layout** that wraps a portfolio rebalance run.

Both the Research app and the Brief app render to these templates, so
hoisting them into a shared package keeps the visual + verbal language
identical across surfaces.

See `../../MONOREPO.md` Phase 2/3.
