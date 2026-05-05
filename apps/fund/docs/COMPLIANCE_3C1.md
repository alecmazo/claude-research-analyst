# 3(c)(1) compliance — what the schema enforces

A 3(c)(1) fund (the most common structure for sub-$150M private-fund
managers in the US) carries specific constraints from the Investment
Company Act. The schema enforces some directly and surfaces others
for application-level checks.

> **Disclaimer:** this is operator-facing documentation, not legal
> advice. Consult fund counsel on any specific compliance question.

---

## The 99-investor limit

3(c)(1) caps the fund at **100 beneficial owners**, but to avoid
edge cases (joint accounts, look-throughs) most operators treat 99 as
the practical hard cap.

**Schema enforcement:** `funds.max_lps INT`. Set to 99 at fund
creation; the application checks it on every new `INSERT INTO lps`.

Application-side logic (sketch):

```python
def add_lp(fund_id, lp_data):
    with db.transaction():
        active_count = db.scalar("""
            SELECT COUNT(*) FROM lps
             WHERE fund_id = %s AND status IN ('active','prospect')
        """, fund_id)
        max_lps = db.scalar("SELECT max_lps FROM funds WHERE id = %s", fund_id)
        if max_lps and active_count >= max_lps:
            raise ComplianceError(
                f"Fund at {active_count}/{max_lps} LPs — 3(c)(1) cap")
        db.execute("INSERT INTO lps ...")
```

---

## Accredited investor verification

Every 3(c)(1) LP must be accredited (Reg D 506(b) or 506(c)). The
schema captures this with three fields on `lps`:

- `accred_type` — one of: `income`, `net_worth`, `professional`,
  `entity`, `knowledgeable`. Required.
- `accred_verified_at DATE` — when the verification letter / docs
  were dated.
- `accred_evidence_path TEXT` — pointer to the signed accreditation
  letter (in Dropbox).

The application should refuse to flip an LP's status from `prospect`
to `active` until these are populated:

```python
def activate_lp(lp_id):
    lp = db.fetch_one("SELECT * FROM lps WHERE id = %s", lp_id)
    if not lp.accred_verified_at:
        raise ComplianceError(
            "Cannot activate LP — accreditation not verified")
    if not lp.accred_evidence_path:
        raise ComplianceError(
            "Cannot activate LP — no accreditation evidence on file")
    if not lp.tax_id_encrypted:
        raise ComplianceError(
            "Cannot activate LP — tax ID not on file")
    db.execute("UPDATE lps SET status='active', onboarded_at=CURRENT_DATE WHERE id=%s", lp_id)
```

---

## Re-verification

Reg D 506(c) — if the fund ever does general solicitation —
requires *taking reasonable steps to verify* accreditation, not just
self-certification. Practical approach: re-verify every 5 years.

Surfacing this is application-level. A simple query for the operator
dashboard:

```sql
SELECT id, legal_name, accred_verified_at,
       (CURRENT_DATE - accred_verified_at) AS days_since_verified
  FROM lps
 WHERE status = 'active'
   AND accred_verified_at < CURRENT_DATE - INTERVAL '5 years'
 ORDER BY accred_verified_at;
```

---

## Audited financial statements (annual)

3(c)(1) doesn't strictly require audited statements, but most institutional
LPs demand them and many fund-of-funds require them as a precondition
to invest. The schema supports the workflow:

- `nav_snapshots.status` includes `'final'` — the period close.
- `lp_statements.status` includes `'sent'` — the document delivered.
- `audit_log` records exactly when each status flipped and by whom.

For an annual audit, the auditor wants a frozen-in-time view of the
books as of fiscal year-end. The schema supports this naturally:
`SELECT * FROM transactions WHERE effective_date <= '2026-12-31'`
returns the same rows forever, regardless of when the query is run
(immutable ledger). Restated statements use the `restates_id` and
`supersedes_id` chains so the auditor can reconstruct what was sent
to LPs at year-end vs. what is on the books now.

---

## Form D (federal) and state Blue Sky filings

The schema doesn't directly produce Form D, but a query helps the
operator know what to file:

```sql
-- New investors during a period (drives Form D amendments):
SELECT l.legal_name, l.state_region, c.commitment_amount, c.effective_date
  FROM lps l
  JOIN commitments c ON c.lp_id = l.id
 WHERE c.superseded_by IS NULL
   AND c.effective_date BETWEEN :period_start AND :period_end
 ORDER BY c.effective_date;
```

State Blue Sky filings depend on each LP's state of residence — that
data is in `lps.state_region`.

---

## The "investor" definition gotchas

Beneficial-ownership counting under 3(c)(1) has corner cases. Some
key ones the application should encode:

1. **Joint accounts** count as **one** beneficial owner (typically a
   married couple).
   - Implementation: `lps.entity_type = 'joint'`. The 99-cap counter
     treats one row = one investor regardless.
2. **Trusts** look through to grantors.
   - Implementation: `lps.entity_type = 'trust'`. If the trust is
     revocable and has more than one grantor, each grantor counts.
     Edge cases require fund counsel.
3. **LLCs / partnerships** look through to members if formed for the
     primary purpose of investing in this fund.
   - Implementation: `lps.entity_type = 'llc'/'partnership'` + a
     `notes` field flagging look-through analysis.
4. **Knowledgeable employees** of the GP don't count toward the 99.
   - Implementation: `lps.accred_type = 'knowledgeable'` →
     application excludes from the cap counter.

A safer implementation: keep the cap-counter conservative (count
everyone) and flag knowledgeable employees as a soft override.

---

## Custody rule (if SEC-registered as RIA)

Custody triggers an annual surprise audit by an independent CPA.
Most 3(c)(1) GPs are exempt-reporting advisers (under $100M AUM)
and don't trigger custody.

Schema-side, custody compliance lives in:
- `lps.tax_id_encrypted` — encrypted at rest (pgcrypto).
- `audit_log` — every read of LP PII gets logged.
- `lp_statements.pdf_hash_sha256` — proves delivered statement bytes
  match the stored copy.

These are belt-and-suspenders even when not strictly required.

---

## What the schema does NOT enforce

- **Pay-to-play (Rule 206(4)-5)** — political-contribution lookback.
  Out of scope.
- **AML/KYC** — sanctions screening. Run the LP name through OFAC at
  onboarding via a third-party API; store the result in `lps.notes`
  or a separate `kyc_results` table (TBD).
- **Form ADV** — annual disclosure to SEC. The data is in this DB but
  the form generation is a separate workflow.
- **K-1 generation** — tax forms. Will be a separate generator that
  reads from `nav_snapshot_lp` + `distribution_allocations` and
  produces IRS Form 1065 K-1s per LP.
