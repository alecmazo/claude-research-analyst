-- ===========================================================================
-- Seed: Standard hedge-fund Chart of Accounts
--
-- This is a baseline. Each fund inserts these rows once at setup time.
-- Per-LP capital accounts and per-security position accounts are
-- created dynamically when an LP onboards or a new security is bought.
--
-- Coding convention:
--   1xxx  Assets
--   2xxx  Liabilities
--   3xxx  Equity (LP capital, GP capital, retained earnings)
--   4xxx  Income (realized gains, dividends, interest)
--   5xxx  Expenses (mgmt fee, fund expenses)
--   6xxx  Performance allocation (carry)
--
-- Replace :fund_id with the UUID of the row in `funds` you're seeding for.
-- Run with `psql -v fund_id=<uuid> -f 0001_chart_of_accounts.sql`.
-- ===========================================================================

\set fund_uuid '\'':fund_id'\''

-- ─── Assets ─────────────────────────────────────────────────────────────────
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '1010', 'Cash — Operating Account',          'asset'),
    (:fund_uuid::uuid, '1020', 'Cash — Brokerage',                   'asset'),
    (:fund_uuid::uuid, '1030', 'Cash — Money Market',                'asset'),
    (:fund_uuid::uuid, '1100', 'Securities at Cost',                 'asset'),
    (:fund_uuid::uuid, '1110', 'Mark-to-Market Adjustment',          'asset'),
    (:fund_uuid::uuid, '1200', 'Subscriptions Receivable',           'asset'),
    (:fund_uuid::uuid, '1210', 'Dividends Receivable',               'asset'),
    (:fund_uuid::uuid, '1220', 'Interest Receivable',                'asset'),
    (:fund_uuid::uuid, '1300', 'Prepaid Expenses',                   'asset');

-- ─── Liabilities ────────────────────────────────────────────────────────────
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '2010', 'Trade Settlement Payable',           'liability'),
    (:fund_uuid::uuid, '2100', 'Accrued Management Fee',             'liability'),
    (:fund_uuid::uuid, '2110', 'Accrued Performance Fee (Carry)',    'liability'),
    (:fund_uuid::uuid, '2200', 'Distributions Payable',              'liability'),
    (:fund_uuid::uuid, '2300', 'Accrued Expenses — Audit',           'liability'),
    (:fund_uuid::uuid, '2310', 'Accrued Expenses — Legal',           'liability'),
    (:fund_uuid::uuid, '2320', 'Accrued Expenses — Fund Admin',      'liability'),
    (:fund_uuid::uuid, '2330', 'Accrued Expenses — Other',           'liability');

-- ─── Equity (LP capital — per-LP rows added dynamically at onboard) ─────────
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '3000', 'Capital — General Partner',          'equity'),
    (:fund_uuid::uuid, '3100', 'Capital — Limited Partners (control)','equity'),
    (:fund_uuid::uuid, '3900', 'Retained Earnings',                  'equity');
-- Note: per-LP capital sub-accounts use code '3100-<short_id>' and
-- have lp_id set. The application creates these on `INSERT INTO lps`.

-- ─── Income ─────────────────────────────────────────────────────────────────
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '4100', 'Realized Gain — Long-Term',          'income'),
    (:fund_uuid::uuid, '4110', 'Realized Gain — Short-Term',         'income'),
    (:fund_uuid::uuid, '4200', 'Unrealized Gain (Mark-to-Market)',   'income'),
    (:fund_uuid::uuid, '4300', 'Dividend Income',                    'income'),
    (:fund_uuid::uuid, '4400', 'Interest Income',                    'income'),
    (:fund_uuid::uuid, '4900', 'Other Income',                       'income');

-- ─── Expenses ───────────────────────────────────────────────────────────────
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '5100', 'Management Fee Expense',             'expense'),
    (:fund_uuid::uuid, '5200', 'Audit Fee',                          'expense'),
    (:fund_uuid::uuid, '5210', 'Legal Fees',                         'expense'),
    (:fund_uuid::uuid, '5220', 'Fund Administration Fees',           'expense'),
    (:fund_uuid::uuid, '5230', 'Custody Fees',                       'expense'),
    (:fund_uuid::uuid, '5240', 'Brokerage Commissions',              'expense'),
    (:fund_uuid::uuid, '5300', 'Realized Loss — Long-Term',          'expense'),
    (:fund_uuid::uuid, '5310', 'Realized Loss — Short-Term',         'expense'),
    (:fund_uuid::uuid, '5400', 'Unrealized Loss (Mark-to-Market)',   'expense'),
    (:fund_uuid::uuid, '5900', 'Other Fund Expenses',                'expense');

-- ─── Performance Allocation (Carry) ─────────────────────────────────────────
-- These are technically equity transfers (LP → GP) but bookkeeping
-- convention treats them as expenses to surface them on the P&L.
INSERT INTO accounts (fund_id, code, name, type) VALUES
    (:fund_uuid::uuid, '6100', 'Performance Allocation Expense',     'expense'),
    (:fund_uuid::uuid, '6200', 'Performance Allocation Reversal',    'contra');
