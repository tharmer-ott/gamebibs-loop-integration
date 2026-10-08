/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * Deployed on Sales Order. Adds an "Exchanged Orders" sublist to the Loop tab listing the
 * exchange Sales Orders whose custbody_loop_exchange_parent points at the order being viewed.
 * The sublist is only added when there is at least one.
 *
 * A native custom sublist can't do this: its Field setting feeds the viewed record's value of
 * that field into the search, so it can match "same parent" but never "parent = this record".
 * Here we load the saved search and add the parent = this-record filter ourselves.
 *
 * Columns come from customsearch_loop_exchange_orders — edit its Results tab to change them.
 *
 * Also hides the Exchange Parent field in view mode when it's empty (i.e. not an exchange order).
 */
define(['N/runtime', 'N/search', 'N/url', 'N/ui/serverWidget', 'N/log'], function (runtime, search, url, serverWidget, log) {

    var SEARCH_ID             = 'customsearch_loop_exchange_orders';
    var EXCHANGE_PARENT_FIELD = 'custbody_loop_exchange_parent';
    var LOOP_TAB_LABEL        = 'Loop';
    var SUBLIST_ID            = 'custpage_loop_exchange_orders';
    var SUBLIST_LABEL         = 'Exchanged Orders';

    // Find the Loop tab's id on this form by its label rather than hard-coding its script id
    // (custtab_...), which the form may not recognise. A tab id the form lacks breaks the page
    // render with NetSuite's generic "unexpected error" — after beforeLoad returns, so the
    // try/catch below can't see it.
    function findTabId(form, label) {
        var ids = form.getTabs();
        for (var i = 0; i < ids.length; i++) {
            var tab = form.getTab({ id: ids[i] });
            if (tab && tab.label === label) return ids[i];
        }
        log.audit({ title: 'Loop Tab Not Found', details: 'Tabs on form: ' + ids.join(', ') });
        return null;
    }

    function beforeLoad(context) {
        log.debug({ title: 'Exchanged Orders beforeLoad', details: 'type=' + context.type + ' | context=' + runtime.executionContext + ' | id=' + context.newRecord.id });
        if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) return;
        if (context.type !== context.UserEventType.VIEW && context.type !== context.UserEventType.EDIT) return;

        var soId = context.newRecord.id;
        if (!soId) return;

        // Never let a search/render problem block the Sales Order from opening.
        try {
            // Edit mode keeps the field visible so it can still be set by hand.
            if (context.type === context.UserEventType.VIEW && !context.newRecord.getValue({ fieldId: EXCHANGE_PARENT_FIELD })) {
                var parentField = context.form.getField({ id: EXCHANGE_PARENT_FIELD });
                if (parentField) parentField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            }

            var s = search.load({ id: SEARCH_ID });
            s.filters.push(search.createFilter({
                name:     EXCHANGE_PARENT_FIELD,
                operator: search.Operator.ANYOF,
                values:   [soId]
            }));
            var columns = s.columns;

            var results = [];
            s.run().each(function (r) { results.push(r); return true; });
            if (!results.length) {
                log.debug({ title: 'Exchanged Orders Sublist [SO ' + soId + ']', details: 'No exchange orders — sublist not added' });
                return;
            }

            var sublistOptions = { id: SUBLIST_ID, type: serverWidget.SublistType.LIST, label: SUBLIST_LABEL };
            var tabId = findTabId(context.form, LOOP_TAB_LABEL);
            if (tabId) sublistOptions.tab = tabId; // otherwise NetSuite's default placement
            var sublist = context.form.addSublist(sublistOptions);
            columns.forEach(function (col, c) {
                sublist.addField({
                    id:    'custpage_loopex_col' + c,
                    type:  serverWidget.FieldType.TEXT,
                    label: col.label || col.name
                });
            });

            results.forEach(function (r, line) {
                columns.forEach(function (col, c) {
                    var val = r.getText(col) || r.getValue(col);
                    if (val === null || val === undefined || val === '') return; // setSublistValue rejects empty values
                    if (col.name === 'tranid') {
                        var href = url.resolveRecord({ recordType: r.recordType, recordId: r.id });
                        val = '<a href="' + href + '">' + val + '</a>';
                    }
                    sublist.setSublistValue({ id: 'custpage_loopex_col' + c, line: line, value: String(val) });
                });
            });
            log.debug({ title: 'Exchanged Orders Sublist [SO ' + soId + ']', details: 'tab=' + tabId + ' | rows=' + results.length });
        } catch (e) {
            log.error({ title: 'Exchanged Orders Sublist Failed [SO ' + soId + ']', details: e.message });
        }
    }

    return { beforeLoad };
});
