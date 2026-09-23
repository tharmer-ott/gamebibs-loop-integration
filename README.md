# GameBibs ⇄ Loop Returns Integration

NetSuite SuiteScript integration between **GameBibs (NetSuite)** and **Loop Returns**.

- **Outbound (NetSuite → Loop):** customers, products, locations, inventory, and orders are pushed to Loop via a shared Map/Reduce dispatcher (`loop_mr_integration.js`), each kicked off by a Suitelet deployment (`loop_sl_integration.js`).
- **Inbound (Loop → NetSuite):** closed returns are pulled from Loop and turned into NetSuite refund/exchange transactions by a standalone Map/Reduce (`loop_returns.js`). This automates the previously manual refund/exchange bookkeeping.
- **BigCommerce → NetSuite:** `bc_product_images.js` (standalone Map/Reduce) copies product image URLs from the BigCommerce catalog onto NetSuite items, and the products sync sends them to Loop. `bc_order_metadata.js` reads each order's Loop `session_id` from BigCommerce for the orders sync.

See [`loop_api_spec.md`](loop_api_spec.md) for the Loop API reference and GameBibs-specific field mappings.

> ⚠️ **This integration moves real money.** Saving a Customer Refund transforms the original Customer Deposit and *should* **fire the live Braintree refund**, but that behavior is **not yet confirmed** in production. Until it's proven out, treat the returns flow with production-level care and assume it can move money for real.

---

## Recent changes (2026-09-23)

The **returns (inbound)** flow is now **live**, and product images now flow from BigCommerce through NetSuite to Loop.

**Returns** ([`loop_returns.js`](src/FileCabinet/SuiteScripts/Loop/loop_returns.js))
- **Go-live scope.** Removed the `SO31057` single-order filter and the temporary fixed test window. `getInputData` fetches closed returns only (`state=closed`) over a rolling lookback measured in hours (default 7, overridable via `custscript_loop_returns_lookback`). The window is filtered on `updated_at`, so a return is picked up on the run after it closes. `DEBUG` is off.
- **Credit lines follow the return's current contents.** Credit memo lines come from `ret.presentment.line_items`, so a line removed in Loop isn't credited or restocked.
- **Return handling fee.** When the customer doesn't pay for Checkout+, the return handling fee is applied to the credit memo (Alex Romo, `2e81d84`). The credit memo matches Loop's net refund to the penny. Loop already nets the fee into each line's `refund_item`/`refund_tax`, so the item side is reduced by a Return Handling Fee line and the tax is set to the sum of `refund_tax`.
- **$0 guard.** If the item + tax refund comes to $0 or less, the return errors out instead of refunding the full deposit.

