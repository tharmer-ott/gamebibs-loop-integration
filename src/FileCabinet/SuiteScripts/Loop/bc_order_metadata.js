/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * BigCommerce order metadata reader (BigCommerce -> NetSuite).
 *
 * STANDALONE / not yet wired into the integration — nothing in the project imports this yet.
 *
 * Given a BigCommerce order id, fetches that order's metafields and returns:
 *
 *   {
 *     session_id: <the `value` of the metafield whose id is 270 (key "session_id")>,
 *     value:      "not-implemented in BC"   // placeholder — not yet sourced from BigCommerce
 *   }
 *
 * The order id passed in is the BigCommerce channel order id. On a NetSuite transaction that
 * value lives in the body field custbody_fa_channel_order, so a caller typically reads it from
 * the record and hands it to getOrderSession().
 *
 * GET https://api.bigcommerce.com/stores/{store_hash}/v3/orders/{order_id}/metafields
 * Docs: https://developer.bigcommerce.com/docs/rest-management/orders/order-metafields
 */
define(['N/https', 'N/log'], function (https, log) {

    var BC_API_BASE   = 'https://api.bigcommerce.com';
    var BC_STORE_HASH = 'v999z6750t';

    // BigCommerce API token.
    // TODO: Move to API Secrets in production prior to implementation
    var BC_API_TOKEN  = '30qp5f1xx8pzkbwbd031wvrmtqjfrt';

    // The BigCommerce order metafield id that carries the Loop session id.
    var SESSION_METAFIELD_ID = 270;

    // TODO: Placeholder for the returned `value` until it is actually sourced from BigCommerce.
    var VALUE_NOT_IMPLEMENTED = 'not-implemented in BC';

    function buildHeaders() {
        return {
            'Accept':       'application/json',
            'Content-Type': 'application/json',
            'X-Auth-Token': BC_API_TOKEN
        };
    }

    /**
     * Fetch a BigCommerce order's metafields and extract the session record.
     *
     * @param {string|number} bcOrderId - BigCommerce order id (sourced from custbody_fa_channel_order).
     * @returns {{ session_id: (string|null), value: string }} session_id is the metafield-270 value,
     *          or null if that metafield is absent; value is always the "not-implemented" placeholder.
     */
    function getOrderSession(bcOrderId) {
        if (bcOrderId == null || bcOrderId === '') {
            throw new Error('bcOrderId is required (source: custbody_fa_channel_order)');
        }

        var url = BC_API_BASE + '/stores/' + BC_STORE_HASH + '/v3/orders/' + bcOrderId + '/metafields';
        var response = https.get({ url: url, headers: buildHeaders() });

        if (response.code != 200) {
            log.error({
                title:   'BigCommerce Order Metafields Error',
                details: 'HTTP ' + response.code + ' | order ' + bcOrderId + ' | ' + response.body
            });
            throw new Error('BigCommerce metafields request failed (HTTP ' + response.code + ') for order ' + bcOrderId);
        }

        var data = (JSON.parse(response.body) || {}).data || [];

        var sessionId = null;
        for (var i = 0; i < data.length; i++) {
            if (data[i] && Number(data[i].id) === SESSION_METAFIELD_ID) {
                sessionId = data[i].value;
                break;
            }
        }

        if (sessionId === null) {
            log.audit({
                title:   'BigCommerce session_id not found',
                details: 'order ' + bcOrderId + ' has no metafield id ' + SESSION_METAFIELD_ID
            });
        }

        return {
            session_id: sessionId,
            value:      VALUE_NOT_IMPLEMENTED
        };
    }

    return { getOrderSession: getOrderSession };
});
