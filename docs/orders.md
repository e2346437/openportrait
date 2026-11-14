# Quotes, invoices and payments

## Prices

**Settings > Prices** holds your price list (packages and single items) and the defaults for quotes: currency, sales tax rate, how long a quote stays valid, how clients can pay you directly, and your standard terms. Each quote copies the name and price of what you pick, so changing your price list never changes a quote you've already sent.

All amounts are stored as whole cents in one currency.

## Writing a quote

**Orders > New quote** lets you choose the client, add lines (from your price list or typed in), apply a discount, and decide when money is due. By default the client pays once, in full. Tick **Split into a retainer and balance** to set a retainer (30% to start) and give each payment an optional due date. The payments must add up to the total, and the editor tells you what's left over.

- Tax is added to taxable lines at your current rate. A discount reduces the taxable amount in proportion, so tax is only charged on what the client actually pays. The rate is fixed when you save, so a later rate change does not rewrite old quotes.
- A draft can be edited freely. **Send** emails the client a private link, and records it on their timeline.
- A quote that has been sent can be taken back to a draft until the client accepts it.

## What the client sees

The link opens a branded page with the lines, totals and payment schedule. To accept, the client types their full name; this records the name, time and IP address and turns the quote into an **invoice**, keeping the same link. You get an email, and the client gets a confirmation. Quotes expire after the validity period, and the client can also decline.

## Invoices and payments

Open an invoice and choose **Record a payment** for cash, check, Venmo, Zelle, card, bank transfer or other. Payments are applied to the payment schedule in order, so the retainer is settled before the balance. The client gets a receipt by email. A payment can't be more than what is still owed.

Refunds (owner only) are recorded as negative payments, up to what has been paid. An invoice with money on it can't be voided until the money is refunded.

## Paying online with PayPal

Connect PayPal in **Settings > Payments** (owner only). The page walks through creating a PayPal app, pasting the client ID and secret, and adding a webhook. Start in Testing (sandbox) with a sandbox buyer account; switch to Live when you are happy. The money goes straight to your own PayPal account. OpenPortrait never holds it and never sees card numbers.

Once connected, and once your public address is set, an unpaid invoice shows **Pay online** with two buttons: the next payment on the schedule (for example the retainer), and the full balance. The client approves on PayPal's page and comes back to the invoice, which is then marked paid and a receipt is emailed.

- **The webhook is a safety net.** If the client closes the tab after paying, PayPal tells OpenPortrait directly and the payment is still recorded. Every webhook is verified with PayPal before it is believed, and a payment is never recorded twice.
- **Refunds** you make inside PayPal are recorded on the invoice automatically.
- **Currencies without cents** (such as JPY) aren't supported for PayPal checkout yet. Record those payments by hand.
- PayPal sits behind a payment provider interface, so other processors can be added later.

## Coupon codes

Create codes in **Settings > Prices > Coupon codes**. A code takes a percentage or a fixed amount off, and can be limited to one product on your price list, an expiry date, or a number of uses. Codes are saved in capitals, so `spring25` and `SPRING25` are the same.

Type the code into **Coupon code** when you write a quote. The editor shows what it takes off, the client's copy shows it as its own line, and tax is worked out on what they actually pay. It sits next to the hand-typed discount; the two add up.

- A code is checked when you add it: it must exist, be switched on, be unexpired and not used up. A quote that already carries a code keeps it as promised, even if the code expires or runs out afterwards.
- A quote that uses a code counts as one use. Deleting the draft, declining the quote or voiding it gives the use back.
- If you split the payments into a retainer and balance, adjust the amounts to match the new total. OpenPortrait tells you if they don't add up.
- A code that has been used can't be removed from your books. Remove switches it off instead.

## Client credit

Credit is money you owe a client: a gift card, a prepayment, or a refund you chose to keep as credit. It lives on the client's page under **Credit**, with a short history.

- **Add or remove credit** (owner only) from the client's page. Removing is for fixing mistakes and can't take the balance below zero.
- **Use credit on an invoice:** on a sent invoice, press **Use … of their credit**. It is recorded as a payment with the method "Client credit", capped at what is owed.
- **Clients can do it themselves.** If a client has credit, their invoice page shows **Use … of my credit**.
- **Refund as credit:** when you record a refund, choose **Keep as client credit**. The invoice shows the refund and the client's balance goes up by the same amount.
- Credit isn't income when it's added. It becomes a payment on the invoice only when it is used.

For AI assistants, the tools are `coupons_list`, `coupons_create`, `credits_get`, `credits_grant` and `orders_apply_credit`. Creating a coupon, adding credit and using credit change what the studio is paid, so they wait for the owner's approval. `quotes_create_draft` takes an optional `couponCode`.

## For AI assistants

`catalog_list`, `orders_list`, `orders_get` and `quotes_create_draft` are available to assistants. `quotes_send` reaches a client and `orders_record_payment` changes the books, so both wait for the owner's approval.
