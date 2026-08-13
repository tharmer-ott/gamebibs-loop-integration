/**
 * Real Loop "Detailed Returns List" payloads captured from the GameBibs dev account.
 *
 * NOTE: Loop returns every value as a JSON string — including ids and money — so these
 * fixtures intentionally keep ids/amounts quoted to mirror production exactly.
 */

// outcome=refund, state=closed (SO31161)
const REFUND = {
    id: '110618442',
    created_at: '2026-06-01 16:47:30',
    updated_at: '2026-06-10 17:47:00',
    order_id: '902113595702927360',
    order_name: 'SO31161',
    state: 'closed',
    outcome: 'refund',
    currency: 'USD',
    exchange: '0.00',
    refund: '69.95',
    return_product_total: '69.95',
    return_tax_total: '0.00',
    return_total: '69.95',
    return_credit_total: '0.00',
    line_items: [{
        provider_line_item_id: '902113595853922304',
        line_item_id: '386954885',
        product_id: '894572213384245248',
        variant_id: '894572213405216768',
        sku: 'GBA-19 : GBA-19-0004',
        price: '69.95',
        tax: '0.00',
        refund: '69.95',
        refund_tax: '0.00',
        refund_item: '69.95',
        outcome: 'default'
    }],
    exchanges: []
};

// outcome=refund, state=closed, item + item tax, zero shipping (SO31166)
// Captured 2026-07-09. Unlike REFUND above this return carries tax, so it exercises the
// "refund item + its tax, exclude shipping / shipping tax" rule.
const REFUND_WITH_TAX = {
    id: '114300080',
    created_at: '2026-07-08 23:52:29',
    updated_at: '2026-07-09 00:14:00',
    order_id: '915616032643182592',
    order_name: 'SO31166',
    state: 'closed',
    outcome: 'refund',
    currency: 'USD',
    exchange: '0.00',
    refund: '76.77',
    refund_shipping_total: '0.00',
    refund_shipping_tax_total: '0.00',
    return_product_total: '69.95',
    return_discount_total: '0.00',
    return_tax_total: '6.82',
    return_total: '76.77',
    handling_fee: '0.00',
    return_credit_total: '0.00',
    line_items: [{
        provider_line_item_id: '915616032760623104',
        line_item_id: '399951730',
        product_id: '894572208478773248',
        variant_id: '907608305344581632',
        sku: 'GBA-19 : GBA-19-0004',
        price: '69.95',
        tax: '6.82',
        refund: '76.77',
        refund_tax: '6.82',
        refund_item: '69.95',
        refund_shipping: '0.00',
        refund_shipping_tax: '0.00',
        outcome: 'default'
    }],
    exchanges: []
};

// outcome=exchange, state=closed, "processed exchange" (SO46)
const EXCHANGE_PROCESSED = {
    id: '111690353',
    created_at: '2026-06-11 19:16:03',
    updated_at: '2026-06-16 15:18:23',
    order_id: '905736320977367040',
    order_name: 'SO46',
    state: 'closed',
    outcome: 'exchange',
    currency: 'USD',
    exchange: '69.95',
    refund: '0.00',
    return_total: '69.95',
    return_credit_total: '69.95',
    exchange_total: '69.95',
    line_items: [{
        provider_line_item_id: '905736321086418944',
        line_item_id: '390553625',
        product_id: '894572080843067392',
        variant_id: '894572080864038912',
        sku: 'GBA-07 : GBA-07-0006',
        price: '69.95',
        tax: '0.00',
        outcome: 'default'
    }],
    exchanges: [{
        exchange_id: '42598777',
        product_id: '894572080843067392',
        variant_id: '894572080864038912',
        sku: 'GBA-07 : GBA-07-0006',
        type: 'exchange',
        price: '69.95',
        tax: '0.00',
        total: '69.95'
    }]
};

// outcome=exchange, state=closed, "closed exchange" (SO44)
const EXCHANGE_CLOSED = {
    id: '111690141',
    created_at: '2026-06-11 19:14:09',
    updated_at: '2026-06-16 15:16:02',
    order_id: '905736303990636544',
    order_name: 'SO44',
    state: 'closed',
    outcome: 'exchange',
    currency: 'USD',
    exchange: '64.95',
    refund: '0.00',
    return_total: '64.95',
    return_credit_total: '64.95',
    exchange_total: '64.95',
    line_items: [{
        provider_line_item_id: '905736304108077056',
        line_item_id: '390553076',
        product_id: '894572066670968832',
        variant_id: '894572066687746048',
        sku: 'GBA-06 : GBA-06-0003',
        price: '64.95',
        tax: '0.00',
        outcome: 'default'
    }],
    exchanges: [{
        exchange_id: '42598707',
        product_id: '894572066670968832',
        variant_id: '894572066687746048',
        sku: 'GBA-06 : GBA-06-0003',
        type: 'exchange',
        price: '64.95',
        tax: '0.00',
        total: '64.95'
    }]
};

// outcome=exchange, state=cancelled (SO45) — must be skipped
const EXCHANGE_CANCELLED = {
    id: '111690271',
    created_at: '2026-06-11 19:15:20',
    updated_at: '2026-06-16 15:24:14',
    order_id: '905736312344870912',
    order_name: 'SO45',
    state: 'cancelled',
    outcome: 'exchange',
    currency: 'USD',
    exchange: '69.95',
    refund: '0.00',
    return_total: '0.00',
    return_credit_total: '0.00',
    exchange_total: '0.00',
    line_items: [{
        provider_line_item_id: '905736312479088640',
        line_item_id: '390553468',
        product_id: '894572077270593536',
        variant_id: '894572077295759360',
        sku: 'GBA-07 : GBA-07-0003',
        price: '69.95',
        tax: '0.00',
        outcome: 'default'
    }],
    exchanges: [{
        exchange_id: '42598760',
        product_id: '894572077270593536',
        variant_id: '894572077295759360',
        sku: 'GBA-07 : GBA-07-0003',
        type: 'exchange',
        price: '69.95',
        tax: '0.00',
        total: '69.95'
    }]
};

module.exports = { REFUND, REFUND_WITH_TAX, EXCHANGE_PROCESSED, EXCHANGE_CLOSED, EXCHANGE_CANCELLED };
