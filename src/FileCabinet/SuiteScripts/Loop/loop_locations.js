/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], function (search, record, https, log) {

    var LOOP_API_URL = 'https://api.loopreturns.com/api/v1';

    function buildHeaders() {
        return {
            'Content-Type':    'application/json',
            'X-Authorization': https.createSecureString({ input: '{custsecret_loop_api_key}' })
        };
    }

    function getInputData() {
        return search.create({
            type: 'location',
            filters: [
                ['isinactive', 'is', 'F']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'name'     }),
                search.createColumn({ name: 'address1' }),
                search.createColumn({ name: 'address2' }),
                search.createColumn({ name: 'city'     }),
                search.createColumn({ name: 'state'    }),
                search.createColumn({ name: 'zip'      }),
                search.createColumn({ name: 'country'  })
            ]
        });
    }

    function map(context) {
        var result     = JSON.parse(context.value);
        var internalId = result.id;
        var values     = result.values;

        var address1    = values.address1 || '';
        var address2    = values.address2 || null;
        var city        = values.city     || '';
        var region      = values.state    || '';
        var postalCode  = values.zip      || '';
        var name        = values.name;

        // country search column returns the ISO code directly (e.g. 'US') — use as-is
        var countryRaw  = values.country;
        var countryCode = (countryRaw && countryRaw.length <= 3) ? countryRaw : 'US';

        var payload = JSON.stringify({
            name:          name,
            status:        'active',
            external_id:   String(internalId),
            sales_channel: 'NetSuite',
            address: {
                name:         name,
                address1:     address1,
                address2:     address2,
                city:         city,
                region:       region,
                postal_code:  postalCode,
                country_code: countryCode
            }
        });

        log.audit({ title: 'Location Map [' + internalId + ']', details: 'Name: ' + name + ' | ' + city + ', ' + region + ' ' + postalCode + ' ' + countryCode });

        if (!address1) {
            log.audit({ title: 'Location Skipped [' + internalId + ']', details: 'No address1 — skipping ' + name });
            return;
        }

        try {
            // PUT upserts by external_id — works for both create and update
            var response = https.put({
                url:     LOOP_API_URL + '/locations',
                headers: buildHeaders(),
                body:    payload
            });

            if (response.code === 200 || response.code === 201) {
                // Wrap large integers before JSON.parse to avoid float64 precision loss
                var safeBody       = response.body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"');
                var locationBody   = JSON.parse(safeBody);
                var loopLocationId = locationBody.location ? String(locationBody.location.id) : null;
                log.audit({
                    title:   'Location Synced [' + internalId + ']',
                    details: 'Name: ' + name + ' | Loop ID: ' + loopLocationId
                });
                context.write({
                    key:   internalId,
                    value: JSON.stringify({ loopId: loopLocationId, status: 'success' })
                });
            } else {
                log.error({
                    title:   'Loop Location API Error',
                    details: 'NS ID: ' + internalId + ' | HTTP ' + response.code + ' | ' + response.body
                });
                context.write({
                    key:   internalId,
                    value: JSON.stringify({ status: 'error', code: response.code })
                });
            }
        } catch (e) {
            log.error({ title: 'Location Map Exception [' + internalId + ']', details: e.message });
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
                type:   'location',
                id:     context.key,
                values: { custrecord_loop_location_id: result.loopId }
            });
            log.audit({ title: 'Location Written Back [' + context.key + ']', details: 'Loop ID: ' + result.loopId });
        } catch (e) {
            log.error({ title: 'Location Reduce Exception [' + context.key + ']', details: e.message });
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
            title:   'Loop Locations Integration Complete',
            details: 'Success: ' + successCount + ' | Errors: ' + errorCount
        });

        if (summary.mapSummary.error) {
            log.error({ title: 'Location Map Stage Error', details: summary.mapSummary.error });
        }
        summary.mapSummary.errors.iterator().each(function (key, err) {
            log.error({ title: 'Location Map Key Error [' + key + ']', details: err });
            return true;
        });
    }

    return { getInputData, map, reduce, summarize };
});
