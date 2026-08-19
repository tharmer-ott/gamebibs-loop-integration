/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/search', 'N/record', 'N/https', 'N/log', 'N/runtime'], function (search, record, https, log, runtime) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    // GameBibs has a single fulfillment location, but its Loop ID differs by environment,
    // so resolve it from envType rather than hardcoding one value (mirrors the envType
    // check loop_returns.js uses for its sandbox Cash behavior).
    var LOOP_LOCATION_ID = runtime.envType === runtime.EnvType.SANDBOX
        ? '894555345163870208'   // sandbox Loop location
        : '929970130160201728';  // production Loop location

    // TEST MODE: restrict getInputData to a single order (by tranid) for a sanity check.
    // Set to null to run the full qualifying set.
    var TEST_ORDER_TRANID = null;

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    // Convert a dollar value to integer cents for Loop's money fields
    function toCents(val) {
        return Math.round((parseFloat(val) || 0) * 100);
    }

    function money(val) {
        return { amount: toCents(val), currency_code: 'USD' };
    }

    // Convert NS date string to ISO 8601 (ATOM format required by Loop).
    // trandate returns 'M/D/YYYY'; lastmodifieddate returns 'M/D/YYYY H:MM am/pm'.
    // Strip any time portion before parsing so both formats work.
    function toIso(nsDateStr) {
        if (!nsDateStr) return null;
        var datePart = String(nsDateStr).split(' ')[0];  // drop time component if present
        var parts = datePart.split('/');
        if (parts.length !== 3) return null;
        var m = parts[0].length === 1 ? '0' + parts[0] : parts[0];
        var d = parts[1].length === 1 ? '0' + parts[1] : parts[1];
        return parts[2] + '-' + m + '-' + d + 'T00:00:00+00:00';
    }

    // Map NS SO status code to Loop status
    function mapStatus(nsStatus) {
        // SalesOrd:F = Cancelled
        if (nsStatus === 'SalesOrd:F') return 'cancelled';
        return 'active';
    }

