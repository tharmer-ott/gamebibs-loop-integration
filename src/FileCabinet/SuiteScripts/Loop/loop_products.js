/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * Syncs NetSuite Item Groups to Loop as products, and each active member item
 * of the group as a product variant.
 *
 * - Parent Item -> Loop Product            (PUT /products, upsert by external_id)
 * - Member item -> Loop Product Variant    (POST /products/{id}/product-variants)
 *
 * A "group" here is just a regular InvtPart Inventory Item with no parent of
 * its own (parent = @NONE@) -- NOT a NetSuite Group/itemgroup record, and NOT
 * matrix item parenting. Its members are InvtPart items whose standard
 * 'parent' field points back to it, same record type throughout.
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], function (search, record, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    // TEST MODE: limit getInputData to a single Item Group for a small test run.
    // Set to null to process all groups.
    //
    // Currently scoped to GBA-07 (parent internal id 160) to repush that series.
    // TO REVERT: set this back to null before the next full production run.
    var TEST_GROUP_ID = '10';

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function weightToGrams(weight, weightUnit) {
        if (weightUnit === 'lb')      return Math.round(weight * 453.592);
        if (weightUnit === 'oz')      return Math.round(weight * 28.3495);
        if (weightUnit === 'kg')      return Math.round(weight * 1000);
        return weight;
    }

    // Active member items of a group. Ordering isn't guaranteed by NetSuite --
    // the first row is just a stable, deterministic stand-in for a "default
    // variant" since item groups have no explicit primary/default member flag.
    function searchActiveChildren(groupId) {
        var rows = [];
        search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'anyof', groupId]
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'purchasedescription' }),
                search.createColumn({ name: 'salesdescription' }),
                search.createColumn({ name: 'upccode' }),
                search.createColumn({ name: 'baseprice' }),
                search.createColumn({ name: 'weightunit' }),
                search.createColumn({ name: 'weight' }),
                search.createColumn({ name: 'custitem_loop_product_variant_id' })
            ]
        }).run().each(function (result) {
            rows.push({
                internalId:   result.getValue('internalid'),
                sku:          result.getValue('itemid'),
                name:         result.getValue('purchasedescription'),
                description:  result.getValue('salesdescription'),
                barcode:      result.getValue('upccode'),
                price:        parseFloat(result.getValue('baseprice')) || 0,
                weight:       parseFloat(result.getValue('weight')) || 0,
                weightUnit:   result.getValue('weightunit'),
                loopVariantId: result.getValue('custitem_loop_product_variant_id')
            });
            return true;
        });
        return rows;
    }

    function getInputData() {
        if (TEST_GROUP_ID) {
            log.audit({ title: 'TEST MODE', details: 'Restricting run to Item Group ' + TEST_GROUP_ID });
            var testGroup = {};
            testGroup[TEST_GROUP_ID] = true;
            return attachGroupDetails(testGroup);
        }

        var groupIds = {};

        // Groups never synced to Loop. A "group" here is just a regular InvtPart
        // Inventory Item with no parent of its own -- not a NetSuite Group/itemgroup
        // record. Its children are InvtPart items whose 'parent' points back to it.
        search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'anyof', '@NONE@'],
                'AND',
                ['custitem_loop_product_id', 'isempty', '']
            ],
            columns: ['internalid']
        }).run().each(function (result) {
            groupIds[result.id] = true;
            return true;
        });

        // Groups already synced, but with at least one active member item
        // that hasn't been created as a Loop variant yet (e.g. added later).
        search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'noneof', '@NONE@'],
                'AND',
                ['custitem_loop_product_variant_id', 'isempty', '']
            ],
            columns: [
                search.createColumn({ name: 'parent', summary: search.Summary.GROUP })
            ]
        }).run().each(function (result) {
            var parentId = result.getValue({ name: 'parent', summary: search.Summary.GROUP });
            if (parentId) groupIds[parentId] = true;
            return true;
        });

        return attachGroupDetails(groupIds);
    }

    function attachGroupDetails(groupIdMap) {
        var ids = Object.keys(groupIdMap);
        if (ids.length === 0) return [];

        var details = {};
        search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ['type', 'anyof', 'InvtPart'],
                'AND',
                ['parent', 'anyof', '@NONE@'],
                'AND',
                ['internalid', 'anyof', ids]
            ],
            columns: [
                search.createColumn({ name: 'itemid' }),
                search.createColumn({ name: 'displayname' }),
                search.createColumn({ name: 'salesdescription' }),
                search.createColumn({ name: 'baseprice' }),
                search.createColumn({ name: 'upccode' }),
                search.createColumn({ name: 'weightunit' }),
                search.createColumn({ name: 'weight' })
            ]
        }).run().each(function (result) {
            details[result.id] = {
                id:          result.id,
                name:        result.getValue('displayname') || result.getValue('itemid'),
                sku:         result.getValue('itemid'),
                description: result.getValue('salesdescription'),
                price:       parseFloat(result.getValue('baseprice')) || 0,
                barcode:     result.getValue('upccode'),
                weight:      parseFloat(result.getValue('weight')) || 0,
                weightUnit:  result.getValue('weightunit')
            };
            return true;
        });

        return ids.map(function (id) {
            return details[id] || { id: id, name: null, sku: null, description: null, price: 0, barcode: null, weight: 0, weightUnit: null };
        });
    }

    function map(context) {
        var group = JSON.parse(context.value);
        var groupId = group.id;

        // The "group" is a real Inventory Item itself, so its own fields are used
        // directly -- no need to derive sku/price/etc. from a child item.
        var name        = group.name;
        var description = group.description;
        var sku         = group.sku;
        var barcode     = group.barcode;
        var price       = group.price;
        var weight      = group.weight;
        var weightUnit  = group.weightUnit;

        // Fetch every active child once here, and forward the whole list to
        // reduce() so it doesn't need to search for the same rows again.
        var children = searchActiveChildren(groupId);

        log.audit({
            title:   'Group Product Map [' + groupId + ']',
            details: 'Name: ' + name + ' | SKU: ' + sku
        });

        // Loop matches exchange variants to their parent by literal option-value
        // strings, so the parent's values[] must be the actual variant labels (each
        // child's purchase description) -- NOT variant IDs. Build the union of the
        // labels we actually sell for this group as the "Size" option. Using the
        // full description keeps parent and variant strings identical by
        // construction; can be trimmed to a bare size token later if the shopper-
        // facing labels need to read cleaner.
        var sizeValues = [];
        children.forEach(function (child) {
            var label = child.name;
            if (label && sizeValues.indexOf(label) === -1) sizeValues.push(label);
        });

        var productData = {
            external_id:   String(groupId),
            name:          name,
            description:   description,
            sku:           sku,
            barcode:       barcode,
            weight_grams:  weightToGrams(weight, weightUnit),
            sales_channel: 'NetSuite',
            source:        'NetSuite',
            price: {
                amount:        price,
                currency_code: 'USD'
            }
        };
        if (sizeValues.length) {
            productData.options = [{ name: 'Size', position: 1, values: sizeValues }];
        }

        var payload = JSON.stringify(productData);

        log.audit({ title: 'Product Payload [' + groupId + ']', details: payload });

        try {
            // PUT upserts by external_id -- works whether the group was synced before or not.
            var response = https.put({
                url:     LOOP_API_URL + '/products',
                headers: buildHeaders(),
                body:    payload
            });

            if (response.code === 200 || response.code === 201) {
                var safeBody    = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
                var productBody = JSON.parse(safeBody);
                var loopProductId = productBody.product ? String(productBody.product.id) : null;

                try {
                    record.submitFields({
                        type:   record.Type.INVENTORY_ITEM,
                        id:     groupId,
                        values: { custitem_loop_product_id: loopProductId }
                    });
                } catch (writebackError) {
                    log.error({ title: 'Group Writeback Exception [' + groupId + ']', details: writebackError.message });
                }

                log.audit({
                    title:   'Group Product Synced [' + groupId + ']',
                    details: 'Loop Product ID: ' + loopProductId
                });
                context.write({
                    key:   groupId,
                    value: JSON.stringify({ loopProductId: loopProductId, children: children, status: 'success' })
                });
            } else {
                log.error({
                    title:   'Loop Product API Error [' + groupId + ']',
                    details: 'HTTP ' + response.code + ' | ' + response.body
                });
                context.write({
                    key:   groupId,
                    value: JSON.stringify({ status: 'error', code: response.code })
                });
            }
        } catch (e) {
            log.error({ title: 'Group Product Map Exception [' + groupId + ']', details: e.message });
            context.write({
                key:   groupId,
                value: JSON.stringify({ status: 'error', message: e.message })
            });
        }
    }

    function createVariant(loopProductId, child) {
        var sku     = child.sku;
        var name    = child.name || sku;
        var barcode = child.barcode;
        // NetSuite doesn't expose a flat "taxable" checkbox on Inventory Items --
        // taxability is driven by Tax Schedule/nexus, not a single boolean column.
        // Hardcoding true until there's a real source field to read this from.
        var taxable = true;
        var childId = child.internalId;

        // Loop external_id must be unique across variants -- using NS internal ID
        // as a fallback caused a duplicate error previously when reused across products.
        var externalId = barcode || String(childId);

        var variantData = {
            external_id:  externalId,
            name:         name,
            sku:          sku,
            barcode:      barcode,
            weight_grams: weightToGrams(child.weight, child.weightUnit),
            taxable:      taxable,
            price: {
                amount:        child.price,
                currency_code: 'USD'
            }
        };
        // The option value must exactly (case-sensitively) match one of the parent's
        // Size values[]. child.name is the purchase description, the same field the
        // parent builds its values[] from, so the two match by construction. Omit
        // options rather than fall back to the SKU, so we never emit a value the
        // parent product doesn't list.
        if (child.name) {
            variantData.options = [{ position: 1, value: child.name }];
        }

        var payload = JSON.stringify(variantData);

        log.audit({ title: 'Variant Payload [' + childId + ']', details: payload });

        var response = https.post({
            url:     LOOP_API_URL + '/products/' + loopProductId + '/product-variants',
            headers: buildHeaders(),
            body:    payload
        });

        if (response.code === 200 || response.code === 201) {
            var safeBody    = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
            var variantBody = JSON.parse(safeBody);
            var loopVariantId = variantBody.product_variant ? String(variantBody.product_variant.id) : null;

            record.submitFields({
                type:   record.Type.INVENTORY_ITEM,
                id:     childId,
                values: {
                    custitem_loop_product_id:         loopProductId,
                    custitem_loop_product_variant_id: loopVariantId
                }
            });

            log.audit({
                title:   'Variant Synced [' + childId + ']',
                details: 'SKU: ' + sku + ' | Loop Variant ID: ' + loopVariantId
            });
            return true;
        }

        log.error({
            title:   'Loop Variant API Error [' + childId + ']',
            details: 'HTTP ' + response.code + ' | ' + response.body
        });
        return false;
    }

    function reduce(context) {
        var groupId = context.key;
        var result  = JSON.parse(context.values[0]);

        if (result.status !== 'success' || !result.loopProductId) {
            context.write({ key: groupId, value: JSON.stringify({ status: 'error' }) });
            return;
        }

        // Parent product writeback already happened in map(), right after the PUT succeeded.
        var loopProductId = result.loopProductId;

        var variantSuccess = 0;
        var variantError   = 0;

        // Children were already fetched once in map() -- no need to search again here.
        // Only create variants for children that don't already have one, since the
        // POST endpoint isn't an upsert and would error on a duplicate external_id.
        (result.children || []).forEach(function (child) {
            if (child.loopVariantId) return;
            try {
                if (createVariant(loopProductId, child)) variantSuccess++;
                else variantError++;
            } catch (e) {
                log.error({ title: 'Variant Create Exception [' + child.internalId + ']', details: e.message });
                variantError++;
            }
        });

        log.audit({
            title:   'Group Written Back [' + groupId + ']',
            details: 'Loop Product ID: ' + loopProductId + ' | Variants created: ' + variantSuccess + ' | Variant errors: ' + variantError
        });
        context.write({
            key:   groupId,
            value: JSON.stringify({ status: 'success', variantSuccess: variantSuccess, variantError: variantError })
        });
    }

    function summarize(summary) {
        var groupSuccess   = 0;
        var groupError     = 0;
        var variantSuccess = 0;
        var variantError   = 0;

        summary.output.iterator().each(function (key, value) {
            var result = JSON.parse(value);
            if (result.status === 'success') {
                groupSuccess++;
                variantSuccess += result.variantSuccess || 0;
                variantError   += result.variantError || 0;
            } else {
                groupError++;
            }
            return true;
        });

        log.audit({
            title:   'Loop Products Integration Complete',
            details: 'Groups synced: ' + groupSuccess + ' | Group errors: ' + groupError +
                      ' | Variants created: ' + variantSuccess + ' | Variant errors: ' + variantError
        });

        if (summary.mapSummary.error) {
            log.error({ title: 'Product Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Product Map Key Error [' + key + ']', details: err });
            return true;
        });
        summary.reduceSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Product Reduce Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
