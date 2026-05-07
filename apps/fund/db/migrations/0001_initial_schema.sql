-- ===========================================================================
-- DGA Capital — Fund Admin Schema (initial)
-- PostgreSQL 14+
--
-- This is the books-of-record for a 3(c)(1) hedge fund. Every cash and
-- security movement posts to a balanced double-entry transaction. The
-- ledger is *immutable* — once a transaction is posted you may never
-- update or delete it; corrections are made by posting a reversing
-- transaction that references the original via `transactions.reverses_id`.
--
-- Tables:
--   1. users                          — operators (admin, accountant, viewer, lp)
--   2. funds                          — investment vehicles
--   3. lps                            — limited partners (investors)
--   4. commitments                    — initial subscriptions
--   5. capital_calls                  — drawdown events
--   6. capital_call_allocations       — per-LP slices of a call
--   7. distributions                  — payouts to LPs
--   8. distribution_allocations       — per-LP slices of a distribution
--   9. securities                     — instruments the fund owns
--  10. tax_lots                       — cost-basis lots for FIFO/HIFO
--  11. accounts                       — chart of accounts
--  12. transactions                   — immutable double-entry header
--  13. transaction_lines              — debit / credit lines per txn
--  14. nav_snapshots                  — period-end fund valuations
--  15. nav_snapshot_lp                — per-LP capital account at period end
--  16. mgmt_fee_runs / _allocations   — quarterly/monthly fee accruals
--  17. carry_runs / _allocations      — performance fee with hurdle + HWM
--  18. lp_statements                  — versioned PDFs sent to LPs
--  19. audit_log                      — every mutating action, append-only
--
-- ===========================================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
-- pgcrypto:  gen_random_uuid() + symmetric encryption for tax IDs
-- citext:    case-insensitive text (emails)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";


-- ===========================================================================
-- 1. users
-- ===========================================================================
-- Operator accounts. LPs also have a row here when they're given
-- read-only access to their own statements; their `lp_id` ties the user
-- to the LP record so the API can scope queries.

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           CITEXT UNIQUE NOT NULL,
    full_name       TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin','accountant','viewer','lp')),
    -- For role='lp' only — points at their LP record so the API can
    -- restrict row visibility.
    lp_id           UUID,    -- FK added later (lps table not yet defined)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ
);


-- ===========================================================================
-- 2. funds
-- ===========================================================================
-- One row per investment vehicle. Most operators run a single fund;
-- the schema is multi-fund ready so a future "Fund II" can be added
-- without migrations.

