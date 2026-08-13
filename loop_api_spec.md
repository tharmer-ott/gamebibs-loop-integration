# Loop Returns API — Reference Spec
> Source: https://docs.loopreturns.com/api-reference/latest/orders/
> Captured: 2026-05-22
> Use this file as the ground-truth schema when building or debugging API payloads.

---

## Base URL
```
https://api.loopreturns.com/api/v1
```

## Auth Header (all requests)
```
X-Authorization: <api_key>   // scope: Order (write) for order endpoints
```

---

## Shared Types

### MoneySet
```
{
  amount:        integer   // REQUIRED — minor units (cents). e.g. $32.50 = 3250
  currency_code: string    // REQUIRED — default "USD"
}
```

### Address
```
{
  address1:     string   // REQUIRED — max 125 chars
  city:         string   // REQUIRED — max 100 chars
  country_code: string   // REQUIRED — 2-char ISO code (e.g. "US")
  name:         string   // optional — max 100 chars
  company:      string   // optional — max 100 chars
  address2:     string   // optional — max 125 chars
  region:       string   // optional — max 100 chars (state/province)
  postal_code:  string   // optional — max 16 chars
}
```

### OrderDiscount  (used in order_discounts[])
```
{
  discount_type:        enum      // REQUIRED — see values below
  name:                 string    // optional — max 64 chars
  external_id:          string    // optional — max 100 chars
  code:                 string    // optional — max 100 chars
  reason:               string    // optional — max 512 chars
  rate:                 number    // optional/nullable — percentage rate (null for fixed-amount discounts)
  net_adjustment_money: MoneySet  // optional — actual dollar impact of the discount (positive = reduction)
  tax_adjustment_money: MoneySet  // optional — tax impact (use 0/0 when not applicable)
}

discount_type enum values:
  "amount"                  — fixed dollar amount off
  "percentage"              — percentage off
  "bonus"
  "bonus_choice"
  "fixed_price"
  "free"
  "percentage_off_options"
  "price_book_price"
  "total_fixed_price"
```

### OrderLineItemDiscount  (used in line_items[].discounts[])
Same fields as OrderDiscount, plus:
```
  discount_relation: enum   // prereq, entitled, x, y
```

### ShippingLine  (used in shipping_lines[])
```
{
  title:     string
  price:     MoneySet
  discounts: ShippingLineDiscount[]
  tax_lines: TaxLine[]
}
```

### TaxLine
```
{
  title: string    // max 100 chars
  rate:  number
  price: MoneySet
}
```

### Duty
```
{
  hs_code:           string    // max 10 chars
  country_of_origin: string    // max 2 chars
  price:             MoneySet
  tax_lines:         TaxLine[]
}
```

### Fulfillment  (used in fulfillments[])
```
{
  status:                 enum      // optional — success, failure, cancelled, pending, open, error
  external_id:            string    // optional — max 64 chars
  fulfilled_at:           datetime  // optional — ISO 8601; marks line items as returnable
  shipping_carrier:       string    // optional
  location:               { id: integer }  // optional — Loop location ID
  tracking_numbers:       string[]  // optional
  fulfillment_line_items: FulfillmentLineItem[]  // optional
}

FulfillmentLineItem:
{
  external_id:                 string   // optional — unique ID for this fulfillment line
  order_line_item_external_id: string   // optional — matches line_items[].external_id on the order
  quantity:                    integer  // optional
}
```

### Refund  (used in refunds[])
```
{
  external_id: string    // optional
  type:        enum      // optional — line_item, shipping, other
  amount:      MoneySet  // optional
  line_item:   RefundLineItem  // optional
  created_at:  datetime  // optional
  updated_at:  datetime  // optional
}

RefundLineItem:
{
  id:       integer   // Loop line item ID (int64)
  quantity: integer
  restock:  boolean
}
```

---

## PUT /orders  — Upsert Order

Upserts by `external_id`. Creates if not found, updates if found.

### Required Fields
| Field          | Type     | Constraint   |
|----------------|----------|--------------|
| external_id    | string   | max 100 chars|
| name           | string   | max 100 chars|
| status         | enum     | active, archived, cancelled, unknown |
| taxes_included | boolean  |              |
| total_price    | MoneySet |              |
| line_items     | array    |              |

### Optional Fields
| Field                       | Type       | Notes |
|-----------------------------|------------|-------|
| channel / sales_channel     | string     | max 64 — auto-creates channel if missing |
| source                      | string     | max 255 |
| customer                    | object     | see Customer below |
| shipping_address            | Address    | |
| billing_address             | Address    | |
| total_price_presentment     | MoneySet   | |
| total_discounts             | MoneySet   | |
| total_discounts_presentment | MoneySet   | |
| total_taxes                 | MoneySet   | |
| total_taxes_presentment     | MoneySet   | |
| total_shipping              | MoneySet   | |
| total_shipping_presentment  | MoneySet   | |
| order_discounts             | OrderDiscount[] | |
| shipping_lines              | ShippingLine[]  | |
| refunds                     | Refund[]        | |
| fulfillments                | Fulfillment[]   | |
| tags                        | string[]        | |
| created_at                  | datetime        | |
| updated_at                  | datetime        | |

