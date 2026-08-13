/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/search', 'N/https', 'N/log'], function (search, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function getInputData() {
        // Returns one row per item-location combination.
        // NS expands locationquantityavailable into separate rows when the location
        // column is included — exactly what we need to push per-location counts to Loop.
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
                ['locationquantityavailable', 'greaterthanorequalto', '0']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'custitem_loop_product_variant_id' }),
                search.createColumn({ name: 'location' }),
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

        // location column returns [{value: nsLocationId, text: locationName}]
        var locationField  = values.location;
        var nsLocationId   = Array.isArray(locationField) ? locationField[0].value : locationField;
        var nsLocationName = Array.isArray(locationField) ? locationField[0].text  : locationField;

        log.audit({
            title:   'Inventory Map [' + internalId + ']',
            details: 'SKU: ' + sku + ' | Location: ' + nsLocationName + ' | Qty: ' + availableQty
        });

        if (!nsLocationId) {
            log.audit({ title: 'Inventory Skipped [' + internalId + ']', details: 'No location on row — skipping ' + sku });
            return;
        }

        // Look up the Loop location ID stored on the NS location record
        var loopLocationId;
        try {
            var locationFields = search.lookupFields({
                type:    'location',
                id:      nsLocationId,
                columns: ['custrecord_loop_location_id']
            });
            loopLocationId = locationFields.custrecord_loop_location_id;
        } catch (lookupErr) {
            log.error({ title: 'Inventory Location Lookup Failed [' + nsLocationId + ']', details: lookupErr.message });
            return;
        }

        if (!loopLocationId) {
            log.audit({
                title:   'Inventory Skipped — Location Not Synced [' + internalId + ']',
                details: 'NS Location ' + nsLocationId + ' has no Loop ID — run Locations sync first'
            });
            return;
        }

        var payload = JSON.stringify({ available_count: availableQty });

        try {
            // PUT upserts inventory by the variant/location path — works for both create and update
            var response = https.put({
                url:     LOOP_API_URL + '/inventories/' + loopVariantId + '/' + loopLocationId,
                headers: buildHeaders(),
                body:    payload
            });

            if (response.code === 200 || response.code === 201) {
                log.audit({
                    title:   'Inventory Updated [' + internalId + ']',
                    details: 'SKU: ' + sku + ' | Location: ' + nsLocationName + ' | Qty: ' + availableQty + ' | Variant ID: ' + loopVariantId
                });
                context.write({
                    key:   internalId + '_' + nsLocationId,
                    value: JSON.stringify({ status: 'success', qty: availableQty })
                });
            } else {
                log.error({
                    title:   'Loop Inventory API Error',
                    details: 'Item ' + internalId + ' | Location ' + nsLocationId +
                             ' | HTTP ' + response.code + ' | ' + response.body
                });
                context.write({
                    key:   internalId + '_' + nsLocationId,
                    value: JSON.stringify({ status: 'error', code: response.code })
                });
            }
        } catch (e) {
            log.error({ title: 'Inventory Map Exception [' + internalId + ']', details: e.message });
            context.write({
                key:   internalId + '_' + nsLocationId,
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
