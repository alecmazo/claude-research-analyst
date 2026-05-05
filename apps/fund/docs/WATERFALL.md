# Carry waterfall — math, with examples

The "waterfall" describes how each dollar of LP profit is split
between LP and GP. The schema supports the most common 3(c)(1)
structure: **2-and-20 with hurdle and high-water mark**.

> Default structure (configurable per fund on the `funds` row):
> - `mgmt_fee_pct = 2%` annualized
> - `carry_pct = 20%`
> - `hurdle_pct = 8%` annualized preferred return
> - `catch_up_pct = 100%` GP catch-up
> - **High-water mark** per LP

---

## The four-tier waterfall

For each accounting period, profit attributable to each LP flows in
this priority order:

1. **Return of capital** — until each LP gets back what they put in.
2. **Hurdle** — LP keeps 100% of profit up to the hurdle rate (usually
   8% annualized) on their average capital balance.
3. **Catch-up** — GP receives 100% of the next slug of profit until
   the GP-to-LP split on profit-above-cost catches up to 20%/80%.
4. **Carried interest** — remaining profit splits 20% GP / 80% LP.

In each step the cumulative profit is checked against the LP's
**high-water mark** (the highest ending capital ever recorded). Carry
only accrues on profit that exceeds the HWM.

---

## Per-period worked example

Setup:
- LP "Acme" contributed **$1,000,000** at inception (Q1 2026).
- HWM = $1,000,000.
- Q1 2026: portfolio gains 12% → Acme's ending capital before fees = $1,120,000.
- Period P&L: $120,000.

### Step 1 — Hurdle

```
Hurdle = LP capital × 8% × (period_days / 365)
       = 1,000,000 × 0.08 × 0.25
       =        20,000
```

LP keeps the first $20,000 of profit. Carry-side amount so far: $0.

### Step 2 — Catch-up

The GP gets 100% of the next slug of profit until the cumulative
GP/LP split on profit-above-hurdle reaches 20/80. Algebraically:

```
Profit above hurdle so far = 0
For 100% catch-up, GP receives until:
    GP ÷ (GP + (hurdle + LP_post_hurdle)) = 20%
```

If the catch-up is 100% (most common), the GP receives **profit ×
0.20 ÷ 0.80 = profit × 0.25** of the hurdle, plus all subsequent
profit until 20% of the cumulative excess is accumulated.

For our example: profit above hurdle = $120,000 − $20,000 = $100,000.

```
Catch-up = hurdle × (carry_pct / (1 − carry_pct))
         = 20,000 × 0.25
         =     5,000
```

GP gets $5,000 in the catch-up tier. Profit remaining: $100,000 − $5,000 = $95,000.

### Step 3 — Carry on excess

```
Carry = remaining_profit × carry_pct
      = 95,000 × 0.20
      = 19,000
```

GP gets another $19,000. LP gets the other $76,000.

### Net results for the quarter

| Tier            | LP        | GP      | Total     |
|-----------------|-----------|---------|-----------|
| Hurdle          | 20,000    | 0       | 20,000    |
| Catch-up        | 0         | 5,000   | 5,000     |
| Carry           | 76,000    | 19,000  | 95,000    |
| **Total**       | **96,000**| **24,000** | **120,000** |
| % of profit     | 80%       | 20%     | 100%      |

The 80/20 split is achieved across the full $120K of profit, but the
LP's first $20K is risk-free (the hurdle). The catch-up exists because
without it, profit-above-hurdle would split 80/20 on top of the
$20K that all went to LP, making the effective lifetime split better
than 80/20 for the LP.

### Schema records

```sql
INSERT INTO carry_runs (
    fund_id, period_start, period_end, carry_pct, hurdle_pct, catch_up_pct,
    total_carry, status
) VALUES (
    dga, '2026-01-01', '2026-03-31', 0.20, 0.08, 1.00,
    24000, 'accrued'
);

INSERT INTO carry_allocations (
    carry_run_id, lp_id, period_pnl, hurdle_amount, excess_amount,
    catch_up_amount, carry_amount, high_water_mark, new_high_water_mark
) VALUES (
    q1_run, acme, 120000, 20000, 100000, 5000, 24000,
    1000000, 1096000
);
```

The journal entry:

```
category=carry_accrual, source_kind='carry_run', source_id=q1_run

  dr  6100      Performance Allocation Expense    24,000
      cr  2110      Accrued Performance Fee              24,000
```

---

## High-water mark — why it matters

Now suppose Q2 2026 is bad. Acme's portfolio drops 5%. Period P&L
attributable to Acme: −$54,800 (5% of $1,096,000).

- Acme's ending capital: $1,096,000 − $54,800 = $1,041,200.
- Acme's HWM (set at end of Q1): $1,096,000.
- Profit-above-HWM: −$54,800. Negative. **No carry accrues.**

```sql
INSERT INTO carry_allocations (
    carry_run_id, lp_id, period_pnl, hurdle_amount, excess_amount,
    catch_up_amount, carry_amount, high_water_mark, new_high_water_mark
) VALUES (
    q2_run, acme, -54800, 0, 0, 0, 0,
    1096000, 1096000  -- HWM unchanged
);
```

`new_high_water_mark` stays at $1,096,000. Q3 must recover above
$1,096,000 before any new carry accrues. This is the *high-water mark*
in action — the GP doesn't get paid twice for the same dollars of profit.

---

## When carry crystallizes vs. accrues

- **Accrued carry** (most quarters): the schema records the calc, posts
  a `carry_accrual` transaction debiting `6100` (P&L expense) and
  crediting `2110` (accrued liability). Cash hasn't moved.
- **Crystallized carry** (typically annual or at LP redemption): the
  GP actually takes the cash. A `carry_payment` transaction debits
  `2110` and credits `1010` (cash).

Most fund docs have a clawback provision: if accrued carry is paid
out and later periods erode profits below the HWM, the GP must return
some carry. The schema supports this via the standard reversal
pattern (`category='reversal'`, `reverses_id=<crystallization_txn>`).

---

## What the schema does for you (and what it doesn't)

**Does:**
- Stores period-by-period carry calcs, parameters, and HWM.
- Per-LP allocations (the math is per-LP, not fund-level — different
  LPs may have entered at different prices).
- Posted journal entries via `posted_transaction_id`.
- Audit history of every accrual + crystallization.

**Doesn't:**
- Compute the carry. The application runs the math; the schema only
  stores the result.
- Enforce the hurdle / catch-up / HWM logic at the DB layer. Wrong
  numbers in `carry_allocations.carry_amount` would post regardless;
  the responsibility lives in the API.

For that reason the carry calculator is the **single most important
piece of code to test exhaustively** in M6. Property-based tests
covering hurdle/no-hurdle, full/partial catch-up, HWM recovery, and
clawback edges are non-negotiable.
