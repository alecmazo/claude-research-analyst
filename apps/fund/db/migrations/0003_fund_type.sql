-- Migration 0003: Fund type discriminator
-- ---------------------------------------------------------------------------
-- Adds fund_type column to support both LP funds and single-owner managed
-- accounts under the same schema. This is the unified backing store for the
-- "LP FUND" and "MANAGED ACCOUNT" branches in the UI.
--
-- Values:
--   'lp_fund'         — pooled fund with LPs, waterfall economics, carry
--   'managed_account' — single-owner portfolio, simple % mgmt fee, no carry
--
-- All existing rows default to 'lp_fund' (backward-compatible).
-- ---------------------------------------------------------------------------

ALTER TABLE funds
    ADD COLUMN IF NOT EXISTS fund_type TEXT NOT NULL DEFAULT 'lp_fund'
        CHECK (fund_type IN ('lp_fund', 'managed_account'));

CREATE INDEX IF NOT EXISTS idx_funds_fund_type ON funds(fund_type);

COMMENT ON COLUMN funds.fund_type IS
  'Discriminator: lp_fund = pooled fund with LPs/waterfall; '
  'managed_account = single-owner portfolio with simple mgmt fee.';
