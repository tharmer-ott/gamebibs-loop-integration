/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
    'N/runtime',
    'N/log',
    './loop_customers',
    './loop_products',
    './loop_locations',
    './loop_inventory',
    './loop_orders'
], function (runtime, log, customers, products, locations, inventory, orders) {

    var INTEGRATIONS = {
        customers:  customers,
        products:   products,
        locations:  locations,
        inventory:  inventory,
        orders:     orders
    };

    function getIntegration() {
        var param = runtime.getCurrentScript().getParameter({ name: 'custscript_loop_run_integration' });

        if (!param) throw new Error('custscript_loop_run_integration parameter is required.');

        var integration = INTEGRATIONS[param];
        if (!integration) throw new Error('Unknown integration: "' + param + '". Valid values: ' + Object.keys(INTEGRATIONS).join(', '));

        return integration;
    }

    function getInputData() {
        var param = runtime.getCurrentScript().getParameter({ name: 'custscript_loop_run_integration' });
        log.audit({ title: 'Loop MR Integration Started', details: 'Running integration: ' + param });
        return getIntegration().getInputData();
    }

    function map(context) {
        getIntegration().map(context);
    }

    function reduce(context) {
        getIntegration().reduce(context);
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error({ title: 'Loop MR Input Stage Error', details: summary.inputSummary.error });
        }
        getIntegration().summarize(summary);
    }

    return { getInputData, map, reduce, summarize };
});
