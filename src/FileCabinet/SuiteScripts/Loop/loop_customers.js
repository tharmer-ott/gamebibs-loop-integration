/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], function (search, record, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    function buildHeaders() {
        return {
            'Content-Type':  'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function getInputData() {
        // Fetch all active customers flagged for sync (new or modified since last sync).
        // The custentity_loop_sync_required flag is set by default on new customers and
        // reset to true by loop_ue_customer.js whenever a customer record is saved.
        return search.create({
            type: search.Type.CUSTOMER,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                ['custentity_loop_sync_required', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'isperson' }),
                search.createColumn({ name: 'firstname' }),
                search.createColumn({ name: 'lastname' }),
                search.createColumn({ name: 'companyname' }),
                search.createColumn({ name: 'email' }),
                search.createColumn({ name: 'phone' })
            ]
        });
    }

    function map(context) {
        var result = JSON.parse(context.value);
        var values = result.values;

        var internalId = result.id;
        var isPerson   = values.isperson === 'T';
        var firstName  = isPerson ? values.firstname  : values.companyname;
        var lastName   = isPerson ? values.lastname   : '';
        var email      = values.email;
        var phone      = values.phone;
        var fullName   = (firstName + ' ' + lastName).trim();

        log.audit({
            title:   'Customer Map [' + internalId + ']',
            details: 'Name: ' + fullName + ' | NS ID: ' + internalId
        });

        var payload = JSON.stringify({
            external_id:   String(internalId),
            sales_channel: 'NetSuite',
            first_name:    firstName,
            last_name:     lastName,
            email:         email,
            phone:         phone
        });

        try {
            // PUT upserts by external_id — works for both create and update
            var response = https.put({
                url:     LOOP_API_URL + '/customers',
                headers: buildHeaders(),
                body:    payload
            });

            if (response.code === 200 || response.code === 201) {
                // Wrap large integers before JSON.parse to avoid float64 precision loss
                var safeBody       = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
                var customerBody   = JSON.parse(safeBody);
                var loopCustomerId = customerBody.customer ? String(customerBody.customer.id) : null;
                log.audit({
                    title:   'Customer Synced [' + internalId + ']',
                    details: 'Name: ' + fullName + ' | NS ID: ' + internalId + ' | Loop ID: ' + loopCustomerId
                });
                context.write({
                    key:   internalId,
                    value: JSON.stringify({ loopId: loopCustomerId, status: 'success' })
                });
            } else if (response.code === 429) {
                // Rate limited — custentity_loop_customer_id stays empty so the next sync
                // run will pick this record up and retry automatically.
                log.audit({
                    title:   'Loop Customer Rate Limited [' + internalId + ']',
                    details: 'HTTP 429 — will retry on next sync run'
                });
            } else {
                log.error({
                    title:   'Loop Customer API Error',
                    details: 'NS ID: ' + internalId + ' | HTTP ' + response.code + ' | ' + response.body
                });
                context.write({
                    key:   internalId,
                    value: JSON.stringify({ status: 'error', code: response.code })
                });
            }
        } catch (e) {
            log.error({ title: 'Customer Map Exception [' + internalId + ']', details: e.message });
            context.write({
                key:   internalId,
                value: JSON.stringify({ status: 'error', message: e.message })
            });
        }
    }

    function reduce(context) {
        var result = JSON.parse(context.values[0]);
        if (result.status !== 'success' || !result.loopId) return;

        try {
            record.submitFields({
                type:   record.Type.CUSTOMER,
                id:     context.key,
                values: {
                    custentity_loop_customer_id:  result.loopId,
                    custentity_loop_sync_required: false
                }
            });
            log.audit({ title: 'Customer Written Back [' + context.key + ']', details: 'Loop ID: ' + result.loopId });
        } catch (e) {
            log.error({ title: 'Customer Reduce Exception [' + context.key + ']', details: e.message });
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
            title:   'Loop Customers Integration Complete',
            details: 'Success: ' + successCount + ' | Errors: ' + errorCount
        });

        if (summary.mapSummary.error) {
            log.error({ title: 'Customer Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Customer Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
