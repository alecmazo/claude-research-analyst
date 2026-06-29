#!/usr/bin/env python3
"""Render the DGA policy markdown files to clean PDFs (for the Plaid security
diligence). Uses xhtml2pdf — the same engine the app uses for research PDFs.

    python gen_policy_pdfs.py
"""
import html as _html
import re as _re
from xhtml2pdf import pisa

POLICIES = [
    ("SECURITY_POLICY.md",       "SECURITY_POLICY.pdf"),
    ("PRIVACY_POLICY.md",        "PRIVACY_POLICY.pdf"),
    ("ACCESS_CONTROL_POLICY.md", "ACCESS_CONTROL_POLICY.pdf"),
]

CSS = """
@page { size: letter; margin: 2.0cm 2.2cm 2.0cm 2.2cm; }
body { font-family: Helvetica; font-size: 10.5pt; color: #1e293b; line-height: 1.45; }
h1 { font-size: 16pt; color: #0A1628; margin: 0 0 4pt 0; }
h2 { font-size: 11.5pt; color: #0A1628; margin: 14pt 0 3pt 0; border-bottom: 0.5pt solid #cbd5e1; padding-bottom: 2pt; }
p  { margin: 3pt 0; }
ul { margin: 3pt 0 3pt 14pt; }
li { margin: 1.5pt 0; }
b  { color: #0A1628; }
.foot { margin-top: 18pt; font-size: 8pt; color: #94a3b8; border-top: 0.5pt solid #e2e8f0; padding-top: 6pt; }
"""


def md_to_html(md: str) -> str:
    out, in_list = [], False
    for line in md.splitlines():
        s = _re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", _html.escape(line))
        s = _re.sub(r"`(.+?)`", r"<font face='Courier'>\1</font>", s)
        if line.startswith("- "):
            if not in_list:
                out.append("<ul>"); in_list = True
            out.append(f"<li>{s[2:]}</li>"); continue
        if in_list:
            out.append("</ul>"); in_list = False
        if line.startswith("## "):
            out.append(f"<h2>{s[3:]}</h2>")
        elif line.startswith("# "):
            out.append(f"<h1>{s[2:]}</h1>")
        elif line.strip() == "":
            out.append('<div style="height:4pt"></div>')
        else:
            out.append(f"<p>{s}</p>")
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def main():
    for src, dst in POLICIES:
        try:
            md = open(src, encoding="utf-8").read()
        except FileNotFoundError:
            print(f"skip {src} (not found)"); continue
        doc = (f"<html><head><style>{CSS}</style></head><body>{md_to_html(md)}"
               f"<div class='foot'>DGA Capital Management LP — confidential. "
               f"Prepared for Plaid security diligence.</div></body></html>")
        with open(dst, "wb") as f:
            res = pisa.CreatePDF(doc, dest=f, encoding="utf-8")
        print(f"{dst}: {'OK' if not res.err else 'ERRORS=' + str(res.err)}")


if __name__ == "__main__":
    main()
