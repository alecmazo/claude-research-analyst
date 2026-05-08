-- Migration 0004: YTD result cache for managed accounts
-- Stores the latest YTD calculation result per managed account so it
-- survives Railway redeploys (replaces localStorage-only approach).

CREATE TABLE IF NOT EXISTS managed_account_ytd_cache (
    fund_id     UUID          PRIMARY KEY REFERENCES funds(id) ON DELETE CASCADE,
    nav         NUMERIC(20,6) DEFAULT 0,
    ytd_pct     NUMERIC(10,6) DEFAULT 0,
    result_json TEXT,                       -- full JSON from /api/track/live/ytd
    updated_at  TIMESTAMPTZ   DEFAULT now()
);
