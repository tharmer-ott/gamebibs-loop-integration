/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 */
define(['N/runtime', 'N/log'], function (runtime, log) {

    function beforeSubmit(context) {
        if (context.type === context.UserEventType.DELETE) return;

        // When the MR sync script writes back the Loop ID and clears the flag,
        // execution context is MAPREDUCE (not SCHEDULED). Skip re-flagging so
        // the record isn't immediately re-queued for the next sync run.
        var ctx = runtime.executionContext;
        if (ctx === runtime.ContextType.SCHEDULED || ctx === runtime.ContextType.MAPREDUCE) return;

        context.newRecord.setValue({
            fieldId: 'custentity_loop_sync_required',
            value:   true
        });
    }

    return { beforeSubmit };
});
