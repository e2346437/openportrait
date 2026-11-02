# Quotes, invoices and payments

## Prices

**Settings > Prices** holds your price list (packages and single items) and the defaults for quotes: currency, sales tax rate, how long a quote stays valid, how clients can pay you directly, and your standard terms. Each quote copies the name and price of what you pick, so changing your price list never changes a quote you've already sent.

All amounts are stored as whole cents in one currency.

## Writing a quote

**Orders > New quote** lets you choose the client, add lines (from your price list or typed in), apply a discount, and decide when money is due. By default the client pays once, in full. Tick **Split into a deposit and balance** to set a deposit (30% to start) and give each payment an optional due date. The payments must add up to the total, and the editor tells you what's left over.

- Tax is added to taxable lines at your current rate. A discount reduces the taxable amount in proportion, so tax is only charged on what the client actually pays. The rate is fixed when you save, so a later rate change does not rewrite old quotes.
- A draft can be edited freely. **Send** emails the client a private link, and records it on their timeline.
- A quote that has been sent can be taken back to a draft until the client accepts it.

## What the client sees

The link opens a branded page with the lines, totals and payment schedule. To accept, the client types their full name; this records the name, time and IP address and turns the quote into an **invoice**, keeping the same link. You get an email, and the client gets a confirmation. Quotes expire after the validity period, and the client can also decline.

## Invoices and payments

Open an invoice and choose **Record a payment** for cash, check, Venmo, Zelle, card, bank transfer or other. Payments are applied to the payment schedule in order, so the deposit is settled before the balance. The client gets a receipt by email. A payment can't be more than what is still owed.

Refunds (owner only) are recorded as negative payments, up to what has been paid. An invoice with money on it can't be voided until the money is refunded.

Online card and PayPal payments, client credit and coupon codes come next and plug into the same invoices.

## For AI assistants

`catalog_list`, `orders_list`, `orders_get` and `quotes_create_draft` are available to assistants. `quotes_send` reaches a client and `orders_record_payment` changes the books, so both wait for the owner's approval.
