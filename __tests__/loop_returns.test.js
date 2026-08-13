import loopReturns from 'SuiteScripts/Loop/loop_returns';
import runtime from 'N/runtime';
import search from 'N/search';
import record from 'N/record';
import https from 'N/https';

const { REFUND, REFUND_WITH_TAX, EXCHANGE_PROCESSED, EXCHANGE_CLOSED, EXCHANGE_CANCELLED } = require('../fixtures/loop_returns.fixtures');

jest.mock('N/runtime');
jest.mock('N/search');
jest.mock('N/record');
jest.mock('N/https');
jest.mock('N/log');

// ---------------------------------------------------------------------------
// Test scaffolding: mock the N/* modules loop_returns depends on.
// ---------------------------------------------------------------------------

// Internal-id rows returned per logical search, keyed by a label derived from the query.
let searchResults;

function makeFakeRecord() {
    return {
        setValue: jest.fn(),
        // Non-zero so createCreditMemo sees an inherited shipping cost worth zeroing, and
        // any other header read (entity, total, ...) still resolves to a truthy value.
        getValue: jest.fn(() => '1'),
        // 'deposit' = the Customer Refund's Deposits-Applied sublist (cap the refund amount);
        // 'apply'   = the Deposit Application's apply sublist (re-apply leftover to invoice).
        // The Credit Memo's item sublist is treated as empty (no non-returned lines to drop).
        getLineCount: jest.fn(({ sublistId } = {}) =>
            (sublistId === 'deposit' || sublistId === 'apply') ? 1 : 0),
        // The deposit line carries plenty of headroom ($200) so the item+tax cap always fits.
        getSublistValue: jest.fn(({ sublistId, fieldId } = {}) =>
            (sublistId === 'deposit' && fieldId === 'amount') ? '200' : ''),
        setSublistValue: jest.fn(),
        // Dynamic-mode reads for the Deposit Application apply sublist: the single line points
        // at invoice '400' (matches searchResults.custinvc) with $5.00 of leftover to apply.
        selectLine: jest.fn(),
        getCurrentSublistValue: jest.fn(({ sublistId, fieldId } = {}) => {
            if (sublistId === 'apply' && fieldId === 'internalid') return '400';
            if (sublistId === 'apply' && fieldId === 'apply') return false;
            if (sublistId === 'apply' && fieldId === 'amount') return '5.00';
            return '';
        }),
        removeLine: jest.fn(),
        selectNewLine: jest.fn(),
        setCurrentSublistValue: jest.fn(),
        commitLine: jest.fn(),
        save: jest.fn(() => 999)
    };
}

// Find the value of a ['type','anyof', X] triple inside a filter array.
function txnTypeOf(filters) {
    let val = null;
    filters.forEach(f => {
        if (Array.isArray(f) && f[0] === 'type' && f[1] === 'anyof') val = f[2];
    });
    return val;
}

function hasField(filters, field) {
    return filters.some(f => Array.isArray(f) && f[0] === field);
}

// Map a search query to one of our result buckets.
function classify(type, filters) {
    if (type === search.Type.ITEM) return 'item';
    if (type === search.Type.SALES_ORDER) {
        if (hasField(filters, 'custbody_loop_order_id')) return 'so_by_loopid';
        if (hasField(filters, 'tranid')) return 'so_by_tranid';
    }
    if (type === search.Type.TRANSACTION) {
        if (hasField(filters, 'custbody_loop_return_id')) return 'idempotency';
        const t = txnTypeOf(filters);
        if (t === 'CustDep') return 'custdep';
        if (t === 'DepAppl') return 'depappl';
        if (t === 'CustInvc') return 'custinvc';
    }
    return 'unknown';
}

