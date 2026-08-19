# GameBibs ⇄ Loop Returns Integration

NetSuite SuiteScript integration between **GameBibs (NetSuite)** and **Loop Returns**.

- **Outbound (NetSuite → Loop):** customers, products, locations, inventory, and orders are pushed to Loop via a shared Map/Reduce dispatcher (`loop_mr_integration.js`), each kicked off by a Suitelet deployment (`loop_sl_integration.js`).
- **Inbound (Loop → NetSuite):** closed returns are pulled from Loop and turned into NetSuite refund/exchange transactions by a standalone Map/Reduce (`loop_returns.js`). This automates the previously manual refund/exchange bookkeeping.

See [`loop_api_spec.md`](loop_api_spec.md) for the Loop API reference and GameBibs-specific field mappings.

> ⚠️ **This integration moves real money.** Saving a Customer Refund transforms the original Customer Deposit and **fires the live Braintree refund**. Treat the returns flow with production-level care.

---

## Recent changes (2026-08-19)

The outbound flows — **orders, products, and inventory** — were taken to production this round. Highlights:

- **Orders go-live scope.** Removed the `SO31015` test filter. Orders now sync on a permanent `trandate onorafter 7/31/2026` floor, restricted to the BigCommerce bucket customer (entity 1020), fulfilled/billed statuses (`SalesOrd:D/E/F/G`), and not-yet-uploaded. A `TEST_ORDER_TRANID` toggle (default `null`) supports single-order sanity checks.
- **Environment-safe fulfillment location.** The previously hardcoded Loop location ID is now resolved from `runtime.envType` in both [`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js) and [`loop_inventory.js`](src/FileCabinet/SuiteScripts/Loop/loop_inventory.js) (sandbox vs production), closing a latent sandbox/prod mismatch.
- **Inventory single-location rewrite.** Dropped the per-location row expansion (which returned a blank location on a single-location account and skipped every row) and the location-record lookup; inventory now pushes the aggregate available count straight to the one Loop location.
- **Order customer email.** The inline customer upsert now sources the real email from the SO `email` field, falling back to the placeholder only when blank.
- **Products.** `TEST_GROUP_ID` → `TEST_GROUP_IDS` list (default `null` = full catalog); full catalog synced.
- **Objects.** Added missing SDF object defs: `custitem_loop_product_variant_id`, `custbody_loop_return_id`, and the `customscript_loop_returns` Map/Reduce.

The **returns (inbound)** flow is **not yet live** — see the go-live items below.

---

## 1. Major Concerns / Things That Could Go Wrong

> Ranked roughly by blast radius. Anything marked 🔴 must be resolved before go-live.

### 🔴 Returns test filter still hardcoded (blocks returns go-live)
[`loop_returns.js`](src/FileCabinet/SuiteScripts/Loop/loop_returns.js) — `getInputData()` still filters `ONLY_ORDER_NAME = 'SO31057'`, so a "full sync" of returns processes exactly one return. **Must be removed before the returns flow goes live.**

The **outbound** test scopes are cleared: `loop_orders.js` replaced its `SO31015` filter with the `7/31/2026` date floor plus a `TEST_ORDER_TRANID` toggle (default `null`), and `loop_products.js` uses `TEST_GROUP_IDS` (default `null`). Note [`loop_products_delete.js`](src/FileCabinet/SuiteScripts/Loop/loop_products_delete.js) still carries `TEST_PARENT_ID = 846` — it's a manual cleanup utility, so scope it deliberately before each run.

### 🟠 Non-deterministic tax reconciliation
In [`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js), when allocated tax doesn't reconcile to the order total by more than 2 cents, the difference is **spread one cent at a time across randomly chosen lines** (`Math.random()`). This masks what the code itself calls "a data anomaly" instead of surfacing it, and produces a **different allocation on every re-sync** of the same order. Consider failing loudly (or logging + deterministic allocation) on large diffs.

### 🟡 Unfilled deploy placeholder
`loop_sl_integration.js` has `MR_PRIMARY_KEY = 'TODO'` — until filled with the MR script record's internal ID, the Suitelet can't redirect to the Map/Reduce status page (it falls back to a plain text confirmation).

### 🟡 Debug logging still on
`loop_returns.js` has `DEBUG = true` plus several `TEMP (diagnostics)` audit logs. Flip off (or promote to a deployment param) for go-live to avoid flooding the execution log.

---

## 2. TODO

### Before go-live 🔴
- [x] Remove the `SO31015` test filter from `loop_orders.js`. *(done — replaced with the `7/31/2026` date floor + `TEST_ORDER_TRANID` toggle)*
- [ ] Remove the `ONLY_ORDER_NAME = 'SO31057'` test filter from `loop_returns.js` (returns only).
- [ ] Fix (or confirm) the returns lookback unit bug.
- [ ] Fill in `MR_PRIMARY_KEY` in `loop_sl_integration.js`.
- [ ] Set `DEBUG = false` in `loop_returns.js` and remove `TEMP (diagnostics)` logs.
- [ ] Verify the refund flow against a **live Braintree sandbox → production** dry run with a known order.

### Hardening 🟠
- [ ] Make refund flow resumable after partial failure (per-step tagging or rollback).
- [ ] Replace random tax reconciliation with deterministic allocation + loud logging on large diffs.
- [x] Customer email in the order push now comes from the SO `email` field. *(phone remains a placeholder — no source field on the order)*
- [ ] Add retry/backoff around Loop API calls.
- [ ] Variant `external_id` is keyed on UPC (`barcode || internalId`), but UPCs are not guaranteed unique in the catalog — two same-parent variants sharing a UPC would silently fail to create in Loop. Consider keying on the (unique) NS internal id, and/or add a duplicate-UPC audit search.

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

_Last updated: 2026-08-19_
