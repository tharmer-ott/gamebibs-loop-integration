/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/runtime', 'N/task', 'N/redirect', 'N/log'], (runtime, task, redirect, log) => {

    const MR_SCRIPT_ID = 'customscript_loop_mr_integration';
    const MR_DEPLOY_ID = 'customdeploy_loop_mr_integration';

    // Internal ID of the MR script record — fill in after first deploy
    // Found at: Customization > Scripting > Scripts > Loop MR Integration
    const MR_PRIMARY_KEY = 'TODO';

    // Returns runs as its own standalone MR script (not dispatched through the shared MR);
    // its entry carries an explicit scriptId/deploymentId and no integration param.
    const DISPATCH = {
        customdeploy_loop_sl_returns:   { scriptId: 'customscript_loop_returns', deploymentId: 'customdeploy_loop_returns_dply' },
        customdeploy_loop_sl_orders:    { integration: 'orders'    },
        customdeploy_loop_sl_customers: { integration: 'customers' },
        customdeploy_loop_sl_products:  { integration: 'products'  },
        customdeploy_loop_sl_inventory: { integration: 'inventory' },
        customdeploy_loop_sl_locations: { integration: 'locations' }
    };

    function kickoffMr(cfg) {
        // Dedicated MR (e.g. returns): launch its own script/deployment with no params.
        if (cfg.scriptId) {
            return task.create({
                taskType:     task.TaskType.MAP_REDUCE,
                scriptId:     cfg.scriptId,
                deploymentId: cfg.deploymentId
            }).submit();
        }

        // Shared MR: launch with the integration selector param.
        return task.create({
            taskType:     task.TaskType.MAP_REDUCE,
            scriptId:     MR_SCRIPT_ID,
            deploymentId: MR_DEPLOY_ID,
            params:       { custscript_loop_run_integration: cfg.integration }
        }).submit();
    }

    const onRequest = (scriptContext) => {
        const deploymentId = runtime.getCurrentScript().deploymentId;
        const cfg          = DISPATCH[deploymentId];

        if (!cfg) {
            log.error({
                title:   'Loop Suitelet',
                details: 'No handler configured for deployment: ' + deploymentId
            });
            scriptContext.response.write('Integration not configured for deployment: ' + deploymentId);
            return;
        }

        const label = cfg.integration || cfg.scriptId;

        try {
            const taskId = kickoffMr(cfg);
            log.audit({
                title:   'Loop MR Task Submitted',
                details: 'Integration: ' + label + ' | Task ID: ' + taskId
            });

            // The MR status page needs the SCRIPT record's numeric internal id as `primarykey`.
            // We only have that for the shared MR (MR_PRIMARY_KEY). The dedicated returns script
            // has its own id we don't track here, and the shared key is still the 'TODO'
            // placeholder — redirecting with either throws NetSuite's generic error page. So for
            // the dedicated case (or an unfilled key), just confirm the launch instead.
            if (cfg.scriptId || !MR_PRIMARY_KEY || MR_PRIMARY_KEY === 'TODO') {
                scriptContext.response.write(
                    label + ' sync submitted (Task ID: ' + taskId + '). ' +
                    'Open the script\'s Execution Log to watch progress.'
                );
                return;
            }

            redirect.redirect({
                url: '/app/common/scripting/mapreducescriptstatus.nl',
                parameters: {
                    date:       'TODAY',
                    primarykey: MR_PRIMARY_KEY
                }
            });

        } catch (ex) {
            log.error({
                title:   'Loop Suitelet Error [' + label + ']',
                details: ex.message
            });
            scriptContext.response.write('Failed to start ' + label + ' sync: ' + ex.message);
        }
    };

    return { onRequest };
});