beforeEach(() => {
    jest.clearAllMocks();

    searchResults = {
        idempotency:  [],        // not yet processed
        so_by_loopid: ['100'],   // SO internal id
        so_by_tranid: ['100'],
        custdep:      ['200'],   // customer deposit id
        depappl:      ['300'],   // deposit application id
        custinvc:     ['400'],   // invoice id
        item:         ['500']    // exchange item id
    };

    search.Type = { TRANSACTION: 'transaction', SALES_ORDER: 'salesorder', ITEM: 'item' };
    search.createColumn = jest.fn(c => c);
    search.create = jest.fn(({ type, filters }) => ({
        run: () => ({
            each: (cb) => {
                const rows = searchResults[classify(type, filters)] || [];
                for (const id of rows) {
                    const cont = cb({ getValue: () => id });
                    if (cont === false) break;
                }
            }
        })
    }));

    record.Type = {
        DEPOSIT_APPLICATION: 'depositapplication',
        CUSTOMER_DEPOSIT:    'customerdeposit',
        CUSTOMER_REFUND:     'customerrefund',
        INVOICE:             'invoice',
        CREDIT_MEMO:         'creditmemo',
        SALES_ORDER:         'salesorder',
        ITEM_FULFILLMENT:    'itemfulfillment'
    };
    record.transform = jest.fn(() => makeFakeRecord());
    record.create    = jest.fn(() => makeFakeRecord());
    record.load      = jest.fn(() => makeFakeRecord());
    record.delete    = jest.fn();

    https.createSecureString = jest.fn(() => 'secret');
    https.get = jest.fn();

    runtime.getCurrentScript = jest.fn(() => ({
        getParameter: ({ name }) => {
            const params = {
                custscript_loop_returns_lookback: '60',
                custscript_loop_braintree_payment_method: '7'
            };
            return params[name];
        }
    }));
});

function ctx(returnObj) {
    return { value: JSON.stringify(returnObj), write: jest.fn() };
}

const baseRefund = {
    id: 110618442,
    state: 'closed',
    outcome: 'refund',
    order_id: '905736303990636544',
    order_name: 'SO31161',
    refund: '69.95',
    return_total: '69.95',
    line_items: [{ variant_id: '894572213405216768' }],
    exchanges: []
};

const baseExchange = {
    id: 111690353,
    state: 'closed',
    outcome: 'exchange',
    order_id: '905736320977367040',
    order_name: 'SO46',
    return_total: '69.95',
    line_items: [{ variant_id: '894572080864038912' }],
    exchanges: [{ variant_id: '894572080864038912' }]
};

// ---------------------------------------------------------------------------
// Guard / routing behavior
// ---------------------------------------------------------------------------

describe('map — state gate', () => {
    it('skips a cancelled return without creating any records', () => {
        loopReturns.map(ctx({ ...baseRefund, state: 'cancelled' }));

        expect(record.transform).not.toHaveBeenCalled();
        expect(record.create).not.toHaveBeenCalled();
        expect(record.delete).not.toHaveBeenCalled();
    });

    it('skips any non-closed state', () => {
        loopReturns.map(ctx({ ...baseRefund, state: 'open' }));
        expect(record.transform).not.toHaveBeenCalled();
    });
});

describe('map — idempotency', () => {
    it('skips when a tagged transaction already exists', () => {
        searchResults.idempotency = ['9999']; // pretend already processed
        loopReturns.map(ctx(baseRefund));

        expect(record.transform).not.toHaveBeenCalled();
        expect(record.delete).not.toHaveBeenCalled();
    });
});