**Orders** ([`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js))
- **Go-live scope.** Only fully fulfilled orders (`SalesOrd:F`/`G`) sync, once each; partially fulfilled orders wait until they're complete. The `7/31/2026` `trandate` floor applies in production only. The test toggle is now a list, `TEST_ORDER_TRANIDS` (default `null`). When it's set, it bypasses the status/entity/date filters so specific orders can be force-(re)synced.
- **Per-line tax matches NetSuite.** Each line is taxed at rate × extended amount, and the Return Coverage charge carries its own tax on its fee entry. Loop's per-line tax now matches the invoice and credit memo.
- **BigCommerce session + Return Coverage.** Each order's BigCommerce `session_id` is attached as line-item metadata. It's read by `bc_order_metadata.js` from the order's `loop`/`session_id` metafield, using the BC order ID in `custbody_fa_channel_order`. Return Coverage ("Order protection") is sent as a `fees[]` entry.

**Products & images**
- **BigCommerce image backfill.** New standalone Map/Reduce [`bc_product_images.js`](src/FileCabinet/SuiteScripts/Loop/bc_product_images.js) reads the BigCommerce catalog and writes each product's main image (`is_thumbnail`, `url_standard` 386×513) to `custitem_bc_image_url` on the matching NetSuite item by SKU. Parent items match BC product SKUs; child items match BC variant SKUs and get their product's image. Authenticates with the API Secret `custsecret_bc_catalog_token` (a BC token with Products read-only). `TEST_SKUS` limits a run to specific SKUs.
- **Images sent to Loop.** [`loop_products.js`](src/FileCabinet/SuiteScripts/Loop/loop_products.js) sends `custitem_bc_image_url` as the product's and each variant's image.
- **`FULL_RESYNC` toggle** (default `false`). Re-sends every active group. Existing Loop variants are replaced by their Loop ID (`PUT /products/{id}/product-variants/{variantId}`) with the full NetSuite payload, because Loop's variant update blanks any field left out of the body. Normal runs stay create-only for variants.

---

## Earlier changes (2026-08-19)

The outbound flows — **orders, products, and inventory** — were taken to production this round. Highlights:

- **Orders go-live scope.** Removed the `SO31015` test filter. Orders now sync on a permanent `trandate onorafter 7/31/2026` floor, restricted to the BigCommerce bucket customer (entity 1020), fulfilled/billed statuses (`SalesOrd:D/E/F/G`), and not-yet-uploaded. A `TEST_ORDER_TRANID` toggle (default `null`) supports single-order sanity checks.
- **Environment-safe fulfillment location.** The previously hardcoded Loop location ID is now resolved from `runtime.envType` in both [`loop_orders.js`](src/FileCabinet/SuiteScripts/Loop/loop_orders.js) and [`loop_inventory.js`](src/FileCabinet/SuiteScripts/Loop/loop_inventory.js) (sandbox vs production), closing a latent sandbox/prod mismatch.
- **Inventory single-location rewrite.** Dropped the per-location row expansion (which returned a blank location on a single-location account and skipped every row) and the location-record lookup; inventory now pushes the available count straight to the one Loop location. *(Follow-up:)* the search is now filtered to `inventorylocation = 1` (PFC Fulfillment). Once a second location ("Sample sold onsite") existed, each item returned one row per location, and those rows raced to PUT the same Loop variant/location, so a 0 could overwrite the real count.
- **Order customer email.** The inline customer upsert now sources the real email from the SO `email` field, falling back to the placeholder only when blank.
- **Products.** `TEST_GROUP_ID` → `TEST_GROUP_IDS` list (default `null` = full catalog); full catalog synced.
- **Objects.** Added missing SDF object defs: `custitem_loop_product_variant_id`, `custbody_loop_return_id`, and the `customscript_loop_returns` Map/Reduce.

---

## 1. Major Concerns / Things That Could Go Wrong

> Ranked roughly by blast radius. Anything marked 🔴 must be resolved before go-live.

### 🟡 Cleanup utility scoped to a test parent
All sync test scopes are cleared. `loop_returns.js` no longer filters to a single order, `loop_orders.js` uses `TEST_ORDER_TRANIDS` (default `null`), and `loop_products.js` uses `TEST_GROUP_IDS` (default `null`) with `FULL_RESYNC` off. [`loop_products_delete.js`](src/FileCabinet/SuiteScripts/Loop/loop_products_delete.js) still carries `TEST_PARENT_ID = 846`. It's a manual cleanup utility, so scope it deliberately before each run.

### 🟡 Unfilled deploy placeholder
`loop_sl_integration.js` has `MR_PRIMARY_KEY = 'TODO'` — until filled with the MR script record's internal ID, the Suitelet can't redirect to the Map/Reduce status page (it falls back to a plain text confirmation).

### 🟡 Diagnostics log still on
`DEBUG` is now `false` in `loop_returns.js`. One `TEMP (diagnostics)` audit log ("Loop Returns Raw" in `getInputData`) remains and writes one entry per run.

---

## 2. TODO

### Before go-live 🔴
- [x] Remove the `SO31015` test filter from `loop_orders.js`. *(done — replaced with the `7/31/2026` date floor + `TEST_ORDER_TRANIDS` toggle)*
- [x] Remove the `ONLY_ORDER_NAME = 'SO31057'` test filter from `loop_returns.js` (returns only). *(done — returns now fetch closed returns over a rolling `updated_at` window)*
- [ ] Confirm / update backlog update window. *(returns lookback in `loop_returns.js`; the param is labeled minutes but computed as hours — reconcile the unit before tuning. The code now treats it as hours, default 7, filtered on `updated_at`.)*
- [ ] Fill in `MR_PRIMARY_KEY` in `loop_sl_integration.js`.
- [ ] Set `DEBUG = false` in `loop_returns.js` and remove `TEMP (diagnostics)` logs. *(`DEBUG` is `false`; one `TEMP (diagnostics)` log remains)*
- [ ] Verify the refund flow against a **live Braintree sandbox → production** dry run with a known order.

### Hardening 🟠
- [ ] Make refund flow resumable after partial failure (per-step tagging or rollback).
- [ ] Replace random tax reconciliation with deterministic allocation + loud logging on large diffs. *(per-line tax now matches NetSuite; the random one-cent spread remains as the fallback for diffs over 2 cents)*
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

_Last updated: 2026-09-23_
