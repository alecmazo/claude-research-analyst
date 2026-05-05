# Worked examples: every transaction type

Each section shows the journal entries the API should produce for a
given economic event. Account codes refer to the seed CoA in
`db/seed/0001_chart_of_accounts.sql`.

> Convention: **dr** = debit (left), **cr** = credit (right). Each
> example balances; SUM(dr) = SUM(cr).

---

## 1. New LP commits $250K (no cash yet)

A signed subscription document is a *commitment*, not a transaction.
The cap table tracks it via `commitments`; no journal entry posts
until cash actually moves.

```
INSERT INTO commitments (lp_id, fund_id, commitment_amount, effective_date, ...)
    VALUES (acme_lp_id, dga_fund_id, 250000, '2026-01-15', ...);
```

No transaction. No ledger movement. The capital account shows the
commitment in soft-state via the `v_lp_balance_today` view.

---

## 2. Capital call #3 — $1.0M total, Acme drawn for $250K

### Notice the call

```
INSERT INTO capital_calls (fund_id, call_number, notice_date, due_date,
                           total_amount, purpose, status)
    VALUES (dga_fund_id, 3, '2026-02-01', '2026-02-15',
            1000000, 'investment', 'noticed');

INSERT INTO capital_call_allocations (capital_call_id, lp_id, amount)
    VALUES (call3_id, acme_lp_id, 250000),
           (call3_id, beta_lp_id, 750000);
```

No ledger movement yet — Acme owes us $250K but hasn't paid.

### Acme wires the $250K (T+15)

A single transaction, two lines:

```
category=contribution, source_kind='capital_call', source_id=call3_id,
description='Capital Call #3 — Acme Trust contribution'

  dr  1010      Cash — Operating              250,000
      cr  3100-acme  Capital — Acme Trust            250,000
```

And mark the allocation as received:

```
UPDATE capital_call_allocations
   SET received_at = NOW(), receipt_amount = 250000
 WHERE capital_call_id = call3_id AND lp_id = acme_lp_id;
```

---

## 3. Fund buys 100 shares of AAPL @ $185

A trade has two sides: cash out, security in. Plus a brokerage
commission as a separate expense line.

```
category=trade_buy, source_kind='trade', source_id=trade_id,
description='Buy 100 AAPL @ 185'

  dr  1100-AAPL Securities at Cost — AAPL    18,500   (qty=100)
  dr  5240      Brokerage Commissions             5
      cr  1020      Cash — Brokerage              18,505
```

Plus a tax lot:

```
INSERT INTO tax_lots (fund_id, security_id, acquired_at, quantity,
                      cost_basis_per_unit, open_transaction_id)
    VALUES (dga, aapl_sec_id, NOW(), 100, 185.00, trade_txn_id);
```

---

## 4. End-of-day mark-to-market: AAPL closes at $190 (+$5)

A two-line transaction per position whose mark moves. The unrealized
gain is recognized as income on the P&L.

```
category=adjustment, description='EOD MTM 2026-02-03 — AAPL'

  dr  1110      MTM Adjustment              500
      cr  4200      Unrealized Gain              500
```

When the position is sold later, the unrealized side is reversed and a
realized gain is booked instead.

---

## 5. Sell 30 of those AAPL shares @ $200

Closing 30/100 of the lot. Cost basis: 30 × $185 = $5,550. Proceeds:
30 × $200 = $6,000. Realized gain: $450.

```
category=trade_sell, source_kind='trade', source_id=trade_id

  dr  1020      Cash — Brokerage           5,997   (after $3 commission)
  dr  5240      Brokerage Commissions          3
      cr  1100-AAPL Securities at Cost — AAPL    5,550   (qty=30)
      cr  4110      Realized Gain — Short-Term      450
```

Then split the lot:

```
-- Original lot (100 shares @ 185) is closed; create two children:
UPDATE tax_lots SET closed_at = NOW(),
                    closed_proceeds_per_unit = 200,
                    closed_realized_gain = 450,
                    close_transaction_id = sell_txn_id
 WHERE id = lot_id AND quantity = 30;
-- (In practice the application splits the lot into a closed 30-share
-- child and a remaining 70-share open child.)
```

---

## 6. Quarterly mgmt fee accrual — 2% annualized on $5M committed

Quarterly fee = $5M × 2% / 4 = $25,000.