### Customer Object (in request)
Pass either an existing Loop customer ID or external_id (with optional profile fields):
```
{
  id:         integer  // Loop customer ID (int64) — use this if already synced
  // OR
  external_id: string  // max 64 chars
  first_name:  string  // max 50
  last_name:   string  // max 50
  email:       string  // max 255
  phone:       string  // max 30
}
```

### Line Item (CreateLineItem)
```
{
  product:                    { id: integer }  // REQUIRED — Loop product ID (int64)
  unit_price:                 MoneySet         // REQUIRED
  product_variant:            { id: integer }  // optional — Loop variant ID (int64)
  quantity:                   integer          // optional
  unit_price_presentment:     MoneySet         // optional
  unit_discounts:             MoneySet         // optional
  unit_discounts_presentment: MoneySet         // optional
  taxable:                    boolean          // optional
  tax_lines:                  TaxLine[]        // optional
  refunds:                    []               // optional
  discounts:                  OrderLineItemDiscount[]  // optional
  duties:                     Duty[]           // optional
  external_id:                string           // optional — max 64 chars; used to link fulfillments/refunds
}
```

### Response (200 OK)
```
{
  order: {
    id:                          integer (int64)  // Loop-assigned order ID — LARGE, wrap before JSON.parse
    external_id:                 string
    name:                        string
    source:                      string
    channel:                     { id, name }
    customer:                    { id, external_id, first_name, last_name, email, phone }
    status:                      enum
    shipping_address:            Address
    billing_address:             Address
    taxes_included:              boolean
    total_price:                 MoneySet
    total_price_presentment:     MoneySet
    total_discounts:             MoneySet
    total_discounts_presentment: MoneySet
    total_taxes:                 MoneySet
    total_taxes_presentment:     MoneySet
    shipping_lines:              ShippingLine[]
    order_discounts:             OrderDiscount[]
    tags:                        string[]
    refunds:                     Refund[]
    line_items: [
      {
        id:          integer (int64)   // Loop line item ID — needed for refund.line_item.id
        external_id: string            // matches what we sent
        // ... other fields
      }
    ]
    fulfillments:  Fulfillment[]
    created_at:    datetime
    updated_at:    datetime
  }
}
```

> **IMPORTANT — Large Integer Precision:**
> Loop IDs are 18-digit integers that exceed JS float64 precision (2^53 ≈ 9 × 10^15).
> **Receiving:** run `body.replace(/:(\s*)(\d{17,})/g, ':$1"$2"')` before `JSON.parse`.
> **Sending:** use `'__LOOPID__' + id` placeholder strings, then
> `JSON.stringify(payload).replace(/"__LOOPID__(\d+)"/g, '$1')` to emit raw integers.

---

## POST /orders  — Create Order

Same schema as PUT /orders except:
- `external_id` is **optional** (not required)
- Uses POST not PUT
- Always creates a new order (no upsert logic)

---

## Error Responses

| Code | Meaning |
|------|---------|
| 400  | Bad request — not readable/processable |
| 401  | Unauthorized — missing or invalid API key |
| 422  | Validation error — response body lists field-level errors |
| 500  | Server error — payload passed validation but Loop's server failed processing |

---

## GameBibs-Specific Notes

| Item | Value |
|------|-------|
| Loop location ID | `894555345163870208` (hardcoded — only one location) |
| NS custom field — Loop order ID | `custbody_loop_order_id` (text, on SO body) |
| NS custom field — Loop line ID | `custcol_loop_line_id` (text, on SO item lines) |
| NS custom field — Loop customer ID | `custentity_loop_customer_id` (text, on Customer) |
| NS custom field — Loop product ID | `custitem_loop_product_id` (text, on Item) |
| NS custom field — Loop variant ID | `custitem_loop_product_variant_id` (text, on Item) |
| NS custom field — Loop location ID | `custrecord_loop_location_id` (text, on Location) |
| NS custom field — Loop sync required | `custentity_loop_sync_required` (checkbox, on Customer) |
| Date format | NS returns `M/D/YYYY`; Loop requires `YYYY-MM-DDT00:00:00+00:00` |
| Currency | Always USD |
| Discount line item type | `itemtype = 'Discount'` in NS (not filterable — use as column) |
| itemtype filter workaround | `itemtype` is a valid **column** but NOT a valid search **filter** on transaction searches — read it and filter in JS |
