/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Loop Returns integration (Loop -> NetSuite).
 *
 * This is a STANDALONE Map/Reduce script — unlike customers/products/locations/inventory/
 * orders, it is NOT dispatched through loop_mr_integration.js. It runs in REVERSE: it pulls
 * closed returns from Loop and creates the matching NetSuite records that automate Brian's
 * manual refund / exchange process.
 *
 * Two flows, keyed off the return's top-level `outcome`:
 *
 *   outcome = "refund"   -> Delete deposit application, create a Customer Refund against
 *                           the customer deposit (auto-triggers the Braintree refund),
 *                           create a Credit Memo against the invoice, then re-apply the
 *                           deposit's remaining balance to the invoice.
 *                           GameBibs refunds the returned item(s) and their tax ONLY —
 *                           never shipping or shipping tax. So the Customer Refund is capped
 *                           to sum(line refund_item + refund_tax) and the Credit Memo's
 *                           inherited shipping cost is zeroed. Because the original deposit
 *                           also covered shipping, refunding only item+tax leaves a shipping
 *                           remainder on both the deposit and the invoice; step 4 re-applies
 *                           the leftover deposit to the invoice so both close to $0 (a no-op
 *                           when there was no shipping).
 *
 *   outcome = "exchange" -> Even-money swap. The original payment is left untouched (no deposit
 *                           delete, no cash refund). Credit Memo the returned item as an OPEN
 *                           credit, create + ship a new Sales Order for the replacement (NetSuite
 *                           sources its price + tax), bill it to a new Invoice, then apply the
 *                           credit memo to that invoice so the swap nets to $0.
 *
 * Only state = "closed" returns are processed; everything else is skipped.
 *
 * Idempotency: Loop cannot be acknowledged, so every record we create is tagged with the
 * Loop return id in custbody_loop_return_id. Each run first checks whether a tagged
 * transaction already exists and skips the return if so.
 */
