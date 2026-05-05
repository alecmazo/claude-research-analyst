-- Migration 0002: Annual waterfall snapshots
-- ---------------------------------------------------------------------------
-- Stores year-end fund performance for precise annual-hurdle carry calculation.
--
-- Model:
--   • Annual hurdle  = start_nav × hurdle_pct  (5% of beginning-of-year NAV)
--   • Carry earned   = max(0, 25% × (gross_profit − hurdle_amount))
--   • Carry paid     = cash actually distributed to GP (typically 0 for this fund)
--   • Carry rolled   = carry_earned − carry_paid  (added to GP equity)
--   • gp_equity_end  = prior year gp_equity_end + carry_rolled (cumulative)
--
-- High-water mark: start_nav for year N is end_nav from year N-1.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fund_annual_snapshots (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id         UUID        NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    year            SMALLINT    NOT NULL CHECK (year BETWEEN 2000 AND 2100),

    -- Balance sheet at year boundaries
    start_nav       NUMERIC(18,2) NOT NULL,   -- Jan 1 NAV (= prior Dec 31 NAV)
    end_nav         NUMERIC(18,2) NOT NULL,   -- Dec 31 NAV (audited / estimated)

    -- Capital flows during the year (positive = inflow, negative = distribution)
    contributions   NUMERIC(18,2) NOT NULL DEFAULT 0,

    -- Waterfall components (all calculated from the above, stored for auditability)
    hurdle_amount   NUMERIC(18,2) NOT NULL,   -- start_nav × hurdle_pct
    gross_profit    NUMERIC(18,2) NOT NULL,   -- end_nav − start_nav − contributions
    carry_earned    NUMERIC(18,2) NOT NULL DEFAULT 0,  -- 25% of (gross_profit − hurdle_amount) if positive
    carry_paid      NUMERIC(18,2) NOT NULL DEFAULT 0,  -- cash paid to GP (0 for this fund)
    carry_rolled    NUMERIC(18,2) NOT NULL DEFAULT 0,  -- carry_earned − carry_paid

    -- Cumulative GP equity balance at Dec 31 of this year
    -- (prior year balance + carry_rolled this year)
    gp_equity_end   NUMERIC(18,2) NOT NULL DEFAULT 0,

    notes           TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW(),

    UNIQUE(fund_id, year)
);

-- Per-LP annual breakdown (optional — filled when LP-level data is available)
CREATE TABLE IF NOT EXISTS lp_annual_snapshots (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    fund_id             UUID        NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
    lp_id               UUID        NOT NULL REFERENCES lps(id)  ON DELETE CASCADE,
    year                SMALLINT    NOT NULL,

    -- LP's share of the fund at year start/end
    start_value         NUMERIC(18,2),   -- LP capital account Jan 1
    end_value_gross     NUMERIC(18,2),   -- LP capital account Dec 31 before carry
    carry_charge        NUMERIC(18,2),   -- LP's proportional share of carry_earned
    end_value_net       NUMERIC(18,2),   -- end_value_gross − carry_charge

    -- LP ownership percentage of total LP capital (excludes GP equity)
    lp_share_pct        NUMERIC(8,4),

    notes               TEXT,

    UNIQUE(fund_id, lp_id, year),
    FOREIGN KEY (fund_id, year)
        REFERENCES fund_annual_snapshots(fund_id, year) ON DELETE CASCADE
);

-- LP email addresses (stored on the lps table — add column if missing)
ALTER TABLE lps ADD COLUMN IF NOT EXISTS primary_email  CITEXT;
ALTER TABLE lps ADD COLUMN IF NOT EXISTS notify_quarterly BOOLEAN NOT NULL DEFAULT true;

COMMENT ON TABLE fund_annual_snapshots IS
  'Year-end waterfall snapshots for annual hurdle carry calculation. '
  'Populate via the Fund Admin UI or seed script with actual audited NAVs.';

COMMENT ON TABLE lp_annual_snapshots IS
  'Per-LP breakdown of annual waterfall. Optional but required for per-LP '
  'quarterly reports.';