describe('map — outcome routing', () => {
    it('skips an unknown outcome', () => {
        loopReturns.map(ctx({ ...baseRefund, outcome: 'gift_card' }));
        expect(record.transform).not.toHaveBeenCalled();
        expect(record.create).not.toHaveBeenCalled();
    });

    it('refund flow: deletes deposit application, creates Customer Refund + Credit Memo', () => {
        const c = ctx(baseRefund);
        loopReturns.map(c);

        // deposit application deleted
        expect(record.delete).toHaveBeenCalledWith({ type: 'depositapplication', id: '300' });

        // transformed to both customer refund and credit memo
        const toTypes = record.transform.mock.calls.map(call => call[0].toType);
        expect(toTypes).toContain('customerrefund');
        expect(toTypes).toContain('creditmemo');

        // no new sales order for a refund
        expect(record.create).not.toHaveBeenCalled();

        expect(c.write).toHaveBeenCalledWith(expect.objectContaining({ key: '110618442' }));
    });

    it('exchange flow: open Credit Memo + new SO + Item Fulfillment + new Invoice netted, deposit untouched', () => {
        const c = ctx(baseExchange);
        loopReturns.map(c);

        const toTypes = record.transform.mock.calls.map(call => call[0].toType);
        expect(toTypes).toContain('creditmemo');
        expect(toTypes).toContain('itemfulfillment');
        // new exchange SO is billed to its own invoice, then the credit memo is applied to it
        expect(toTypes).toContain('invoice');

        // new exchange sales order created
        expect(record.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'salesorder' }));
        // credit memo re-loaded to apply it to the new invoice (netting step)
        expect(record.load).toHaveBeenCalledWith(expect.objectContaining({ type: 'creditmemo' }));

        // free reship: default shipping cost overridden to $0 on the exchange SO
        const zeroedShip = record.create.mock.results
            .map(r => r.value)
            .some(rec => rec.setValue.mock.calls.some(([arg]) =>
                arg && arg.fieldId === 'shippingcost' && arg.value === 0));
        expect(zeroedShip).toBe(true);

        // even-money exchange: original payment left alone — no deposit deletion, no cash refund
        expect(record.delete).not.toHaveBeenCalled();
        expect(toTypes).not.toContain('customerrefund');
    });
});