```
category=mgmt_fee_accrual, source_kind='mgmt_fee_run', source_id=run_id,
description='Q1 2026 mgmt fee — 2% annualized × committed × 0.25'

  dr  5100      Management Fee Expense    25,000
      cr  2100      Accrued Mgmt Fee              25,000
```

The fee hits the P&L (5100) and creates a payable to the GP (2100).

### When the GP actually collects

```
category=mgmt_fee_payment

  dr  2100      Accrued Mgmt Fee          25,000
      cr  1010      Cash — Operating              25,000
```

Cash leaves the fund; the payable zeros out. P&L is unaffected
(already recognized at accrual).

---

## 7. Quarterly carry accrual — 20% above 2% hurdle, with HWM

Setup: Acme contributed $250K. Period P&L attributable to Acme:
$30K. Hurdle: 8% annualized × 0.25 × $250K = $5,000. So:

- Hurdle amount: $5,000
- Excess above hurdle: $30,000 − $5,000 = $25,000
- Catch-up (full): GP gets the next $X until total split = 80/20
- Carry on excess: $25,000 × 20% = $5,000 (assuming no catch-up)

```
category=carry_accrual, source_kind='carry_run', source_id=run_id

  dr  6100      Performance Allocation Expense   5,000
      cr  2110      Accrued Performance Fee             5,000
```

The HWM lookup matters for *future* periods: if Q2 has a $10K loss
attributable to Acme, the new HWM stays at the prior peak. Carry only
restarts after the loss is recovered.

### When carry crystallizes (typically annually)

```
category=carry_payment

  dr  2110      Accrued Performance Fee   5,000
      cr  1010      Cash — Operating              5,000
```

Cash leaves the fund to the GP capital account. Carry is now real.

---

## 8. Distribution — fund pays $200K back to LPs

Class breakdown: $150K return-of-capital, $50K LTCG.

```
INSERT INTO distributions (fund_id, distribution_number, notice_date,
                            payment_date, total_amount, class, status)
    VALUES (dga, 5, '2026-04-15', '2026-04-30', 200000,
            '{"return_of_capital": 150000, "ltcg": 50000}', 'paid');

INSERT INTO distribution_allocations (distribution_id, lp_id, amount, class)
    VALUES (dist5, acme, 50000,  '{"return_of_capital": 37500, "ltcg": 12500}'),
           (dist5, beta, 150000, '{"return_of_capital": 112500, "ltcg": 37500}');
```

### The journal entry

```
category=distribution, source_kind='distribution', source_id=dist5

  dr  3100-acme  Capital — Acme Trust       50,000
  dr  3100-beta  Capital — Beta Holdings   150,000
      cr  1010      Cash — Operating             200,000
```

Distributions reduce LP capital (debit equity) and reduce cash
(credit asset). The class breakdown is informational only at the
journal-entry level — it drives K-1s, not the GL.

---

## 9. Reversing a mistake

You posted the Q1 mgmt fee but accidentally used the wrong rate.
Don't update the row — reverse it.

```
-- Original (txn_orig_id):
category=mgmt_fee_accrual, dr 5100 25000 / cr 2100 25000

-- Reversal (txn_reversal_id, reverses_id=txn_orig_id):
category=reversal, description='Reverses Q1 2026 mgmt fee — wrong rate'
  dr  2100      Accrued Mgmt Fee          25,000
      cr  5100      Mgmt Fee Expense              25,000

-- Then post the corrected accrual:
category=mgmt_fee_accrual, dr 5100 30000 / cr 2100 30000
```

The audit trail now shows: posted 25K → reversed 25K → posted 30K.
An auditor can reconstruct exactly what happened and when.

---

## 10. Subscription that gets refused (regulatory issue)

Acme signs the sub doc, wires $250K, but during accreditation review
we find their docs don't hold up. Refund.

### The original contribution

(See example 2.) `dr 1010 250K / cr 3100-acme 250K`.

### The refund

```
category=reversal, reverses_id=acme_contrib_txn_id,
description='Refund — Acme accreditation rejected'

  dr  3100-acme  Capital — Acme Trust    250,000
      cr  1010      Cash — Operating             250,000
```

Acme's capital account is back to zero; cash leaves the fund. The
commitment row is *not* deleted — it's superseded by a new commitment
row of $0 (or the LP is closed). The audit trail makes the rejection
visible.
