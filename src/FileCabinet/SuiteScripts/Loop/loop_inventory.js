/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/search', 'N/https', 'N/log', 'N/runtime'], function (search, https, log, runtime) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    // GameBibs has a single fulfillment location, but its Loop ID differs by environment,
    // so resolve it from envType rather than hardcoding one value (mirrors loop_orders.js).
    var LOOP_LOCATION_ID = runtime.envType === runtime.EnvType.SANDBOX
        ? '894555345163870208'   // sandbox Loop location
        : '929970130160201728';  // production Loop location

    // NetSuite internal ID of the PFC Fulfillment location — the only location whose stock
    // is sold through Loop. Other locations (e.g. "Sample sold onsite") are excluded.
    var NS_FULFILLMENT_LOCATION_ID = '1';

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function getInputData() {
        // One row per synced variant. locationquantityavailable expands into one row per
        // item per location, so the inventorylocation filter pins it to PFC Fulfillment only.
        // Without it, every other location's row also PUTs to the same Loop variant/location
        // and whichever map call finishes last wins (e.g. a 0 from "Sample sold onsite").
        return search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'noneof', '@NONE@'],
                'AND',
                ['custitem_loop_product_variant_id', 'isnotempty', ''],
                'AND',
                ['inventorylocation', 'anyof', NS_FULFILLMENT_LOCATION_ID],
                'AND',
                ['locationquantityavailable', 'greaterthanorequalto', '0']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'custitem_loop_product_variant_id' }),
                search.createColumn({ name: 'locationquantityavailable' })
            ]
        });
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var values = result.values;

        var internalId    = result.id;
        var sku           = values.itemid;
        var loopVariantId = values.custitem_loop_product_variant_id;
        var availableQty  = parseInt(values.locationquantityavailable, 10) || 0;

        log.audit({
            title:   'Inventory Map [' + internalId + ']',
            details: 'SKU: ' + sku + ' | Qty: ' + availableQty
        });

        var payload = JSON.stringify({ available_count: availableQty });

        try {
            // PUT upserts inventory by the variant/location path — works for both create and update.
            // Single location: LOOP_LOCATION_ID resolves by environment.
            var response = https.put({
                url:     LOOP_API_URL + '/inventories/' + loopVariantId + '/' + LOOP_LOCATION_ID,
                headers: buildHeaders(),
                body:    payload
            });

            if (response.code === 200 || response.code === 201) {
                log.audit({
                    title:   'Inventory Updated [' + internalId + ']',
                    details: 'SKU: ' + sku + ' | Qty: ' + availableQty + ' | Variant ID: ' + loopVariantId
                });
                context.write({
                    key:   String(internalId),
                    value: JSON.stringify({ status: 'success', qty: availableQty })
                });
            } else {
                log.error({
                    title:   'Loop Inventory API Error',
                    details: 'Item ' + internalId + ' | HTTP ' + response.code + ' | ' + response.body
                });
                context.write({
                    key:   String(internalId),
                    value: JSON.stringify({ status: 'error', code: response.code })
                });
            }
        } catch (e) {
            log.error({ title: 'Inventory Map Exception [' + internalId + ']', details: e.message });
            context.write({
                key:   String(internalId),
                value: JSON.stringify({ status: 'error', message: e.message })
            });
        }
    }

    function reduce(context) {
        // No NS writeback required — inventory is stateless (always reflects current qty).
        // Reduce is a no-op but must be present for the MR framework.
    }

    function summarize(summary) {
        var successCount = 0;
        var errorCount   = 0;

        summary.output.iterator().each(function (key, value) {
            JSON.parse(value).status === 'success' ? successCount++ : errorCount++;
            return true;
        });

        log.audit({
            title:   'Loop Inventory Integration Complete',
            details: 'Success: ' + successCount + ' | Errors: ' + errorCount
        });

        if (summary.mapSummary.error) {
            log.error({ title: 'Inventory Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Inventory Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