CREATE TABLE funds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,                 -- 'DGA Capital Fund I, LP'
    short_name      TEXT NOT NULL UNIQUE,          -- 'DGA-I'
    structure       TEXT NOT NULL CHECK (structure IN ('3c1','3c7','fund_of_one','separately_managed')),
    domicile        TEXT NOT NULL,                 -- 'DE', 'KY', etc.
    fund_type       TEXT NOT NULL DEFAULT 'lp_fund' CHECK (fund_type IN ('lp_fund','managed_account')),
    base_ccy        TEXT NOT NULL DEFAULT 'USD',
    inception_date  DATE NOT NULL,
    fiscal_year_end DATE NOT NULL,                 -- typically Dec 31

    -- Default economics. Per-LP overrides live on the lps table.
    mgmt_fee_pct    NUMERIC(6,4) NOT NULL,         -- 0.0200 = 2%
    mgmt_fee_basis  TEXT NOT NULL CHECK (mgmt_fee_basis IN
                        ('committed','contributed','nav','avg_nav')),
    mgmt_fee_freq   TEXT NOT NULL CHECK (mgmt_fee_freq IN
                        ('monthly','quarterly','semi_annual','annual')),
    carry_pct       NUMERIC(6,4) NOT NULL,         -- 0.20 = 20%
    hurdle_pct      NUMERIC(6,4),                  -- NULL = no hurdle
    catch_up_pct    NUMERIC(6,4),                  -- 1.0 = full GP catch-up

    -- 3(c)(1) caps at 99 beneficial owners; 3(c)(7) caps at 1,999 QPs.
    max_lps         INT,
    -- Lifecycle
    status          TEXT NOT NULL CHECK (status IN ('open','closed','winding_down','dissolved')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===========================================================================
-- 3. lps  (Limited Partners — investors)
-- ===========================================================================
-- Tax IDs are encrypted at rest with pgcrypto. The plain SSN/EIN never
-- touches the row in cleartext. The `tax_id_last4` field is shown in
-- the UI for identification. `tax_id_encrypted` is decrypted only when
-- generating K-1s or wiring instructions.

CREATE TABLE lps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    -- Identity
    legal_name          TEXT NOT NULL,
    entity_type         TEXT NOT NULL CHECK (entity_type IN
                            ('individual','joint','llc','trust','ira',
                             'corp','partnership','foundation','other')),
    -- Contact
    primary_email       CITEXT,
    primary_phone       TEXT,
    address_line1       TEXT,
    address_line2       TEXT,
    city                TEXT,
    state_region        TEXT,
    postal_code         TEXT,
    country             TEXT DEFAULT 'US',
    -- Tax
    tax_id_last4        TEXT,                      -- 4 digits, plain
    tax_id_encrypted    BYTEA,                     -- pgp_sym_encrypt(...)
    -- Accreditation (3(c)(1) requires every investor to be accredited)
    accred_type         TEXT NOT NULL CHECK (accred_type IN
                            ('income','net_worth','professional','entity','knowledgeable')),
    accred_verified_at  DATE,
    accred_evidence_path TEXT,                     -- pointer to signed letter
    -- Per-LP economic overrides (NULL = use fund defaults)
    mgmt_fee_pct        NUMERIC(6,4),
    carry_pct           NUMERIC(6,4),
    -- Lifecycle
    status              TEXT NOT NULL CHECK (status IN
                            ('prospect','active','redeemed','suspended','closed')),
    onboarded_at        DATE,
    closed_at           DATE,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lps_fund_id ON lps(fund_id);
CREATE INDEX idx_lps_status  ON lps(status);

-- Now that lps exists, add the FK from users.lp_id → lps.id
ALTER TABLE users ADD CONSTRAINT users_lp_id_fkey
    FOREIGN KEY (lp_id) REFERENCES lps(id);


-- ===========================================================================
-- 4. commitments  (initial subscription amounts, immutable)
-- ===========================================================================
-- A subscription contract. Once signed, it is never modified — only
-- superseded by a new commitment row that references this one.

CREATE TABLE commitments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    commitment_amount   NUMERIC(20,4) NOT NULL CHECK (commitment_amount > 0),
    effective_date      DATE NOT NULL,
    sub_doc_path        TEXT,                       -- signed PDF in Dropbox
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_by       UUID REFERENCES commitments(id)
);

CREATE INDEX idx_commitments_lp ON commitments(lp_id) WHERE superseded_by IS NULL;


-- ===========================================================================
-- 5–6. Capital calls + per-LP allocations
-- ===========================================================================

CREATE TABLE capital_calls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    call_number         INT NOT NULL,               -- '#3' for the third call
    notice_date         DATE NOT NULL,
    due_date            DATE NOT NULL,
    total_amount        NUMERIC(20,4) NOT NULL CHECK (total_amount > 0),
    purpose             TEXT,                       -- 'investment','expense','mgmt_fee'
    status              TEXT NOT NULL CHECK (status IN
                            ('draft','noticed','partial','funded','cancelled')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, call_number)
);

CREATE TABLE capital_call_allocations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    capital_call_id     UUID NOT NULL REFERENCES capital_calls(id),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    amount              NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    -- Receipt tracking — partials allowed
    received_at         TIMESTAMPTZ,
    receipt_amount      NUMERIC(20,4),
    UNIQUE (capital_call_id, lp_id)
);

