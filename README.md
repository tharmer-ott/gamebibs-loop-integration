# GameBibs ⇄ Loop Returns Integration

NetSuite SuiteScript integration between **GameBibs (NetSuite)** and **Loop Returns**.

- **Outbound (NetSuite → Loop):** customers, products, locations, inventory, and orders are pushed to Loop via a shared Map/Reduce dispatcher (`loop_mr_integration.js`), each kicked off by a Suitelet deployment (`loop_sl_integration.js`).
- **Inbound (Loop → NetSuite):** closed returns are pulled from Loop and turned into NetSuite refund/exchange transactions by a standalone Map/Reduce (`loop_returns.js`). This automates the previously manual refund/exchange bookkeeping.

See [`loop_api_spec.md`](loop_api_spec.md) for the Loop API reference and GameBibs-specific field mappings.

> ⚠️ **This integration moves real money.** Saving a Customer Refund transforms the original Customer Deposit and **fires the live Braintree refund**. Treat the returns flow with production-level care.

---

## 1. Major Concerns / Things That Could Go Wrong

> Ranked roughly by blast radius. Anything marked 🔴 must be resolved before go-live.

### 🔴 Test-only filters still hardcoded (blocks go-live)
Both sync directions are currently pinned to a single record for testing:
- [`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js) — `getInputData()` filters `['tranid', 'is', 'SO31015']`.
- [`loop_returns.js`](src/FileCabinet/SuiteScripts/Loop/loop_returns.js) — `getInputData()` filters `ONLY_ORDER_NAME = 'SO31057'`.

If deployed as-is, a "full sync" processes exactly one order / one return. **These must be removed before production.**

### 🟠 Non-deterministic tax reconciliation
In [`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js), when allocated tax doesn't reconcile to the order total by more than 2 cents, the difference is **spread one cent at a time across randomly chosen lines** (`Math.random()`). This masks what the code itself calls "a data anomaly" instead of surfacing it, and produces a **different allocation on every re-sync** of the same order. Consider failing loudly (or logging + deterministic allocation) on large diffs.

### 🟡 Unfilled deploy placeholder
`loop_sl_integration.js` has `MR_PRIMARY_KEY = 'TODO'` — until filled with the MR script record's internal ID, the Suitelet can't redirect to the Map/Reduce status page (it falls back to a plain text confirmation).

### 🟡 Debug logging still on
`loop_returns.js` has `DEBUG = true` plus several `TEMP (diagnostics)` audit logs. Flip off (or promote to a deployment param) for go-live to avoid flooding the execution log.

---

## 2. TODO

### Before go-live 🔴
- [ ] Remove the `SO31015` test filter from `loop_orders.js`.
- [ ] Remove the `ONLY_ORDER_NAME = 'SO31057'` test filter from `loop_returns.js`.
- [ ] Fix (or confirm) the returns lookback unit bug.
- [ ] Fill in `MR_PRIMARY_KEY` in `loop_sl_integration.js`.
- [ ] Set `DEBUG = false` in `loop_returns.js` and remove `TEMP (diagnostics)` logs.
- [ ] Verify the refund flow against a **live Braintree sandbox → production** dry run with a known order.

### Hardening 🟠
- [ ] Make refund flow resumable after partial failure (per-step tagging or rollback).
- [ ] Replace random tax reconciliation with deterministic allocation + loud logging on large diffs.
- [ ] Decide on real vs. placeholder customer email/phone in the order push.
- [ ] Add retry/backoff around Loop API calls.

### Nice to have 🟡
- [ ] Support multi-line refunds and multi-qty exchanges.
- [ ] Add unit-test coverage for the returns refund/exchange flows (currently only `loop_returns.test.js` exists — confirm what it covers).
- [ ] Document the deployment/runbook steps (which Suitelet deployment triggers which sync).

---

## 3. Who's Who

| Person | Role | Contact |
|--------|------|---------|
| _Tanner Harmer_ | Initial Developer | tannerharmer@gmail.com |
| _Brian Helbing_ | GameBibs Admin | brianhelbing@gamebibs.com |
| _Joshua Coenen_ | GameBibs Admin | joshuacoenen@gamebibs.com |
| _Luke Helbing_ | GameBibs Admin | lukehelbing@gamebibs.com |
| _John Sammon_ | PFC | jsammon@pfcfulfills.com |
| _Meg Burnie_ | Coalition PM | meg.burnie@coalitiontechnologies.com |
| _Rafaela Kurumoto_ | Coalition Technical Lead | rafaela.kurumoto@coalitiontechnologies.com |
| _Alex Kehl_ | Loop Returns | alexkehl@loopreturns.com |
| _Mike Schmitt_ | Loop Returns | mikeschmitt@loopreturns.com |

---

_Last updated: 2026-08-13_

Ignore me - Alex edit
