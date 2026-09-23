/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope Public
 *
 * BigCommerce product images -> NetSuite items (one-time backfill).
 *
 * NetSuite has no image URLs for items, so this pulls them from the BigCommerce catalog and
 * writes each one to custitem_bc_image_url on the matching NetSuite item.
 *
 * - getInputData: reads every BC product (with its variants and images) and returns
 *   { SKU: image URL }. BC stores photos per product -- variant image_url is empty -- so the
 *   product SKU (GBA-30, a NetSuite parent item) and each of its variant SKUs (GBA-30-0001,
 *   NetSuite child items) all get the product's main image at url_standard (386x513).
 *   Products with no images are left out.
 * - map: finds the NetSuite inventory item with that SKU and writes the URL to it.
 *
 * Needs the API Secret custsecret_bc_catalog_token (a BC API token with Products: read-only).
 * That token is temporary -- delete the BC API account once the backfill has run.
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], function (search, record, https, log) {

    var BC_CATALOG_URL = 'https://api.bigcommerce.com/stores/v999z6750t/v3/catalog';
    var IMAGE_FIELD    = 'custitem_bc_image_url';

    // TEST MODE: limit the run to these SKUs (BC product or variant SKUs, e.g. 'GBA-30',
    // 'GBA-30-0001'); set to null or [] to process the full catalog.
    var TEST_SKUS = null;

    function buildHeaders() {
        return {
            'Accept':       'application/json',
            'X-Auth-Token': https.createSecureString({ input: '{custsecret_bc_catalog_token}' })
        };
    }

    // Child item names can come back as "GBA-19 : GBA-19-0004" (parent : child); BC only has
    // the child part.
    function bareSku(itemId) {
        var parts = String(itemId || '').split(':');
        return parts[parts.length - 1].trim();
    }

    function getInputData() {
        var imagesBySku = {};
        var noImage     = [];
        var page        = 1;
        var totalPages  = 1;

        do {
            var response = https.get({
                url:     BC_CATALOG_URL + '/products?include=variants,images&limit=100&page=' + page,
                headers: buildHeaders()
            });
            if (response.code !== 200) {
                throw new Error('BigCommerce catalog request failed (HTTP ' + response.code + ') on page ' + page + ': ' + response.body);
            }

            var body = JSON.parse(response.body);
            (body.data || []).forEach(function (product) {
                var images = product.images || [];
                var main   = images.filter(function (img) { return img.is_thumbnail; })[0] || images[0];
                if (!main) {
                    noImage.push(product.sku || String(product.id));
                    return;
                }
                // A product without options has one base variant whose SKU equals the product
                // SKU, so keying by SKU also de-duplicates it.
                var skus = [product.sku].concat((product.variants || []).map(function (v) { return v.sku; }));
                skus.forEach(function (sku) {
                    if (sku && sku.trim()) imagesBySku[sku.trim()] = main.url_standard;
                });
            });

            totalPages = body.meta && body.meta.pagination ? body.meta.pagination.total_pages : 1;
            page++;
        } while (page <= totalPages);

        log.audit({ title: 'BC Catalog Loaded', details: Object.keys(imagesBySku).length + ' SKUs with an image' });
        if (noImage.length) {
            log.audit({ title: 'BC Products Without Images (skipped)', details: noImage.join(', ') });
        }

        if (TEST_SKUS && TEST_SKUS.length) {
            log.audit({ title: 'TEST MODE', details: 'Restricting run to SKU(s): ' + TEST_SKUS.join(', ') });
            var testInput = {};
            TEST_SKUS.forEach(function (sku) {
                if (imagesBySku[sku]) testInput[sku] = imagesBySku[sku];
            });
            return testInput;
        }

        // Returned as an object: each SKU becomes a map key, its image URL the value.
        return imagesBySku;
    }

    function map(context) {
        var sku      = context.key;
        var imageUrl = context.value;

        try {
            // 'contains' rather than 'is' so the lookup doesn't depend on whether the name filter
            // sees a child as "GBA-19-0004" or "GBA-19 : GBA-19-0004"; the exact match is
            // checked on each row instead.
            var matches = [];
            search.create({
                type: search.Type.INVENTORY_ITEM,
                filters: [
                    ['isinactive', 'is', 'F'],
                    'AND',
                    ['itemid', 'contains', sku]
                ],
                columns: [
                    search.createColumn({ name: 'itemid' }),
                    search.createColumn({ name: IMAGE_FIELD })
                ]
            }).run().each(function (result) {
                if (bareSku(result.getValue('itemid')).toUpperCase() === sku.toUpperCase()) {
                    matches.push({ id: result.id, currentUrl: result.getValue(IMAGE_FIELD) });
                }
                return true;
            });

            if (!matches.length) {
                context.write({ key: sku, value: JSON.stringify({ status: 'not_in_ns' }) });
                return;
            }
            if (matches.length > 1) {
                log.audit({
                    title:   'Multiple NetSuite Items For SKU [' + sku + ']',
                    details: 'Item IDs: ' + matches.map(function (m) { return m.id; }).join(', ') + ' -- updating all'
                });
            }

            var updatedIds = [];
            matches.forEach(function (item) {
                if (item.currentUrl === imageUrl) return;
                record.submitFields({
                    type:   record.Type.INVENTORY_ITEM,
                    id:     item.id,
                    values: { [IMAGE_FIELD]: imageUrl }
                });
                updatedIds.push(item.id);
            });

            if (updatedIds.length) {
                log.audit({
                    title:   'Image Set [' + sku + ']',
                    details: 'Item ID(s): ' + updatedIds.join(', ') + ' | ' + imageUrl
                });
            }
            context.write({
                key:   sku,
                value: JSON.stringify({ status: updatedIds.length ? 'updated' : 'unchanged' })
            });
        } catch (e) {
            log.error({ title: 'Image Map Exception [' + sku + ']', details: e.message });
            context.write({ key: sku, value: JSON.stringify({ status: 'error', message: e.message }) });
        }
    }

    // Script log details are capped around 4,000 characters, so long lists are split across entries.
    function logList(title, items) {
        var chunk = '';
        var part  = 1;
        items.forEach(function (item) {
            if (chunk && chunk.length + item.length + 2 > 3800) {
                log.audit({ title: title + ' (' + part++ + ')', details: chunk });
                chunk = '';
            }
            chunk += (chunk ? ', ' : '') + item;
        });
        if (chunk) log.audit({ title: title + ' (' + part + ')', details: chunk });
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error({ title: 'BC Images Input Stage Error', details: summary.inputSummary.error });
        }

        // No reduce stage, so summary.output holds the map stage's key/value pairs directly.
        var counts  = { updated: 0, unchanged: 0, not_in_ns: 0, error: 0 };
        var notInNs = [];
        summary.output.iterator().each(function (sku, value) {
            var status = JSON.parse(value).status;
            counts[status] = (counts[status] || 0) + 1;
            if (status === 'not_in_ns') notInNs.push(sku);
            return true;
        });

        log.audit({
            title:   'BC Product Images Complete',
            details: 'Updated: ' + counts.updated + ' | Already set: ' + counts.unchanged +
                     ' | SKU not in NetSuite: ' + counts.not_in_ns + ' | Errors: ' + counts.error
        });
        logList('BC SKUs Not Found In NetSuite', notInNs);

        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'BC Images Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, summarize };
});