CREATE INDEX idx_cca_lp ON capital_call_allocations(lp_id);


-- ===========================================================================
-- 7–8. Distributions + per-LP allocations
-- ===========================================================================
-- Distributions are split by tax class (return of capital, LTCG, STCG,
-- interest, dividends) so the K-1 generator can attribute correctly.

CREATE TABLE distributions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    distribution_number INT NOT NULL,
    notice_date         DATE NOT NULL,
    payment_date        DATE NOT NULL,
    total_amount        NUMERIC(20,4) NOT NULL CHECK (total_amount > 0),
    -- Class breakdown — sum across keys MUST equal total_amount.
    -- Keys: 'return_of_capital','ltcg','stcg','dividend','interest','other'.
    class               JSONB NOT NULL,
    status              TEXT NOT NULL CHECK (status IN
                            ('draft','noticed','paid','cancelled')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, distribution_number)
);

CREATE TABLE distribution_allocations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_id     UUID NOT NULL REFERENCES distributions(id),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    amount              NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    class               JSONB NOT NULL,             -- per-LP class breakdown
    paid_at             TIMESTAMPTZ,
    UNIQUE (distribution_id, lp_id)
);

CREATE INDEX idx_da_lp ON distribution_allocations(lp_id);


-- ===========================================================================
-- 9. securities  (the things the fund owns)
-- ===========================================================================

CREATE TABLE securities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Identifiers — at least one should be set
    symbol          TEXT,                           -- 'AAPL', 'BTC-USD'
    cusip           TEXT,
    isin            TEXT,
    figi            TEXT,
    -- Description
    name            TEXT NOT NULL,
    asset_class     TEXT NOT NULL CHECK (asset_class IN
                        ('equity','etf','bond','option','future','crypto','cash','other')),
    issuer          TEXT,
    sector          TEXT,
    is_public       BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Symbol unique only when set; partial unique index handles NULLs.
    UNIQUE (symbol)
);

CREATE INDEX idx_securities_symbol ON securities(symbol) WHERE symbol IS NOT NULL;


-- ===========================================================================
-- 10. tax_lots  (cost-basis tracking, FIFO/HIFO/SpecID supported)
-- ===========================================================================
-- Every buy creates a lot. Sells either close a whole lot or split a lot
-- into a closed portion (with realized gain) and a remainder. The
-- application layer handles the split — this table just stores results.

CREATE TABLE tax_lots (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id                 UUID NOT NULL REFERENCES funds(id),
    security_id             UUID NOT NULL REFERENCES securities(id),
    acquired_at             TIMESTAMPTZ NOT NULL,
    quantity                NUMERIC(20,8) NOT NULL,    -- 8 decimals supports crypto
    cost_basis_per_unit     NUMERIC(20,4) NOT NULL,
    -- Closed when (partially) sold.
    closed_at               TIMESTAMPTZ,
    closed_proceeds_per_unit NUMERIC(20,4),
    closed_realized_gain    NUMERIC(20,4),
    -- Source transactions — set at insert time; never changed.
    open_transaction_id     UUID NOT NULL,            -- FK added below after txns created
    close_transaction_id    UUID
);

CREATE INDEX idx_tax_lots_fund_security ON tax_lots(fund_id, security_id);
CREATE INDEX idx_tax_lots_open ON tax_lots(fund_id, security_id) WHERE closed_at IS NULL;


-- ===========================================================================
-- 11. accounts  (chart of accounts)
-- ===========================================================================
-- The chart of accounts. The seed file populates a standard hedge-fund
-- CoA (cash, securities-by-symbol, LP capital accounts, mgmt fee, carry,
-- etc.). Per-LP capital accounts are created automatically when an LP
-- onboards.

CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id         UUID NOT NULL REFERENCES funds(id),
    code            TEXT NOT NULL,                  -- '1010' or '4100-MGMT_FEE'
    name            TEXT NOT NULL,                  -- 'Cash — JPM Operating'
    type            TEXT NOT NULL CHECK (type IN
                        ('asset','liability','equity','income','expense','contra')),
    -- For LP capital accounts: which LP this account belongs to
    lp_id           UUID REFERENCES lps(id),
    -- For per-security positions: which security
    security_id     UUID REFERENCES securities(id),
    parent_id       UUID REFERENCES accounts(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, code)
);

CREATE INDEX idx_accounts_lp ON accounts(lp_id) WHERE lp_id IS NOT NULL;
CREATE INDEX idx_accounts_security ON accounts(security_id) WHERE security_id IS NOT NULL;


-- ===========================================================================
-- 12. transactions  (immutable double-entry ledger header)
-- ===========================================================================
-- Once posted (i.e. once any line exists) a transaction must never be
-- updated or deleted. Use `category='reversal'` + `reverses_id=<orig>`
-- to back out a mistake.

CREATE TABLE transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    -- Effective vs posted dates differ when accruals are recorded
    -- on a different date than the underlying economic event.
    effective_date      DATE NOT NULL,
    posted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Category drives report grouping + filtering.
    category            TEXT NOT NULL CHECK (category IN (
                            'subscription',    -- LP commits, no cash yet
                            'contribution',    -- LP funds a capital call
                            'distribution',    -- fund pays LPs
                            'trade_buy',       -- security purchase
                            'trade_sell',      -- security sale
                            'mgmt_fee_accrual',
                            'mgmt_fee_payment',
                            'carry_accrual',
                            'carry_payment',
                            'income_dividend',
                            'income_interest',
                            'expense',
                            'transfer',        -- inter-account move (e.g. cash
                                               -- → brokerage)
                            'reversal',
                            'adjustment',
                            'opening_balance')),
    -- Polymorphic source reference — what document or event triggered
    -- this entry. `source_kind` names the table (e.g. 'capital_call',
    -- 'distribution', 'mgmt_fee_run'); `source_id` is the row's UUID.
    -- Not enforced as a hard FK because the kind varies.
    source_kind         TEXT,
    source_id           UUID,
    description         TEXT NOT NULL,
    -- If this is a reversal, point at the original.
    reverses_id         UUID REFERENCES transactions(id),
    -- Audit
    created_by          UUID REFERENCES users(id)
);

CREATE INDEX idx_transactions_fund_eff ON transactions(fund_id, effective_date DESC);
CREATE INDEX idx_transactions_category ON transactions(category, effective_date DESC);
CREATE INDEX idx_transactions_source   ON transactions(source_kind, source_id);


-- ===========================================================================
-- 13. transaction_lines  (debit / credit lines)
-- ===========================================================================
-- Exactly one of (debit, credit) must be > 0 per line.
-- SUM(debit) = SUM(credit) per transaction (enforced by deferred trigger).

CREATE TABLE transaction_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL REFERENCES transactions(id),
    line_number     INT NOT NULL,
    account_id      UUID NOT NULL REFERENCES accounts(id),
    debit           NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
    credit          NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    -- Optional dimensions for richer reporting
    lp_id           UUID REFERENCES lps(id),
    security_id     UUID REFERENCES securities(id),
    quantity        NUMERIC(20,8),
    description     TEXT,
    -- One and only one of debit / credit > 0
    CHECK ((debit > 0) <> (credit > 0)),
    UNIQUE (transaction_id, line_number)
);

CREATE INDEX idx_tx_lines_account  ON transaction_lines(account_id);
CREATE INDEX idx_tx_lines_lp       ON transaction_lines(lp_id)       WHERE lp_id IS NOT NULL;
CREATE INDEX idx_tx_lines_security ON transaction_lines(security_id) WHERE security_id IS NOT NULL;

-- Deferred trigger: enforce SUM(debit) = SUM(credit) per transaction.
-- Deferred so the application can insert all lines in a single
-- BEGIN/COMMIT block before the check fires.
CREATE OR REPLACE FUNCTION trg_check_tx_balanced()
RETURNS TRIGGER AS $$
DECLARE
    total_debit  NUMERIC(20,4);
    total_credit NUMERIC(20,4);
    txn_id       UUID;