describe('map — sales order resolution', () => {
    it('skips when no SO can be matched', () => {
        searchResults.so_by_loopid = [];
        searchResults.so_by_tranid = [];
        loopReturns.map(ctx(baseRefund));

        expect(record.transform).not.toHaveBeenCalled();
        expect(record.delete).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Real Loop payloads (captured from the GameBibs dev account, all-string values)
// ---------------------------------------------------------------------------

describe('map — real Loop payloads', () => {
    function transformToTypes() {
        return record.transform.mock.calls.map(call => call[0].toType);
    }

    it('REFUND 110618442 (SO31161): deletes deposit application, Customer Refund + Credit Memo, no SO created', () => {
        const c = ctx(REFUND);
        loopReturns.map(c);

        expect(record.delete).toHaveBeenCalledWith({ type: 'depositapplication', id: '300' });
        expect(transformToTypes()).toEqual(expect.arrayContaining(['customerrefund', 'creditmemo']));
        expect(record.create).not.toHaveBeenCalled();
        expect(c.write).toHaveBeenCalledWith({
            key: '110618442',
            value: expect.stringContaining('"status":"success"')
        });
    });

    it('EXCHANGE_PROCESSED 111690353 (SO46): open CM + new SO + Fulfillment + Invoice netted, no refund, deposit untouched', () => {
        const c = ctx(EXCHANGE_PROCESSED);
        loopReturns.map(c);

        const toTypes = transformToTypes();
        expect(toTypes).toEqual(expect.arrayContaining(['creditmemo', 'itemfulfillment', 'invoice']));
        expect(toTypes).not.toContain('customerrefund');
        expect(record.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'salesorder' }));
        expect(record.delete).not.toHaveBeenCalled();

        // exchange SO line is priced from Loop (69.95), not NetSuite's default rate
        const pricedFromLoop = record.create.mock.results
            .map(r => r.value)
            .some(rec => rec.setCurrentSublistValue.mock.calls.some(([arg]) =>
                arg && arg.sublistId === 'item' && arg.fieldId === 'rate' && arg.value === 69.95));
        expect(pricedFromLoop).toBe(true);

        expect(c.write).toHaveBeenCalledWith({
            key: '111690353',
            value: expect.stringContaining('"outcome":"exchange"')
        });
    });

    it('EXCHANGE_CLOSED 111690141 (SO44): closed exchange still runs the exchange flow', () => {
        const c = ctx(EXCHANGE_CLOSED);
        loopReturns.map(c);

        expect(transformToTypes()).toEqual(expect.arrayContaining(['creditmemo', 'itemfulfillment']));
        expect(record.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'salesorder' }));
    });

    it('EXCHANGE_CANCELLED 111690271 (SO45): skipped, no records touched', () => {
        const c = ctx(EXCHANGE_CANCELLED);
        loopReturns.map(c);

        expect(record.transform).not.toHaveBeenCalled();
        expect(record.create).not.toHaveBeenCalled();
        expect(record.delete).not.toHaveBeenCalled();
        expect(c.write).not.toHaveBeenCalled();
    });

    it('REFUND re-run is idempotent: skips when a tagged transaction already exists', () => {
        searchResults.idempotency = ['7777'];
        const c = ctx(REFUND);
        loopReturns.map(c);

        expect(record.transform).not.toHaveBeenCalled();
        expect(record.delete).not.toHaveBeenCalled();
        expect(c.write).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Refund excludes shipping / shipping tax (item + item tax only)
// ---------------------------------------------------------------------------

describe('map — refund excludes shipping', () => {
    // Every record produced by a transform in this run (Customer Refund, Credit Memo, ...).
    function transformRecords() {
        return record.transform.mock.results.map(r => r.value);
    }

    it('REFUND_WITH_TAX 114300080 (SO31166): zeroes the credit memo shipping cost', () => {
        loopReturns.map(ctx(REFUND_WITH_TAX));

        const zeroedShipping = transformRecords().some(rec =>
            rec.setValue.mock.calls.some(([arg]) =>
                arg && arg.fieldId === 'shippingcost' && arg.value === 0));

        expect(zeroedShipping).toBe(true);
    });

    it('REFUND_WITH_TAX 114300080 (SO31166): caps the customer refund to item + item tax (76.77)', () => {
        loopReturns.map(ctx(REFUND_WITH_TAX));

        // 69.95 item + 6.82 tax = 76.77; shipping / shipping tax (0.00 here) are excluded.
        const cappedToItemPlusTax = transformRecords().some(rec =>
            rec.setSublistValue.mock.calls.some(([arg]) =>
                arg && arg.sublistId === 'deposit' && arg.fieldId === 'amount' && arg.value === 76.77));

        expect(cappedToItemPlusTax).toBe(true);
    });

    it('REFUND_WITH_TAX 114300080 (SO31166): re-applies the leftover deposit (shipping) to the invoice', () => {
        const c = ctx(REFUND_WITH_TAX);
        loopReturns.map(c);

        // Step 4: a Deposit Application is transformed from the deposit back onto the invoice,
        // closing the shipping remainder left open by the item+tax-only refund + credit memo.
        const toTypes = record.transform.mock.calls.map(call => call[0].toType);
        expect(toTypes).toContain('depositapplication');

        // and it applies to the matched invoice line ('400'), not left unchecked.
        const appliedToInvoice = transformRecords().some(rec =>
            rec.setCurrentSublistValue.mock.calls.some(([arg]) =>
                arg && arg.sublistId === 'apply' && arg.fieldId === 'apply' && arg.value === true));
        expect(appliedToInvoice).toBe(true);

        expect(c.write).toHaveBeenCalledWith({
            key: '114300080',
            value: expect.stringContaining('"status":"success"')
        });
    });
});

// ---------------------------------------------------------------------------
// getInputData — big-int preservation
// ---------------------------------------------------------------------------

describe('getInputData — 18-digit id preservation', () => {
    it('returns [] on a non-200 response', () => {
        https.get.mockReturnValue({ code: 500, body: 'err' });
        expect(loopReturns.getInputData()).toEqual([]);
    });
});
