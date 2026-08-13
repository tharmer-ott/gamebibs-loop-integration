/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * Fires after an Item Fulfillment is created.
 * Clears custbody_loop_order_id on the parent Sales Order so the Loop Orders
 * MR integration re-syncs it on the next run, picking up the new fulfillment.
 * Loop's PUT /orders endpoint upserts by external_id, so re-syncing is safe —
 * the same Loop order ID is written back after the update.
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    function afterSubmit(context) {
        // Only act on new fulfillments — edits to existing fulfillments don't
        // add new fulfillment records and don't require a re-sync.
        if (context.type !== context.UserEventType.CREATE) return;

        var ffRec = context.newRecord;
        var ffId  = ffRec.id;

        var soId = ffRec.getValue('createdfrom');
        if (!soId) {
            log.audit({
                title:   'Loop UE Fulfillment — No Parent SO [' + ffId + ']',
                details: 'Item Fulfillment has no createdfrom — skipping'
            });
            return;
        }

        // Only clear the Loop ID if the SO has already been synced.
        // If it hasn't, the MR will pick it up on the normal first-sync path.
        try {
            var soFields = search.lookupFields({
                type:    record.Type.SALES_ORDER,
                id:      soId,
                columns: ['custbody_loop_order_id']
            });

            if (!soFields.custbody_loop_order_id) {
                log.audit({
                    title:   'Loop UE Fulfillment — SO Not Yet Synced [FF:' + ffId + ']',
                    details: 'SO ' + soId + ' has no Loop Order ID — no action needed'
                });
                return;
            }

            record.submitFields({
                type:   record.Type.SALES_ORDER,
                id:     soId,
                values: { custbody_loop_order_id: '' }
            });

            log.audit({
                title:   'Loop UE Fulfillment — SO Flagged for Re-sync [FF:' + ffId + ']',
                details: 'SO ' + soId + ' Loop Order ID cleared — will re-sync on next MR run'
            });

        } catch (e) {
            log.error({
                title:   'Loop UE Fulfillment — Failed [FF:' + ffId + ']',
                details: e.message
            });
        }
    }

    return { afterSubmit };
});