BEGIN
    txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO total_debit, total_credit
      FROM transaction_lines
     WHERE transaction_id = txn_id;
    -- Allow $0.0001 tolerance for accumulated rounding.
    IF ABS(total_debit - total_credit) > 0.0001 THEN
        RAISE EXCEPTION
            'Transaction % unbalanced: debit=% credit=%',
            txn_id, total_debit, total_credit;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER check_tx_balanced
    AFTER INSERT OR UPDATE OR DELETE ON transaction_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_check_tx_balanced();

-- Now that transactions exists, wire up the FK from tax_lots.
ALTER TABLE tax_lots ADD CONSTRAINT tax_lots_open_txn_fkey
    FOREIGN KEY (open_transaction_id)  REFERENCES transactions(id);
ALTER TABLE tax_lots ADD CONSTRAINT tax_lots_close_txn_fkey
    FOREIGN KEY (close_transaction_id) REFERENCES transactions(id);


-- ===========================================================================
-- 14–15. NAV snapshots (period-end fund + per-LP capital accounts)
-- ===========================================================================
-- A NAV snapshot is a frozen valuation as of a given date. Drives:
--   - LP statements
--   - Mgmt fee calc (when basis is NAV)
--   - Carry calc (period P&L + high-water mark)
--   - Any "what was our AUM on date X" query
-- A restatement creates a NEW snapshot with status='restated' that
-- references the original via `restates_id`. The original is preserved.

CREATE TABLE nav_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    as_of_date          DATE NOT NULL,
    period_kind         TEXT NOT NULL CHECK (period_kind IN ('monthly','quarterly','annual')),
    -- Components — as of as_of_date, before any accrual entries for the
    -- next period.
    cash                NUMERIC(20,4) NOT NULL,
    securities_mv       NUMERIC(20,4) NOT NULL,
    accrued_income      NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_expense     NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_mgmt_fee    NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_carry       NUMERIC(20,4) NOT NULL DEFAULT 0,
    -- Totals
    gross_nav           NUMERIC(20,4) NOT NULL,
    net_nav             NUMERIC(20,4) NOT NULL,
    -- Period comparison
    prior_net_nav       NUMERIC(20,4),
    period_pnl          NUMERIC(20,4),
    period_pnl_pct      NUMERIC(10,6),
    -- Source of valuations
    valuation_source    TEXT,            -- 'eod_quotes','manual','custodian'
    -- Lifecycle
    status              TEXT NOT NULL CHECK (status IN
                            ('draft','reviewed','final','restated')),
    finalized_at        TIMESTAMPTZ,
    finalized_by        UUID REFERENCES users(id),
    restates_id         UUID REFERENCES nav_snapshots(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A given (fund, date, period_kind) may only have one *active* snapshot.
-- Restated rows have restates_id set, so the partial unique index lets
-- multiple restatements coexist with the original.
CREATE UNIQUE INDEX uniq_nav_active
    ON nav_snapshots (fund_id, as_of_date, period_kind)
    WHERE restates_id IS NULL;

CREATE INDEX idx_nav_fund_date ON nav_snapshots(fund_id, as_of_date DESC);

CREATE TABLE nav_snapshot_lp (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nav_snapshot_id     UUID NOT NULL REFERENCES nav_snapshots(id),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    -- Inception-to-date capital activity
    contributed_itd     NUMERIC(20,4) NOT NULL,
    distributed_itd     NUMERIC(20,4) NOT NULL,
    -- Period allocations
    realized_pnl        NUMERIC(20,4) NOT NULL,
    unrealized_pnl      NUMERIC(20,4) NOT NULL,
    income              NUMERIC(20,4) NOT NULL DEFAULT 0,
    expenses            NUMERIC(20,4) NOT NULL DEFAULT 0,
    mgmt_fee            NUMERIC(20,4) NOT NULL DEFAULT 0,
    carry               NUMERIC(20,4) NOT NULL DEFAULT 0,
    -- Result
    ending_capital      NUMERIC(20,4) NOT NULL,
    -- Performance
    period_pnl_pct      NUMERIC(10,6),
    inception_pnl_pct   NUMERIC(10,6),         -- coarse IRR / TVPI hint
    UNIQUE (nav_snapshot_id, lp_id)
);


-- ===========================================================================
-- 16. mgmt_fee_runs  (quarterly/monthly fee accruals)
-- ===========================================================================
-- One row per (fund, period). When `status` flips to 'accrued', a
-- transaction is posted: dr Mgmt Fee Expense / cr Accrued Mgmt Fee.
-- When the GP collects cash, a second transaction posts:
-- dr Accrued Mgmt Fee / cr Cash.

CREATE TABLE mgmt_fee_runs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id                 UUID NOT NULL REFERENCES funds(id),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    fee_pct                 NUMERIC(6,4) NOT NULL,    -- snapshotted at run time
    fee_basis               TEXT NOT NULL,
    total_fee               NUMERIC(20,4) NOT NULL,
    posted_transaction_id   UUID REFERENCES transactions(id),
    status                  TEXT NOT NULL CHECK (status IN
                                ('draft','accrued','paid','reversed')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, period_start, period_end)
);

