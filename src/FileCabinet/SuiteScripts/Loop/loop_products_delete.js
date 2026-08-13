/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 * @NScriptType MapReduceScript
 *
 * Deletes Loop products and their variants, then clears the stored Loop IDs
 * from the corresponding NetSuite item records.
 *
 * Flow:
 *   getInputData() -> parent InvtPart items that have a Loop Product ID set
 *   map()          -> DELETE each child variant from Loop, clear NS fields on children;
 *                     only writes success forward if ALL children deleted cleanly
 *   reduce()       -> DELETE parent product from Loop, clear NS field on parent
 *                     (skipped entirely if any child delete failed in map)
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], function (search, record, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    // Restrict to a single parent item for testing. Set to null to run against all.
    var TEST_PARENT_ID = 846;

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function getInputData() {
        var filters = [
            ['isinactive', 'is', 'F'],
            'AND',
            ['type', 'anyof', 'InvtPart'],
            'AND',
            ['parent', 'anyof', '@NONE@'],
            'AND',
            ['custitem_loop_product_id', 'isnotempty', '']
        ];

        if (TEST_PARENT_ID) {
            log.audit({ title: 'TEST MODE', details: 'Restricting delete to parent item ' + TEST_PARENT_ID });
            filters = filters.concat(['AND', ['internalid', 'anyof', TEST_PARENT_ID]]);
        }

        return search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'custitem_loop_product_id' })
            ]
        });
    }

    function map(context) {
        var result       = JSON.parse(context.value);
        var parentId     = result.id;
        var parentSku    = result.values.itemid;
        var loopProductId = result.values.custitem_loop_product_id;

        log.audit({
            title:   'Delete Map [' + parentId + ']',
            details: 'SKU: ' + parentSku + ' | Loop Product ID: ' + loopProductId
        });

        // Find all children that have a variant ID to delete
        var children = [];
        search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'anyof', parentId],
                'AND',
                ['custitem_loop_product_variant_id', 'isnotempty', '']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'custitem_loop_product_variant_id' })
            ]
        }).run().each(function (child) {
            children.push({
                internalId:    child.getValue('internalid'),
                sku:           child.getValue('itemid'),
                loopVariantId: child.getValue('custitem_loop_product_variant_id')
            });
            return true;
        });

        if (children.length === 0) {
            log.audit({ title: 'Delete Map [' + parentId + ']', details: 'No synced children found — skipping parent delete' });
            context.write({ key: parentId, value: JSON.stringify({ status: 'error', reason: 'no children' }) });
            return;
        }

        var allSucceeded = true;

        children.forEach(function (child) {
            try {
                var variantUrl = LOOP_API_URL + '/products/' + loopProductId + '/product-variants/' + child.loopVariantId;
                log.audit({ title: 'Variant DELETE [' + child.internalId + ']', details: variantUrl });
                var response = https.request({
                    method:  https.Method.DELETE,
                    url:     variantUrl,
                    headers: buildHeaders()
                });

                if (response.code === 200 || response.code === 204) {
                    record.submitFields({
                        type:   record.Type.INVENTORY_ITEM,
                        id:     child.internalId,
                        values: {
                            custitem_loop_product_id:         '',
                            custitem_loop_product_variant_id: ''
                        }
                    });
                    log.audit({
                        title:   'Variant Deleted [' + child.internalId + ']',
                        details: 'SKU: ' + child.sku + ' | Loop Variant ID: ' + child.loopVariantId
                    });
                } else {
                    log.error({
                        title:   'Variant Delete Failed [' + child.internalId + ']',
                        details: 'HTTP ' + response.code + ' | ' + response.body
                    });
                    allSucceeded = false;
                }
            } catch (e) {
                log.error({ title: 'Variant Delete Exception [' + child.internalId + ']', details: e.message });
                allSucceeded = false;
            }
        });

        if (allSucceeded) {
            context.write({
                key:   parentId,
                value: JSON.stringify({ status: 'success', loopProductId: loopProductId })
            });
        } else {
            log.error({
                title:   'Parent Delete Skipped [' + parentId + ']',
                details: 'One or more variant deletes failed — parent product ' + loopProductId + ' will NOT be deleted'
            });
            context.write({
                key:   parentId,
                value: JSON.stringify({ status: 'error', reason: 'variant delete failed' })
            });
        }
    }

    function reduce(context) {
        var parentId = context.key;
        var result   = JSON.parse(context.values[0]);

        if (result.status !== 'success') {
            context.write({ key: parentId, value: JSON.stringify({ status: 'error' }) });
            return;
        }

        var loopProductId = result.loopProductId;

        try {
            var productUrl = LOOP_API_URL + '/products/' + loopProductId;
            log.audit({ title: 'Product DELETE [' + parentId + ']', details: productUrl });
            var response = https.request({
                method:  https.Method.DELETE,
                url:     productUrl,
                headers: buildHeaders()
            });

            if (response.code === 200 || response.code === 204) {
                record.submitFields({
                    type:   record.Type.INVENTORY_ITEM,
                    id:     parentId,
                    values: { custitem_loop_product_id: '' }
                });
                log.audit({
                    title:   'Product Deleted [' + parentId + ']',
                    details: 'Loop Product ID: ' + loopProductId
                });
                context.write({ key: parentId, value: JSON.stringify({ status: 'success' }) });
            } else {
                log.error({
                    title:   'Product Delete Failed [' + parentId + ']',
                    details: 'HTTP ' + response.code + ' | ' + response.body
                });
                context.write({ key: parentId, value: JSON.stringify({ status: 'error', code: response.code }) });
            }
        } catch (e) {
            log.error({ title: 'Product Delete Exception [' + parentId + ']', details: e.message });
            context.write({ key: parentId, value: JSON.stringify({ status: 'error', message: e.message }) });
        }
    }

    function summarize(summary) {
        var successCount = 0;
        var errorCount   = 0;

        summary.output.iterator().each(function (key, value) {
            JSON.parse(value).status === 'success' ? successCount++ : errorCount++;
            return true;
        });

        log.audit({
            title:   'Loop Products Delete Complete',
            details: 'Products deleted: ' + successCount + ' | Skipped/errors: ' + errorCount
        });

        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Delete Map Key Error [' + key + ']', details: err });
            return true;
        });
        summary.reduceSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Delete Reduce Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