define(['N/runtime', 'N/search', 'N/record', 'N/https', 'N/log'], function (runtime, search, record, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    var RETURN_ID_FIELD = 'custbody_loop_return_id';

    // ---------------------------------------------------------------------------
    // DEBUG: verbose, step-by-step audit logging.
    // Flip to false for go-live (leaves the permanent "X Created" / error logs intact).
    // Can later be promoted to a deployment param if you want to toggle without redeploy.
    // ---------------------------------------------------------------------------
    var DEBUG = true;

    function dbg(title, details) {
        if (DEBUG) log.audit({ title: '[DBG] ' + title, details: details });
    }

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    // Convert a dollar value to integer cents (kept for parity with the other modules).
    function toCents(val) {
        return Math.round((parseFloat(val) || 0) * 100);
    }

    function money(val) {
        return { amount: toCents(val), currency_code: 'USD' };
    }

    // Round a dollar value to 2 decimals (avoids float drift when summing line amounts).
    function round2(val) {
        return Math.round(((parseFloat(val) || 0) + Number.EPSILON) * 100) / 100;
    }

    // The dollar amount GameBibs actually refunds: the returned item(s) plus their tax,
    // explicitly EXCLUDING shipping and shipping tax. Loop already isolates these per line
    // as refund_item (item) and refund_tax (item tax); refund_shipping / refund_shipping_tax
    // are deliberately left out. Falls back to return_total (also shipping-exclusive) if the
    // per-line fields are absent, then to 0 (caller treats 0 as "can't determine").
    function itemPlusTaxRefund(ret) {
        var total = 0;
        var sawLineFields = false;
        (ret.line_items || []).forEach(function (li) {
            if (li.refund_item != null || li.refund_tax != null) sawLineFields = true;
            total += (parseFloat(li.refund_item) || 0) + (parseFloat(li.refund_tax) || 0);
        });
        if (sawLineFields) return round2(total);
        return round2(ret.return_total);
    }

    // Format a JS Date as 'YYYY-MM-DD HH:MM:SS' (UTC) for Loop's time-bracket query params.
    function toLoopDateTime(d) {
        function p(n) { return n < 10 ? '0' + n : String(n); }
        return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
               ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
    }

    // ---------------------------------------------------------------------------
    // Lookups (header-only transaction searches, mirroring loop_orders.js patterns)
    // ---------------------------------------------------------------------------

    // Generic: return internal ids of transactions of `type` whose `field` equals `value`.
    function findTransactionIds(type, field, value) {
        var ids = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', type],
                'AND',
                ['mainline', 'is', 'T'],
                'AND',
                [field, 'anyof', value]
            ],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function (r) {
            ids.push(r.getValue('internalid'));
            return true;
        });
        dbg('findTransactionIds', type + ' where ' + field + '=' + value + ' -> [' + ids.join(',') + ']');
        return ids;
    }

    // True if any transaction is already tagged with this Loop return id (idempotency guard).
    function findExistingReturnTxn(returnId) {
        var found = false;
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [RETURN_ID_FIELD, 'is', String(returnId)]
            ],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function () {
            found = true;
            return false;
        });
        dbg('findExistingReturnTxn', RETURN_ID_FIELD + '=' + returnId + ' -> ' + (found ? 'EXISTS (will skip)' : 'none'));
        return found;
    }

    // Locate the NetSuite Sales Order for a Loop return.
    // Primary match: custbody_loop_order_id == return.order_id (the Loop order id written
    // back during the orders push). Fallback: tranid == return.order_name.
    function findSalesOrder(ret) {
        var soId = null;
        var matchedBy = 'none';

        if (ret.order_id) {
            search.create({
                type: search.Type.SALES_ORDER,
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['custbody_loop_order_id', 'is', String(ret.order_id)]
                ],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each(function (r) { soId = r.getValue('internalid'); return false; });
            if (soId) matchedBy = 'custbody_loop_order_id=' + ret.order_id;
        }

        if (!soId && ret.order_name) {
            search.create({
                type: search.Type.SALES_ORDER,
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['tranid', 'is', ret.order_name]
                ],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each(function (r) { soId = r.getValue('internalid'); return false; });
            if (soId) matchedBy = 'tranid=' + ret.order_name;
        }

        dbg('findSalesOrder', 'order_id=' + ret.order_id + ' order_name=' + ret.order_name +
            ' -> SO ' + (soId || 'NOT FOUND') + ' (' + matchedBy + ')');
        return soId;
    }

    function findInvoiceId(soId) {
        return findTransactionIds('CustInvc', 'createdfrom', soId)[0] || null;
    }

    function findCustomerDepositId(soId) {
        return findTransactionIds('CustDep', 'createdfrom', soId)[0] || null;
    }

    // Map a Loop variant id to a NetSuite inventory item via custitem_loop_product_variant_id.
    function mapVariantToItem(loopVariantId) {
        var itemId = null;
        search.create({
            type: search.Type.ITEM,
            filters: [['custitem_loop_product_variant_id', 'is', String(loopVariantId)]],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function (r) { itemId = r.getValue('internalid'); return false; });
        dbg('mapVariantToItem', 'loopVariant=' + loopVariantId + ' -> item ' + (itemId || 'NOT FOUND'));
        return itemId;
    }

    // Set of NetSuite item ids being returned, resolved from the return's line items.
    function returnedItemIdSet(ret) {
        var set = {};
        (ret.line_items || []).forEach(function (li) {
            var itemId = li.variant_id ? mapVariantToItem(li.variant_id) : null;
            if (itemId) set[String(itemId)] = true;
        });
        return set;
    }

    // ---------------------------------------------------------------------------
    // Record operations
    // ---------------------------------------------------------------------------

    // Delete every Deposit Application tied to this SO's customer deposit(s).
    // No-op (and safe to re-run) if none remain — supports partial-failure recovery.
    function deleteDepositApplications(soId) {
        var deleted = 0;
        var deposits = findTransactionIds('CustDep', 'createdfrom', soId);
        dbg('deleteDepositApplications', 'SO ' + soId + ' -> deposits: [' + deposits.join(',') + ']');
        deposits.forEach(function (depId) {
            findTransactionIds('DepAppl', 'createdfrom', depId).forEach(function (appId) {
                try {
                    record.delete({ type: record.Type.DEPOSIT_APPLICATION, id: appId });
                    deleted++;
                    dbg('deleteDepositApplications', 'Deleted DepAppl ' + appId + ' (from deposit ' + depId + ')');
                } catch (e) {
                    log.error({ title: 'Delete Deposit Application Failed [' + appId + ']', details: e.message });
                }
            });
        });
        dbg('deleteDepositApplications', 'SO ' + soId + ' -> deleted ' + deleted + ' application(s)');
        return deleted;
    }

    // Customer Refund transformed from the Customer Deposit — saving this is what triggers
    // the Braintree refund. Tagged with the return id so it is the first idempotency anchor.
    function createCustomerRefund(ret, soId) {
        var depositId = findCustomerDepositId(soId);
        dbg('createCustomerRefund', 'SO ' + soId + ' -> customer deposit ' + (depositId || 'NOT FOUND'));
        if (!depositId) throw new Error('No Customer Deposit found for SO ' + soId);

        // Transformed from the original Braintree-paid deposit, so the refund inherits the
        // payment method / gateway — saving it is what fires the external Braintree refund.
        var refund = record.transform({
            fromType: record.Type.CUSTOMER_DEPOSIT,
            fromId:   depositId,
            toType:   record.Type.CUSTOMER_REFUND,
            isDynamic: false
        });
        dbg('createCustomerRefund', 'Transformed deposit ' + depositId + ' -> refund; total=' + refund.getValue('total'));

        // Cap the refund to the returned item(s) + their tax (never shipping / shipping tax).
        // The deposit covers the FULL original order (item + tax + shipping), so refunding the
        // untouched transform would send shipping back too. Distribute the target across the
        // refund's Deposits-Applied sublist, capping each line at its available amount.
        var target = itemPlusTaxRefund(ret);
        if (target > 0) {
            var lineCount = refund.getLineCount({ sublistId: 'deposit' });
            var remaining = target;
            for (var i = 0; i < lineCount; i++) {
                var avail = parseFloat(refund.getSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i })) || 0;
                var apply = round2(Math.min(avail, Math.max(remaining, 0)));
                refund.setSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i, value: apply });
                remaining = round2(remaining - apply);
            }
            var applied = round2(target - remaining);
            dbg('createCustomerRefund', 'Capped refund to item+tax: target=' + target + ' applied=' + applied +
                ' across ' + lineCount + ' deposit line(s); unfundable remainder=' + remaining);
            if (remaining > 0) {
                log.error({
                    title:   'Customer Refund Short [Return ' + ret.id + ']',
                    details: 'Wanted to refund ' + target + ' (item+tax) but deposit(s) only covered ' + applied +
                             '. Check the Customer Deposit balance on SO ' + soId + '.'
                });
            }
        } else {
            dbg('createCustomerRefund', 'Could not determine item+tax amount from return — refunding full deposit (unchanged behavior)');
        }

        // Sandbox can't process the real Braintree refund (no live charge behind the deposit),
        // so issue it as Cash to bypass payment-card processing. Production keeps the gateway
        // method inherited from the deposit so the actual Braintree refund fires.
        if (runtime.envType == runtime.EnvType.SANDBOX) {
            // paymentoption is a select (Payment Method) — resolve "Cash" by display name.
            refund.setText({ fieldId: 'paymentoption', text: 'Cash' });
            dbg('createCustomerRefund', 'Sandbox env detected — set paymentoption=Cash to bypass gateway');
        }

        refund.setValue({ fieldId: RETURN_ID_FIELD, value: String(ret.id) });

        var refundId = refund.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Customer Refund Created [' + refundId + ']', details: 'Return ' + ret.id + ' | SO ' + soId });
        return refundId;
    }

    // Credit Memo transformed from the invoice, restricted to the returned line(s), shipping
    // excluded. Two apply behaviors:
    //   leaveUnapplied=false (refund): the deposit-application delete reopened the invoice, so
    //       apply the reduced item+tax credit to it.
    //   leaveUnapplied=true (exchange): leave it as an OPEN credit — the original invoice is still
    //       paid and untouched — to be applied to the new exchange invoice instead.
    function createCreditMemo(ret, soId, leaveUnapplied) {
        var invoiceId = findInvoiceId(soId);
        dbg('createCreditMemo', 'SO ' + soId + ' -> invoice ' + (invoiceId || 'NOT FOUND'));
        if (!invoiceId) throw new Error('No Invoice found for SO ' + soId);

        var cm = record.transform({
            fromType: record.Type.INVOICE,
            fromId:   invoiceId,
            toType:   record.Type.CREDIT_MEMO,
            isDynamic: false
        });
        dbg('createCreditMemo', 'Transformed invoice ' + invoiceId + ' -> credit memo; lines=' + cm.getLineCount({ sublistId: 'item' }));

        // Remove lines that were not part of this return (partial-return support).
        // If we can't resolve any returned items, fall back to crediting the full invoice.
        var returnedItems = returnedItemIdSet(ret);
        var removed = 0;
        if (Object.keys(returnedItems).length) {
            var lineCount = cm.getLineCount({ sublistId: 'item' });
            for (var i = lineCount - 1; i >= 0; i--) {
                var lineItem = String(cm.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                if (!returnedItems[lineItem]) {
                    cm.removeLine({ sublistId: 'item', line: i });
                    removed++;
                }
            }
            dbg('createCreditMemo', 'returnedItems=[' + Object.keys(returnedItems).join(',') + '] | removed ' + removed + ' non-returned line(s); remaining=' + cm.getLineCount({ sublistId: 'item' }));
        } else {
            dbg('createCreditMemo', 'No returned items resolved — crediting full invoice (all lines kept)');
        }

        // GameBibs credits the returned item(s) + their tax only — never shipping. The
        // invoice->CM transform carries the original shipping cost, so zero it; NetSuite
        // derives shipping tax from shippingcost, so this drops the shipping tax as well.
        var priorShip = parseFloat(cm.getValue({ fieldId: 'shippingcost' })) || 0;
        if (priorShip) {
            cm.setValue({ fieldId: 'shippingcost', value: 0 });
            dbg('createCreditMemo', 'Zeroed inherited shippingcost (' + priorShip + ') — crediting item + item tax only');
        }

        // The invoice->CM transform auto-applied the FULL invoice amount (shipping included) on
        // the apply sublist. Zeroing shipping lowered the credit total, so that stale apply
        // amount now exceeds the credit ("You cannot apply more than your total credit"). Re-point
        // the applied line(s) at the reduced item+tax total so the CM applies cleanly.
        var creditTotal = itemPlusTaxRefund(ret);
        var applyCount  = cm.getLineCount({ sublistId: 'apply' });
        for (var a = 0; a < applyCount; a++) {
            var isApplied = cm.getSublistValue({ sublistId: 'apply', fieldId: 'apply', line: a });
            if (isApplied !== true && isApplied !== 'T') continue;

            if (leaveUnapplied) {
                // Exchange: keep the credit OPEN. The original invoice is already paid and stays
                // that way; this credit gets applied to the NEW exchange invoice instead.
                cm.setSublistValue({ sublistId: 'apply', fieldId: 'apply', line: a, value: false });
                dbg('createCreditMemo', 'Left apply line ' + a + ' unapplied — open credit for exchange netting');
            } else {
                // Refund: the invoice was reopened by the deposit-application delete, so apply the
                // reduced item+tax credit (the stale transform amount still includes shipping).
                cm.setSublistValue({ sublistId: 'apply', fieldId: 'amount', line: a, value: creditTotal });
                dbg('createCreditMemo', 'Re-pointed apply line ' + a + ' amount -> ' + creditTotal + ' (was crediting full invoice incl. shipping)');
            }
        }

        cm.setValue({ fieldId: RETURN_ID_FIELD, value: String(ret.id) });

        var cmId = cm.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Credit Memo Created [' + cmId + ']', details: 'Return ' + ret.id + ' | SO ' + soId });
        return cmId;
    }

    // After a partial refund, the Customer Deposit still holds the shipping slice we did NOT
    // refund, and the Invoice is still open for that same amount (the Credit Memo only covered
    // item + item tax). Re-apply the deposit's remaining balance to the invoice so both close
    // out. This is a no-op when nothing remains — e.g. a free-shipping order whose entire
    // deposit was already refunded — so it is safe to always run.
    //
    // Ordering matters: this must run AFTER createCreditMemo, so the invoice's open balance is
    // already reduced to the shipping remainder before we apply the deposit against it.
    function reapplyRemainingDeposit(ret, soId) {
        var depositId = findCustomerDepositId(soId);
        var invoiceId = findInvoiceId(soId);
        dbg('reapplyRemainingDeposit', 'SO ' + soId + ' -> deposit ' + (depositId || 'NONE') + ' | invoice ' + (invoiceId || 'NONE'));
        if (!depositId || !invoiceId) {
            log.audit({ title: 'Deposit Re-application Skipped [Return ' + ret.id + ']', details: 'Missing deposit or invoice for SO ' + soId });
            return null;
        }

        // Dynamic mode so NetSuite auto-fills each apply line's amount = min(invoice due,
        // deposit available) the moment we check it.
        var depApp = record.transform({
            fromType:  record.Type.CUSTOMER_DEPOSIT,
            fromId:    depositId,
            toType:    record.Type.DEPOSIT_APPLICATION,
            isDynamic: true
        });

        var lineCount = depApp.getLineCount({ sublistId: 'apply' });
        var applied   = 0;
        var matched   = false;

        for (var i = 0; i < lineCount; i++) {
            depApp.selectLine({ sublistId: 'apply', line: i });
            var lineTxn = String(depApp.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'internalid' }));
            if (lineTxn === String(invoiceId)) {
                depApp.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
                applied = parseFloat(depApp.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount' })) || 0;
                depApp.commitLine({ sublistId: 'apply' });
                matched = true;
                dbg('reapplyRemainingDeposit', 'Matched invoice ' + invoiceId + ' on apply line ' + i + '; amount=' + applied);
            } else if (depApp.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply' })) {
                // Never let the leftover deposit auto-apply to some other open invoice.
                depApp.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: false });
                depApp.commitLine({ sublistId: 'apply' });
            }
        }

        if (!matched) {
            log.audit({ title: 'Deposit Re-application — Invoice Not Applicable [Return ' + ret.id + ']', details: 'Invoice ' + invoiceId + ' not in deposit ' + depositId + ' apply list (already settled?)' });
            return null;
        }
        if (applied <= 0) {
            dbg('reapplyRemainingDeposit', 'Remaining deposit balance is $0 — nothing to re-apply (no shipping remainder). Skipping save.');
            return null;
        }

        var depAppId = depApp.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Remaining Deposit Re-applied [' + depAppId + ']', details: 'Return ' + ret.id + ' | applied $' + applied + ' of deposit ' + depositId + ' to invoice ' + invoiceId });
        return depAppId;
    }

    // New Sales Order for the exchange item(s), on the same customer as the original SO.
    function createExchangeSalesOrder(ret, soId) {
        var origSo = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
        var entity = origSo.getValue('entity');
        dbg('createExchangeSalesOrder', 'orig SO ' + soId + ' entity=' + entity + ' | exchanges=' + (ret.exchanges || []).length);

        var so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
        so.setValue({ fieldId: 'entity', value: entity });
        // Pending Fulfillment — skip approval routing so we can ship + bill the swap immediately.
        so.setValue({ fieldId: 'orderstatus', value: 'B' });
        so.setValue({ fieldId: RETURN_ID_FIELD, value: String(ret.id) });

        var added = 0;
        (ret.exchanges || []).forEach(function (ex) {
            var itemId = mapVariantToItem(ex.variant_id);
            if (!itemId) {
                log.error({ title: 'Exchange Item Unmapped', details: 'Return ' + ret.id + ' | Loop variant ' + ex.variant_id + ' has no NS item' });
                return;
            }
            so.selectNewLine({ sublistId: 'item' });
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            // Price from Loop, not NetSuite's default: the item's base/price-level rate can differ
            // from what the customer actually paid, which would leave the new invoice out of sync
            // with the credit memo. Force a custom price (level -1) at Loop's exchange price so the
            // even swap nets to $0.
            var exPrice = parseFloat(ex.price) || 0;
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'price', value: -1 }); // -1 = Custom price level
            so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: exPrice });
            so.commitLine({ sublistId: 'item' });
            added++;
            dbg('createExchangeSalesOrder', 'Added exchange line: item ' + itemId + ' (loopVariant ' + ex.variant_id + ') qty 1 @ ' + exPrice + ' (Loop exchange price)');
        });

        if (!added) throw new Error('No exchange lines could be added for return ' + ret.id);

        // Free reship — the customer already paid shipping on the original order. Override the
        // shipping cost NetSuite defaults from the ship method ($1) to $0, so the exchange stays
        // an even item+tax swap and nets to $0.
        so.setValue({ fieldId: 'shippingcost', value: 0 });

        var newSoId = so.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Exchange Sales Order Created [' + newSoId + ']', details: 'Return ' + ret.id + ' | from SO ' + soId });
        return newSoId;
    }

    // Item Fulfillment for the exchange SO (ships the replacement).
    function createItemFulfillment(newSoId) {
        var ff = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId:   newSoId,
            toType:   record.Type.ITEM_FULFILLMENT,
            isDynamic: false
        });
        ff.setValue({ fieldId: 'shipstatus', value: 'C' }); // C = Shipped
        var ffId = ff.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Exchange Item Fulfillment Created [' + ffId + ']', details: 'SO ' + newSoId });
        return ffId;
    }

    // Bill the exchange Sales Order to a new Invoice (item + tax; NetSuite sourced the price).
    function billExchangeSalesOrder(ret, newSoId) {
        var inv = record.transform({
            fromType:  record.Type.SALES_ORDER,
            fromId:    newSoId,
            toType:    record.Type.INVOICE,
            isDynamic: false
        });
        // Belt-and-suspenders: the SO already zeroed shipping, but make sure no default shipping
        // cost sneaks onto the billed invoice and unbalances the netting.
        inv.setValue({ fieldId: 'shippingcost', value: 0 });
        inv.setValue({ fieldId: RETURN_ID_FIELD, value: String(ret.id) });
        var invId = inv.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Exchange Invoice Created [' + invId + ']', details: 'Return ' + ret.id + ' | from exchange SO ' + newSoId });
        return invId;
    }

    // Apply the open exchange Credit Memo to the new exchange Invoice, netting the swap to $0.
    // For an even-money swap the credit (returned item + tax) equals the new invoice (replacement
    // item + tax), so this closes the invoice and fully consumes the credit.
    function applyCreditToInvoice(ret, cmId, invoiceId) {
        if (!cmId || !invoiceId) {
            log.audit({ title: 'Exchange Netting Skipped [Return ' + ret.id + ']', details: 'Missing credit memo or invoice' });
            return null;
        }

        // Dynamic mode so checking an apply line auto-fills amount = min(credit remaining, due).
        var cm = record.load({ type: record.Type.CREDIT_MEMO, id: cmId, isDynamic: true });
        var lineCount = cm.getLineCount({ sublistId: 'apply' });
        var applied   = 0;
        var matched   = false;

        for (var i = 0; i < lineCount; i++) {
            cm.selectLine({ sublistId: 'apply', line: i });
            var lineTxn = String(cm.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'internalid' }));
            if (lineTxn === String(invoiceId)) {
                cm.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
                applied = parseFloat(cm.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount' })) || 0;
                cm.commitLine({ sublistId: 'apply' });
                matched = true;
                dbg('applyCreditToInvoice', 'Applied credit memo ' + cmId + ' -> invoice ' + invoiceId + '; amount=' + applied);
            }
        }

        if (!matched) {
            log.error({ title: 'Exchange Netting — Invoice Not Applicable [Return ' + ret.id + ']', details: 'Invoice ' + invoiceId + ' not in credit memo ' + cmId + ' apply list' });
            return null;
        }

        cm.save({ ignoreMandatoryFields: true });
        log.audit({ title: 'Exchange Netted [Return ' + ret.id + ']', details: 'Applied $' + applied + ' of credit ' + cmId + ' to invoice ' + invoiceId });
        return applied;
    }

    // ---------------------------------------------------------------------------
    // Flows
    // ---------------------------------------------------------------------------

    function processRefund(ret, soId) {
        dbg('processRefund', 'START return ' + ret.id + ' | SO ' + soId);
        dbg('processRefund', 'Step 1/4 — delete deposit application(s)');
        deleteDepositApplications(soId);
        dbg('processRefund', 'Step 2/4 — create Customer Refund (item + tax only)');
        createCustomerRefund(ret, soId); // first tagged record — re-runs skip from here on
        dbg('processRefund', 'Step 3/4 — create Credit Memo (item + tax, shipping excluded)');
        createCreditMemo(ret, soId);
        dbg('processRefund', 'Step 4/4 — re-apply remaining deposit (shipping) to invoice');
        reapplyRemainingDeposit(ret, soId);
        dbg('processRefund', 'DONE return ' + ret.id);
    }

    function processExchange(ret, soId) {
        dbg('processExchange', 'START return ' + ret.id + ' | SO ' + soId);

        // Even-money swap: the customer's original payment stays put — no deposit delete, no cash
        // refund. Credit the returned item as an OPEN credit, sell + ship the replacement on a new
        // order (NetSuite sources its price + tax), bill it, and net that invoice to $0 with the
        // credit. An even swap cancels out.
        dbg('processExchange', 'Step 1/5 — create Credit Memo for returned item(s) (open credit)');
        var cmId = createCreditMemo(ret, soId, true); // first tagged record — re-runs skip from here on
        dbg('processExchange', 'Step 2/5 — create exchange Sales Order (NetSuite sources price + tax)');
        var newSoId = createExchangeSalesOrder(ret, soId);
        dbg('processExchange', 'Step 3/5 — ship the replacement (Item Fulfillment)');
        createItemFulfillment(newSoId);
        dbg('processExchange', 'Step 4/5 — bill the exchange SO to a new Invoice');
        var newInvId = billExchangeSalesOrder(ret, newSoId);
        dbg('processExchange', 'Step 5/5 — apply credit memo ' + cmId + ' to invoice ' + newInvId + ' (net to $0)');
        applyCreditToInvoice(ret, cmId, newInvId);
        dbg('processExchange', 'DONE return ' + ret.id);
    }

    // ---------------------------------------------------------------------------
    // Map/Reduce entry points
    // ---------------------------------------------------------------------------

    function getInputData() {
        var script   = runtime.getCurrentScript();
        var lookback = parseInt(script.getParameter({ name: 'custscript_loop_returns_lookback' }), 10) || 1440; // minutes, default 1 day
        var to       = new Date();
        var from     = new Date(to.getTime() - lookback * 60 * 60 * 1000);

        // Loop "Detailed Returns List" endpoint — returns a bare array of full return objects
        // within the [from, to] window. Loop requires the literal 'YYYY-MM-DD HH:MM:SS' format
        // with real spaces/colons (NOT percent-encoded).
        // https://docs.loopreturns.com/api-reference/latest/return-data/detailed-returns-list
        var url = LOOP_API_URL + '/warehouse/return/list' +
                  '?from=' + toLoopDateTime(from) +
                  '&to='   + toLoopDateTime(to);

        log.audit({ title: 'Loop Returns Fetch', details: 'Window: ' + toLoopDateTime(from) + ' -> ' + toLoopDateTime(to) });

        var response = https.get({ url: url, headers: buildHeaders() });
        if (response.code != 200) {
            log.error({ title: 'Loop Returns API Error', details: 'HTTP ' + response.code + ' | ' + response.body });
            return [];
        }

        // Loop ids (order_id, variant_id) are 18 digits and exceed JS float64 precision —
        // wrap long integers as strings before parsing, same as loop_orders.js does.
        var safeBody = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
        var parsed   = JSON.parse(safeBody);
        var returns  = Array.isArray(parsed) ? parsed : (parsed.returns || parsed.data || []);

        // TEMP (diagnostics): what did the list call actually return?
        log.audit({
            title:   'Loop Returns Raw',
            details: 'isArray: ' + Array.isArray(parsed) +
                     ' | topKeys: ' + (Array.isArray(parsed) ? 'n/a' : Object.keys(parsed).join(',')) +
                     ' | count: ' + returns.length +
                     ' | ids: ' + returns.map(function (r) { return r.id; }).join(',')
        });

        // TEMP (testing): process only returns against this one order. Remove to handle the
        // full window. Compare as strings — Loop may quote or unquote these values.
        var ONLY_ORDER_NAME = 'SO31057';
        returns = returns.filter(function (r) { return String(r.order_name) == ONLY_ORDER_NAME; });
        dbg('getInputData', 'After single-order filter (' + ONLY_ORDER_NAME + '): ' + returns.length + ' return(s)');

        return returns;
    }

    function map(context) {
        var ret;
        try {
            ret = JSON.parse(context.value);
        } catch (e) {
            log.error({ title: 'Return Parse Failed', details: e.message });
            return;
        }

        var returnId = String(ret.id);

        dbg('map', 'ENTER return ' + returnId + ' | state=' + ret.state + ' | outcome=' + ret.outcome +
            ' | order_id=' + ret.order_id + ' | order_name=' + ret.order_name +
            ' | line_items=' + (ret.line_items || []).length + ' | exchanges=' + (ret.exchanges || []).length);

        try {
            if (ret.state != 'closed') {
                log.audit({ title: 'Return Skipped — Not Closed [' + returnId + ']', details: 'state: ' + ret.state });
                return;
            }
            dbg('map', 'state gate passed (closed)');

            if (findExistingReturnTxn(returnId)) {
                log.audit({ title: 'Return Skipped — Already Processed [' + returnId + ']', details: 'Tagged transaction already exists' });
                return;
            }
            dbg('map', 'idempotency check passed (not yet processed)');

            var soId = findSalesOrder(ret);
            if (!soId) {
                log.error({ title: 'Return Skipped — No SO [' + returnId + ']', details: 'order_id: ' + ret.order_id + ' | order_name: ' + ret.order_name });
                return;
            }
            dbg('map', 'resolved SO ' + soId + ' — routing on outcome "' + ret.outcome + '"');

            if (ret.outcome == 'refund') {
                processRefund(ret, soId);
            } else if (ret.outcome == 'exchange') {
                processExchange(ret, soId);
            } else {
                log.error({ title: 'Return Skipped — Unknown Outcome [' + returnId + ']', details: 'outcome: ' + ret.outcome });
                return;
            }

            dbg('map', 'SUCCESS return ' + returnId + ' (' + ret.outcome + ') on SO ' + soId);
            context.write({ key: returnId, value: JSON.stringify({ status: 'success', returnId: returnId, soId: soId, outcome: ret.outcome }) });

        } catch (e) {
            log.error({ title: 'Return Map Exception [' + returnId + ']', details: e.message });
            context.write({ key: returnId, value: JSON.stringify({ status: 'error', returnId: returnId, message: e.message }) });
        }
    }

    function reduce(context) {
        // Records are created in map(); reduce is a pass-through for the summary stage.
        context.write({ key: context.key, value: context.values[0] });
    }

    function summarize(summary) {
        var successCount = 0;
        var errorCount   = 0;

        summary.output.iterator().each(function (key, value) {
            JSON.parse(value).status == 'success' ? successCount++ : errorCount++;
            return true;
        });

        log.audit({ title: 'Loop Returns Integration Complete', details: 'Success: ' + successCount + ' | Errors: ' + errorCount });

        if (summary.mapSummary.error) {
            log.error({ title: 'Return Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Return Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