function getInputData() {
        // One row per Sales Order not yet pushed to Loop
        var filters = [
            ['type', 'anyof', 'SalesOrd'],
            'AND',
            ['mainline', 'is', 'T'],
            'AND',
            [
                ['status', 'anyof', ['SalesOrd:D', 'SalesOrd:E']],  // Partially Fulfilled / Pending Billing+Partial — always re-sync
                'OR',
                [
                    ['status', 'anyof', ['SalesOrd:F', 'SalesOrd:G']],             // Pending Billing (fully fulfilled) — first sync only
                    'AND',
                    ['custbody_loop_order_id', 'isempty', '']
                ]
            ],
            'AND',
            ['entity', 'anyof', ['1020']],  // BigCommerce bucket customer 491 only (Amazon is not synced to Loop)
            'AND',
            ['trandate', 'onorafter', '7/31/2026']  // Go-live cutoff: never sync orders dated before this
        ];

        // TEST MODE: narrow to a single order for a sanity check (see TEST_ORDER_TRANID).
        if (TEST_ORDER_TRANID) {
            filters.push('AND', ['tranid', 'is', TEST_ORDER_TRANID]);
        }

        return search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'lastmodifieddate' }),
                search.createColumn({ name: 'statusref' }),
                search.createColumn({ name: 'entity' }),
                search.createColumn({ name: 'taxtotal' }),
                search.createColumn({ name: 'total' }),
                search.createColumn({ name: 'discountamount' }),
                search.createColumn({ name: 'shippingcost' }),
                search.createColumn({ name: 'shipmethod' })
            ]
        });
    }

    // Fetch all item lines for a Sales Order, joining Loop product/variant IDs from the item record.
    // itemtype is a valid search column but NOT a valid search filter on transaction searches —
    // we fetch it as a column and skip non-InvtPart lines in JavaScript instead.
    function getOrderLines(soId) {
        var lines = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['internalid', 'anyof', soId],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['taxline', 'is', 'F'],
                'AND',
                ['shipping', 'is', 'F']
            ],
            columns: [
                search.createColumn({ name: 'line' }),
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'itemtype' }),
                search.createColumn({ name: 'quantity' }),
                search.createColumn({ name: 'rate' }),
                search.createColumn({ name: 'custitem_loop_product_id',         join: 'item' }),
                search.createColumn({ name: 'custitem_loop_product_variant_id', join: 'item' })
            ]
        }).run().each(function (result) {
            // Skip anything that isn't a stocked inventory item (discounts, subtotals, services, etc.)
            if (result.getValue('itemtype') !== 'InvtPart') return true;
            lines.push({
                lineSeq:       result.getValue('line'),
                itemName:      result.getText('item'),
                quantity:      parseInt(result.getValue('quantity'))  || 0,
                rate:          parseFloat(result.getValue('rate'))    || 0,
                taxable:       true, // resolved from record load in map() and applied after
                loopProductId: result.getValue({ name: 'custitem_loop_product_id',         join: 'item' }),
                loopVariantId: result.getValue({ name: 'custitem_loop_product_variant_id', join: 'item' })
            });
            return true;
        });
        return lines;
    }

    // Fetch discount lines on the SO for order_discounts payload.
    // itemtype is a valid search column but NOT a valid search filter on transaction searches —
    // we fetch it as a column and skip non-Discount lines in JavaScript instead.
    function getDiscounts(soId) {
        var discounts = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['internalid', 'anyof', soId],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['taxline', 'is', 'F'],
                'AND',
                ['shipping', 'is', 'F']
            ],
            columns: [
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'itemtype' }),
                search.createColumn({ name: 'amount' })
            ]
        }).run().each(function (result) {
            if (result.getValue('itemtype') !== 'Discount') return true;
            var amount = parseFloat(result.getValue('amount')) || 0;
            if (amount !== 0) {
                discounts.push({
                    title:  result.getText('item') || 'Discount',
                    amount: Math.abs(amount)
                });
            }
            return true;
        });
        return discounts;
    }

    // Fetch Item Fulfillments linked to the SO.
    // Many header and line fields (shipstatus, shipcarrier, trackingnumbers, orderline) are not
    // valid transaction search columns for ItemShip — load each fulfillment record directly instead.
    function getFulfillments(soId) {
        var fulfillments = [];

        // Step 1: get fulfillment IDs and dates from a header-only search
        var headers = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', 'ItemShip'],
                'AND',
                ['createdfrom', 'anyof', soId],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'trandate' })
            ]
        }).run().each(function (result) {
            headers.push({ id: result.getValue('internalid'), date: result.getValue('trandate') });
            return true;
        });

        // Step 2: load each fulfillment to read status, carrier, tracking, and line→SO mapping
        headers.forEach(function (header) {
            try {
                var ffRec      = record.load({ type: record.Type.ITEM_FULFILLMENT, id: header.id, isDynamic: false });
                var shipStatus = ffRec.getValue('shipstatus');
                var carrier    = ffRec.getValue('shipcarrier') || null;

                // Tracking numbers live on the package sublist, not a body field
                var trackingNumbers = [];
                var pkgCount = ffRec.getLineCount({ sublistId: 'package' });
                for (var p = 0; p < pkgCount; p++) {
                    var tn = ffRec.getSublistValue({ sublistId: 'package', fieldId: 'packagetrackingnumber', line: p });
                    if (tn) trackingNumbers.push(tn);
                }

                var lines     = [];
                var lineCount = ffRec.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    var soLineSeq = String(ffRec.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                    var qty       = parseInt(ffRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',  line: i })) || 0;
                    if (soLineSeq) lines.push({ soLineSeq: soLineSeq, quantity: qty });
                }

                fulfillments.push({
                    externalId:      String(header.id),
                    status:          'success',
                    fulfilledAt:     toIso(header.date),
                    shippingCarrier: carrier,
                    trackingNumbers: trackingNumbers,
                    lines:           lines
                });
            } catch (loadErr) {
                log.error({ title: 'Fulfillment Record Load Failed [' + header.id + ']', details: loadErr.message });
            }
        });

        return fulfillments;
    }

    // Fetch Credit Memos (refunds) linked to the SO.
    // orderline and amount are not valid transaction search columns for CustCred —
    // load each credit memo record directly instead.
    function getRefunds(soId) {
        var refunds = [];

        // Step 1: get credit memo IDs and dates from a header-only search
        var headers = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', 'CustCred'],
                'AND',
                ['createdfrom', 'anyof', soId],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'trandate' })
            ]
        }).run().each(function (result) {
            headers.push({ id: result.getValue('internalid'), date: result.getValue('trandate') });
            return true;
        });

        // Step 2: load each credit memo to read line→SO mapping and amounts
        headers.forEach(function (header) {
            try {
                var cmRec     = record.load({ type: record.Type.CREDIT_MEMO, id: header.id, isDynamic: false });
                var lines     = [];
                var lineCount = cmRec.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    var soLineSeq = String(cmRec.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i }));
                    var qty       = parseInt(cmRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',  line: i })) || 0;
                    var amount    = Math.abs(parseFloat(cmRec.getSublistValue({ sublistId: 'item', fieldId: 'amount',    line: i })) || 0);
                    if (soLineSeq) lines.push({ soLineSeq: soLineSeq, quantity: qty, amount: amount });
                }

                refunds.push({
                    externalId: String(header.id),
                    type:       'line_item',
                    createdAt:  toIso(header.date),
                    lines:      lines
                });
            } catch (loadErr) {
                log.error({ title: 'Refund Record Load Failed [' + header.id + ']', details: loadErr.message });
            }
        });

        return refunds;
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var values = result.values;
        var soId   = result.id;

        var soNumber = values.tranid;
        log.audit({ title: 'Order Map [' + soId + ']', details: 'SO: ' + soNumber });

        // Fetch line items
        var lines;
        try {
            lines = getOrderLines(soId);
        } catch (lineErr) {
            log.error({ title: 'Order getOrderLines Failed [' + soId + ']', details: lineErr.message });
            context.write({ key: soId, value: JSON.stringify({ status: 'error', message: lineErr.message }) });
            return;
        }
        log.audit({ title: 'Order Lines [' + soId + ']', details: 'SO: ' + soNumber + ' | Line count: ' + lines.length });

        if (!lines.length) {
            log.error({ title: 'Order Skipped — No Lines [' + soId + ']', details: 'SO: ' + soNumber });
            return;
        }

        // Load shipping address and per-line taxable flag from the record
        var shippingAddress = null;
        var taxableByLine   = {}; // { lineSeq: true/false }
        var addressee       = ''; // recipient name from shipping subrecord — used for customer inline upsert
        var orderEmail      = ''; // customer email from the SO 'email' body field — used for customer inline upsert
        var shippingTax     = 0;  // from custbody_fa_order_total JSON — applied to the shipping line's tax_lines
        var shippingTaxRate = 0;  // decimal fraction (e.g. 0.097411) for the shipping tax line's rate
        var itemTaxRate     = 0;  // decimal fraction (e.g. 0.097498) for the item tax lines' rate
        try {
            var soRec = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

            // Customer email lives on the SO 'email' body field — used for the inline customer upsert.
            orderEmail = soRec.getValue({ fieldId: 'email' }) || '';

            // custbody_fa_order_total is a JSON string with the connector's amount breakdown,
            // e.g. {"orderTotal":85.67,"itemTotal":69.95,"taxTotal":7.61,"shippingCost":8.11,"shippingTax":0.79,"discountTotal":0.0}
            var faOrderTotalRaw = soRec.getValue({ fieldId: 'custbody_fa_order_total' });
            if (faOrderTotalRaw) {
                try {
                    var faOrderTotal = JSON.parse(faOrderTotalRaw);
                    shippingTax = parseFloat(faOrderTotal.shippingTax) || 0;
                } catch (faErr) {
                    log.error({ title: 'Order fa_order_total Parse Failed [' + soId + ']', details: 'SO: ' + soNumber + ' | ' + faErr.message });
                }
            }

            // Tax rates are stored as percentages; convert to decimal fractions for Loop's rate field
            // (Shopify-style, e.g. 9.7411% -> 0.097411). Rounded to 6 places to avoid float tails.
            function toRate(pct) { return Math.round((parseFloat(pct) || 0) * 1e4) / 1e6; }
            shippingTaxRate = toRate(soRec.getValue({ fieldId: 'custbody_fa_shipping_tax' })); // shipping tax rate %
            itemTaxRate     = toRate(soRec.getValue({ fieldId: 'taxrate' }));                  // item/effective tax rate %
            // Shipping address is stored in the shippingaddress subrecord, not as body fields
            try {
                var shipSubrec = soRec.getSubrecord({ fieldId: 'shippingaddress' });
                var shipAddr1  = shipSubrec.getValue('addr1') || '';
                var shipAddr2  = shipSubrec.getValue('addr2') || '';
                var shipCity   = shipSubrec.getValue('city')  || '';

                // addressee = the actual recipient on this B2C order (not the bucket customer name)
                addressee = shipSubrec.getValue('addressee') || '';

                if (shipAddr1 && shipCity) {
                    shippingAddress = {
                        address1:     shipAddr1,
                        city:         shipCity,
                        region:       shipSubrec.getValue('state')   || '',
                        postal_code:  shipSubrec.getValue('zip')     || '',
                        country_code: shipSubrec.getValue('country') || 'US'
                    };

                    // B2C orders — addressee is the customer's name, no company
                    // Omit entirely when blank — Loop rejects empty strings
                    if (addressee) shippingAddress.name = addressee;
                    if (shipAddr2) shippingAddress.address2 = shipAddr2;
                } else {
                    log.audit({
                        title:   'Order Shipping Address Missing [' + soId + ']',
                        details: 'SO: ' + soNumber + ' | Shipping subrecord has no addr1/city — shipping_address will be omitted'
                    });
                }
            } catch (subrecErr) {
                log.audit({
                    title:   'Order Shipping Address Missing [' + soId + ']',
                    details: 'SO: ' + soNumber + ' | No shipping subrecord — shipping_address will be omitted'
                });
            }
            var lineCount = soRec.getLineCount({ sublistId: 'item' });
            for (var li = 0; li < lineCount; li++) {
                var lineSeq  = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'line',      line: li }));
                var isTaxable = soRec.getSublistValue({ sublistId: 'item', fieldId: 'istaxable', line: li });
                taxableByLine[lineSeq] = isTaxable === true || isTaxable === 'T';
            }
        } catch (addrErr) {
            log.error({ title: 'Order Record Load Failed [' + soId + ']', details: addrErr.message });
        }

        // Fetch discounts BEFORE building the payload so they're included in the first PUT.
        // (The second PUT only fires when fulfillments/refunds exist — an order with discounts
        // but no fulfillments would never get its discount data sent if we waited until Step 2.)
        var nsDiscounts = [];
        try { nsDiscounts = getDiscounts(soId); } catch (discountErr) {
            log.error({ title: 'getDiscounts Failed [' + soId + ']', details: discountErr.message });
        }

        // Skip if any line is missing its Loop product/variant ID
        var missingProduct = lines.filter(function (l) { return !l.loopProductId || !l.loopVariantId; });
        if (missingProduct.length) {
            log.audit({
                title:   'Order Skipped — Unsynced Products [' + soId + ']',
                details: 'SO: ' + soNumber + ' | Missing Loop IDs on: ' +
                         missingProduct.map(function (l) { return l.itemName + ' (line ' + l.lineSeq + ')'; }).join(', ') +
                         ' — sync products first'
            });
            return;
        }

        var shipMethodField = values.shipmethod;
        var shipMethodName  = Array.isArray(shipMethodField) ? shipMethodField[0].text :
                              (shipMethodField && shipMethodField.text) ? shipMethodField.text :
                              (shipMethodField ? String(shipMethodField) : 'Standard Shipping');

        // Build line items for Loop payload.
        // external_id must be GLOBALLY unique across all orders in Loop — not just unique within
        // this order. Using soId + '_' + lineSeq ensures uniqueness (e.g. "1562882_1").
        // Loop IDs are 18-digit integers that exceed JS float64 precision.
        // We use a '__LOOPID__<digits>' placeholder so JSON.stringify emits a quoted string,
        // then strip the quotes with a regex replacement before sending — preserving full precision.
        var lineItems = lines.map(function (line) {
            return {
                external_id:                soId + '_' + line.lineSeq,
                product:                    { id: '__LOOPID__' + line.loopProductId },
                product_variant:            { id: '__LOOPID__' + line.loopVariantId },
                quantity:                   line.quantity,
                unit_price:                 { amount: toCents(line.rate), currency_code: 'USD' },
                unit_price_presentment:     { amount: toCents(line.rate), currency_code: 'USD' },
                unit_discounts:             { amount: 0, currency_code: 'USD' },
                unit_discounts_presentment: { amount: 0, currency_code: 'USD' },
                taxable:                    taxableByLine[String(line.lineSeq)] !== false,
                tax_lines:                  [],
                refunds:                    [],
                discounts:                  [],
                duties:                     []
            };
        });

        // Distribute the item-level tax (total tax minus the shipping tax already placed on the
        // shipping line) across the line items, weighted by extended amount (quantity * rate).
        // Work entirely in integer cents; any rounding remainder lands on the first line so the
        // allocated total stays exact.
        var totalTaxCents    = toCents(values.taxtotal);
        var shippingTaxCents = shippingTax > 0 ? toCents(shippingTax) : 0;
        var itemTaxCents     = totalTaxCents - shippingTaxCents;

        if (itemTaxCents > 0 && lineItems.length) {
            var weights     = lines.map(function (l) { return (l.quantity || 0) * (l.rate || 0); });
            var totalWeight = weights.reduce(function (s, w) { return s + w; }, 0);

            var allocated = weights.map(function (w) {
                return totalWeight > 0 ? Math.round(itemTaxCents * w / totalWeight) : 0;
            });

            // Push any rounding drift (extra/short pennies) onto the first line.
            var allocatedSum = allocated.reduce(function (s, a) { return s + a; }, 0);
            allocated[0] += itemTaxCents - allocatedSum;

            lineItems.forEach(function (li, i) {
                if (allocated[i] > 0) {
                    li.tax_lines = [{ title: 'Tax', price: { amount: allocated[i], currency_code: 'USD' }, rate: itemTaxRate }];
                }
            });
        }

        var payload = {
            external_id:                 String(soId),
            name:                        soNumber,
            status:                      mapStatus(
                                             Array.isArray(values.statusref) ? values.statusref[0].value :
                                             (values.statusref && values.statusref.value) ? values.statusref.value :
                                             String(values.statusref)
                                         ),
            sales_channel:               'NetSuite',
            source:                      'NetSuite',
            taxes_included:              false,
            created_at:                  toIso(values.trandate),
            updated_at:                  toIso(values.lastmodifieddate) || toIso(values.trandate),
            // Customer is upserted inline — Loop requires first_name, last_name, email, and phone
            // all present together. Split addressee into first/last; email comes from the SO
            // 'email' body field (placeholder fallback when blank). Phone stays a placeholder
            // since B2C orders don't carry it on the record.
            customer: (function () {
                var fullName   = addressee || soNumber;
                var spaceIdx   = fullName.lastIndexOf(' ');
                var firstName  = spaceIdx > 0 ? fullName.substring(0, spaceIdx) : fullName;
                var lastName   = spaceIdx > 0 ? fullName.substring(spaceIdx + 1) : '.';
                return {
                    external_id: String(soId),
                    first_name:  firstName,
                    last_name:   lastName,
                    email:       orderEmail || 'none@email.com',
                    phone:       '000-000-0000'
                };
            }()),
            total_price:                 money(values.total),
            total_price_presentment:     money(values.total),
            total_taxes:                 money(values.taxtotal),
            total_taxes_presentment:     money(values.taxtotal),
            // Prefer line-level discount total when line discount items exist;
            // fall back to the header discountamount field otherwise.
            total_discounts:             money(nsDiscounts.length
                                             ? nsDiscounts.reduce(function (sum, d) { return sum + d.amount; }, 0)
                                             : Math.abs(parseFloat(values.discountamount) || 0)),
            total_discounts_presentment: money(nsDiscounts.length
                                             ? nsDiscounts.reduce(function (sum, d) { return sum + d.amount; }, 0)
                                             : Math.abs(parseFloat(values.discountamount) || 0)),
            total_shipping:              money(values.shippingcost),
            total_shipping_presentment:  money(values.shippingcost),
            shipping_address: shippingAddress || undefined,
            shipping_lines: [{
                title:     shipMethodName,
                price:     money(values.shippingcost),
                discounts: [],
                tax_lines: shippingTax > 0
                    ? [{ title: 'Tax', price: money(shippingTax), rate: shippingTaxRate }]
                    : []
            }],
            order_discounts: nsDiscounts.map(function (d, idx) {
                var cents = toCents(d.amount);
                return {
                    external_id:          String(soId) + '_disc_' + idx,
                    name:                 d.title,
                    discount_type:        'amount',
                    rate:                 null,
                    net_adjustment_money: { amount: cents, currency_code: 'USD' },
                    tax_adjustment_money: { amount: 0,     currency_code: 'USD' }
                };
            }),
            line_items:      lineItems,
            fulfillments:    [],
            refunds:         []
        };

        // Reconcile allocated tax (shipping line + every item line) back to the order's total tax.
        // Never fail on a mismatch:
        //   - a small drift (<= 2 cents, i.e. rounding) folds onto the first tax line;
        //   - a larger diff (a data anomaly) is spread one cent at a time across random lines
        //     so no single line takes a visible lump.
        (function reconcileTaxAllocation() {
            var sum = 0;
            payload.shipping_lines.forEach(function (sl) {
                (sl.tax_lines || []).forEach(function (t) { sum += t.price.amount; });
            });
            payload.line_items.forEach(function (li) {
                (li.tax_lines || []).forEach(function (t) { sum += t.price.amount; });
            });

            var diff = totalTaxCents - sum;
            if (!diff) return; // already exact

            // Build the pool of tax lines that can absorb the difference: the first tax line of
            // each item line that has one. If none exist, seed one on the first item line
            // (falling back to the shipping tax line only when there are no item lines at all).
            var targets = [];
            payload.line_items.forEach(function (li) {
                if (li.tax_lines && li.tax_lines.length) targets.push(li.tax_lines[0]);
            });
            if (!targets.length && payload.line_items.length) {
                payload.line_items[0].tax_lines = [{ title: 'Tax', price: { amount: 0, currency_code: 'USD' }, rate: itemTaxRate }];
                targets.push(payload.line_items[0].tax_lines[0]);
            }
            if (!targets.length && payload.shipping_lines[0].tax_lines && payload.shipping_lines[0].tax_lines.length) {
                targets.push(payload.shipping_lines[0].tax_lines[0]);
            }
            if (!targets.length) return;

            var mode;
            if (Math.abs(diff) <= 2 || targets.length < 2) {
                // Rounding-level drift (or nothing to spread across) — fold onto the first line.
                targets[0].price.amount += diff;
                mode = 'folded onto first line';
            } else {
                // Larger anomaly — spread one cent at a time across randomly chosen lines.
                var step      = diff > 0 ? 1 : -1;
                var remaining = Math.abs(diff);
                var guard     = 0;
                while (remaining > 0 && guard < 1000000) {
                    guard++;
                    var idx = Math.floor(Math.random() * targets.length);
                    if (step < 0 && targets[idx].price.amount <= 0) continue; // never drive an amount negative
                    targets[idx].price.amount += step;
                    remaining--;
                }
                mode = 'spread randomly across ' + targets.length + ' lines';
            }

            log.audit({
                title:   'Order Tax Reconciled [' + soId + ']',
                details: 'SO: ' + soNumber + ' | diff ' + diff + ' cents ' + mode + '; total ' + totalTaxCents + ' cents'
            });
        }());

        // Set each tax line's rate to the real tax rate (decimal fraction): the shipping tax
        // rate on the shipping line, the item tax rate on the item lines. The amount lives in
        // price; rate is the percentage that produced it.
        payload.shipping_lines.forEach(function (sl) {
            (sl.tax_lines || []).forEach(function (t) { t.rate = shippingTaxRate; });
        });
        payload.line_items.forEach(function (li) {
            (li.tax_lines || []).forEach(function (t) { t.rate = itemTaxRate; });
        });

        // Serialize payload, then strip '__LOOPID__' placeholders so large Loop IDs
        // are emitted as raw JSON integers (not quoted strings) with full precision.
        function serializePayload(p) {
            return JSON.stringify(p).replace(/"__LOOPID__(\d+)"/g, '$1');
        }

        try {
            // Step 1: Create/upsert the order — get Loop line item IDs back
            var response = https.put({
                url:     LOOP_API_URL + '/orders',
                headers: buildHeaders(),
                body:    serializePayload(payload)
            });

            if (response.code !== 200 && response.code !== 201) {
                log.error({
                    title:   'Loop Order API Error [' + soId + ']',
                    details: 'HTTP ' + response.code + ' | ' + response.body
                });
                context.write({ key: soId, value: JSON.stringify({ status: 'error', code: response.code }) });
                return;
            }

            // Pre-process response body to wrap large integers as strings before JSON.parse
            // — JavaScript loses precision on integers > 2^53 (Loop IDs are 18 digits)
            var safeBody   = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
            var orderBody  = JSON.parse(safeBody);
            var loopOrderId   = orderBody.order.id;
            var returnedLines = orderBody.order.line_items || [];

            // Build external_id → Loop line item ID map for fulfillment/refund linking
            var lineIdMap = {};
            returnedLines.forEach(function (li) {
                lineIdMap[String(li.external_id)] = String(li.id);
            });

            log.audit({
                title:   'Order Synced [' + soId + ']',
                details: 'SO: ' + soNumber + ' | Loop Order ID: ' + loopOrderId
            });

            // Step 2: Attach fulfillments and refunds if they exist
            // Isolated try/catches so a lookup failure here never prevents the NS writeback
            var nsFulfillments = [];
            var nsRefunds      = [];
            try { nsFulfillments = getFulfillments(soId); } catch (fulfillErr) {
                log.error({ title: 'getFulfillments Failed [' + soId + ']', details: fulfillErr.message });
            }
            try { nsRefunds = getRefunds(soId); } catch (refundErr) {
                log.error({ title: 'getRefunds Failed [' + soId + ']', details: refundErr.message });
            }

            if (nsFulfillments.length || nsRefunds.length) {
                payload.fulfillments = nsFulfillments.map(function (f) {
                    var fulfillObj = {
                        external_id:      f.externalId,
                        status:           f.status,
                        fulfilled_at:     f.fulfilledAt,
                        tracking_numbers: f.trackingNumbers,
                        fulfillment_line_items: f.lines.map(function (l, idx) {
                            return {
                                external_id:                 f.externalId + '_' + idx,
                                order_line_item_external_id: soId + '_' + l.soLineSeq,
                                quantity:                    l.quantity
                            };
                        })
                    };
                    // GameBibs has a single location; LOOP_LOCATION_ID resolves by environment
                    fulfillObj.location = { id: '__LOOPID__' + LOOP_LOCATION_ID };
                    if (f.shippingCarrier) fulfillObj.shipping_carrier = f.shippingCarrier;
                    return fulfillObj;
                });

                payload.refunds = nsRefunds.map(function (r) {
                    var firstLine    = r.lines[0];
                    var refundTotal  = r.lines.reduce(function (sum, l) { return sum + l.amount; }, 0);
                    return {
                        external_id: r.externalId,
                        type:        r.type,
                        created_at:  r.createdAt,
                        total:       money(refundTotal),
                        line_item:   firstLine && lineIdMap[firstLine.soLineSeq]
                            ? { id: '__LOOPID__' + lineIdMap[firstLine.soLineSeq], quantity: firstLine.quantity, restock: true }
                            : null
                    };
                });

                var updateResponse = https.put({
                    url:     LOOP_API_URL + '/orders',
                    headers: buildHeaders(),
                    body:    serializePayload(payload)
                });

                if (updateResponse.code !== 200 && updateResponse.code !== 201) {
                    log.error({
                        title:   'Loop Order Fulfillment/Refund Update Error [' + soId + ']',
                        details: 'HTTP ' + updateResponse.code + ' | ' + updateResponse.body
                    });
                }
            }

            context.write({
                key:   soId,
                value: JSON.stringify({ status: 'success', loopOrderId: String(loopOrderId), lineIdMap: lineIdMap })
            });

        } catch (e) {
            log.error({ title: 'Order Map Exception [' + soId + ']', details: e.message });
            context.write({ key: soId, value: JSON.stringify({ status: 'error', message: e.message }) });
        }
    }

    function reduce(context) {
        var result = JSON.parse(context.values[0]);
        if (result.status !== 'success') {
            context.write({ key: context.key, value: context.values[0] });
            return;
        }

        var soId        = context.key;
        var loopOrderId = result.loopOrderId;
        var lineIdMap   = result.lineIdMap; // { nsLineSeq: loopLineItemId }

        try {
            var soRecord = record.load({ type: record.Type.SALES_ORDER, id: soId });

            soRecord.setValue({ fieldId: 'custbody_loop_order_id', value: loopOrderId });

            var lineCount = soRecord.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < lineCount; i++) {
                var lineSeq    = String(soRecord.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }));
                var loopLineId = lineIdMap[lineSeq];
                if (loopLineId) {
                    soRecord.setSublistValue({
                        sublistId: 'item',
                        fieldId:   'custcol_loop_line_id',
                        line:      i,
                        value:     loopLineId
                    });
                }
            }

            soRecord.save({ ignoreMandatoryFields: true });
            log.audit({ title: 'Order Written Back [' + soId + ']', details: 'Loop Order ID: ' + loopOrderId + ' | Lines updated: ' + Object.keys(lineIdMap).length });
            context.write({ key: soId, value: JSON.stringify({ status: 'success' }) });

        } catch (e) {
            log.error({ title: 'Order Reduce Exception [' + soId + ']', details: e.message });
            context.write({ key: soId, value: JSON.stringify({ status: 'error', message: e.message }) });
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
            title:   'Loop Orders Integration Complete',
            details: 'Success: ' + successCount + ' | Errors: ' + errorCount
        });

        if (summary.mapSummary.error) {
            log.error({ title: 'Order Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Order Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