CREATE TABLE mgmt_fee_allocations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mgmt_fee_run_id     UUID NOT NULL REFERENCES mgmt_fee_runs(id),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    basis_amount        NUMERIC(20,4) NOT NULL,    -- avg committed/contributed/nav
    fee_amount          NUMERIC(20,4) NOT NULL,
    UNIQUE (mgmt_fee_run_id, lp_id)
);


-- ===========================================================================
-- 17. carry_runs  (performance allocation with hurdle + HWM)
-- ===========================================================================
-- The GP earns carry_pct of LP profit ABOVE hurdle, AFTER recovering
-- any prior period losses (high-water mark).

CREATE TABLE carry_runs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id                 UUID NOT NULL REFERENCES funds(id),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    carry_pct               NUMERIC(6,4) NOT NULL,
    hurdle_pct              NUMERIC(6,4),
    catch_up_pct            NUMERIC(6,4),
    total_carry             NUMERIC(20,4) NOT NULL,
    posted_transaction_id   UUID REFERENCES transactions(id),
    status                  TEXT NOT NULL CHECK (status IN
                                ('draft','accrued','crystallized','reversed')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fund_id, period_start, period_end)
);

CREATE TABLE carry_allocations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carry_run_id            UUID NOT NULL REFERENCES carry_runs(id),
    lp_id                   UUID NOT NULL REFERENCES lps(id),
    period_pnl              NUMERIC(20,4) NOT NULL,    -- LP's share of P&L
    hurdle_amount           NUMERIC(20,4) NOT NULL,    -- 8% of avg capital
    excess_amount           NUMERIC(20,4) NOT NULL,    -- pnl above hurdle
    catch_up_amount         NUMERIC(20,4) NOT NULL DEFAULT 0,
    carry_amount            NUMERIC(20,4) NOT NULL,
    -- High water mark — max prior ending_capital seen for this LP.
    high_water_mark         NUMERIC(20,4) NOT NULL,
    new_high_water_mark     NUMERIC(20,4) NOT NULL,
    UNIQUE (carry_run_id, lp_id)
);


-- ===========================================================================
-- 18. lp_statements  (versioned PDFs)
-- ===========================================================================
-- One row per (LP, period). `version=1` is the original send.
-- A restatement creates `version=2` with `supersedes_id` set; both rows
-- are kept for audit. `pdf_hash_sha256` proves the bytes match what
-- was sent.

CREATE TABLE lp_statements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID NOT NULL REFERENCES funds(id),
    lp_id               UUID NOT NULL REFERENCES lps(id),
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,
    period_kind         TEXT NOT NULL CHECK (period_kind IN
                            ('monthly','quarterly','annual','final')),
    nav_snapshot_id     UUID NOT NULL REFERENCES nav_snapshots(id),
    -- Snapshot of LP capital at period_end — captured here so even if
    -- the source rows change later, the historical statement is preserved.
    contributed_itd     NUMERIC(20,4) NOT NULL,
    distributed_itd     NUMERIC(20,4) NOT NULL,
    ending_capital      NUMERIC(20,4) NOT NULL,
    period_return_pct   NUMERIC(10,6),
    itd_return_pct      NUMERIC(10,6),
    -- PDF artifacts
    pdf_path            TEXT,
    pdf_hash_sha256     TEXT,
    -- Versioning
    version             INT NOT NULL DEFAULT 1,
    supersedes_id       UUID REFERENCES lp_statements(id),
    -- Lifecycle
    status              TEXT NOT NULL CHECK (status IN
                            ('draft','review','sent','restated')),
    sent_at             TIMESTAMPTZ,
    sent_to_email       CITEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by          UUID REFERENCES users(id),
    UNIQUE (fund_id, lp_id, period_end, version)
);


-- ===========================================================================
-- 19. audit_log  (every mutating action, append-only)
-- ===========================================================================
-- Bigserial PK because we expect high write volume. JSONB before/after
-- snapshots so any change can be reconstructed for forensics or audit.

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id         UUID REFERENCES users(id),
    -- What was changed
    table_name      TEXT NOT NULL,
    row_id          UUID,
    action          TEXT NOT NULL CHECK (action IN
                        ('insert','update','delete','login','export','sign')),
    -- Snapshots of the row state (so any change is reconstructable).
    before_snapshot JSONB,
    after_snapshot  JSONB,
    -- Source
    ip_address      INET,
    user_agent      TEXT
);

CREATE INDEX idx_audit_table_row ON audit_log(table_name, row_id, occurred_at DESC);
CREATE INDEX idx_audit_user      ON audit_log(user_id, occurred_at DESC);


-- ===========================================================================
-- Convenience views — read-only, computed on demand
-- ===========================================================================

-- LP capital account balance as-of-today (no period boundaries — for
-- ad-hoc lookup, not statements).
CREATE VIEW v_lp_balance_today AS
SELECT
    l.id            AS lp_id,
    l.fund_id,
    l.legal_name,
    COALESCE(c.commitment, 0)       AS commitment,
    COALESCE(SUM(CASE WHEN cca.received_at IS NOT NULL
                      THEN cca.receipt_amount ELSE 0 END), 0)
                                    AS contributed_itd,
    COALESCE(SUM(CASE WHEN da.paid_at IS NOT NULL
                      THEN da.amount ELSE 0 END), 0)
                                    AS distributed_itd
FROM       lps l
LEFT JOIN (
    SELECT lp_id, SUM(commitment_amount) AS commitment
      FROM commitments
     WHERE superseded_by IS NULL
     GROUP BY lp_id
) c                                ON c.lp_id = l.id
LEFT JOIN  capital_call_allocations cca ON cca.lp_id = l.id
LEFT JOIN  distribution_allocations  da ON da.lp_id = l.id
GROUP BY l.id, l.fund_id, l.legal_name, c.commitment;


-- Trial balance (a sanity check — should always sum to zero per fund).
CREATE VIEW v_trial_balance AS
SELECT
    a.fund_id,
    a.code,
    a.name,
    a.type,
    COALESCE(SUM(tl.debit),  0)                             AS total_debit,
    COALESCE(SUM(tl.credit), 0)                             AS total_credit,
    COALESCE(SUM(tl.debit),  0) - COALESCE(SUM(tl.credit), 0) AS balance
FROM       accounts a
LEFT JOIN  transaction_lines tl ON tl.account_id = a.id
GROUP BY a.fund_id, a.id, a.code, a.name, a.type
ORDER BY a.code;
