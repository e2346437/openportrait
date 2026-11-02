# Contracts and e-signatures

Send an agreement, have the client sign it online, and keep a signed PDF with a record of who signed and when.

## Templates

Write your wording once under **Settings > Contracts** (owner only). Start from the built-in example if you like, but it is only a starting point: have a lawyer review your agreement before you use it with clients.

A line that starts with `#` becomes a heading. Fields in double braces are filled in for each client:

| Field | Filled with |
|---|---|
| `{{client.name}}`, `{{client.firstName}}` | The client's name |
| `{{client.email}}`, `{{client.phone}}`, `{{client.address}}` | Their contact details |
| `{{studio.name}}`, `{{studio.email}}` | Your studio details from Settings |
| `{{shoot.subject}}`, `{{shoot.type}}`, `{{shoot.date}}` | The linked shoot and its first date |
| `{{order.title}}`, `{{order.total}}` | The linked quote or invoice |
| `{{today}}` | Today's date |

A mistyped field is caught when you save the template. If a field has nothing to fill it (for example `{{shoot.date}}` with no shoot linked), you are told what is missing instead of getting a blank.

## Making and sending a contract

**Contracts > New contract**: pick a client, a template, and optionally a shoot and a quote or invoice. You get a draft with the fields filled in. Read it, edit it if you need to (the change applies to this contract only), then **Send for signature**. The client gets an email with a private link.

A sent contract is locked. To change wording, void it and make a new one.

## What the client does

They open the link, read the agreement, type their full name, choose to type or draw their signature, tick the consent box, and press **Sign agreement**. No account is needed. Afterwards they can download their signed copy, and they also get it by email.

## What is recorded

When someone signs, OpenPortrait saves:

- the signer's typed name, email, and how they signed (typed or drawn);
- the date and time, the IP address and the browser they used;
- the consent wording they agreed to;
- a SHA-256 fingerprint of the exact text. If the stored text no longer matches its fingerprint, signing is refused.

The signed PDF contains the agreement, the signatures, and a separate audit trail page with all of the above. PDFs are stored in `/config/contracts`, so they are included when you back up your config.

Behind Cloudflare, the IP address comes from Cloudflare's header only when the request really arrived through it (see the trusted proxies setting).

## Countersigning

Once the client has signed, the owner can **Countersign as the studio**. The PDF is regenerated with both signatures. A signed contract can't be voided or edited.

## Good to know

- The PDF uses standard PDF fonts, so unusual characters outside Western European languages may not print.
- Electronic signatures are widely accepted, but the rules differ by country. This isn't legal advice.

## For AI assistants

Tools in the `contracts` group: `contract_templates_list`, `contracts_list`, `contracts_get` (read), `contracts_create_draft` (draft), and `contracts_send` (waits for the owner's approval because it reaches a client). Assistants can't sign or countersign.

## Signing before paying (booking pages)

A paid booking page can name an agreement under **Booking pages > Edit > Price and deposit > Agreement to sign first**.

- When someone books, OpenPortrait drafts that agreement for them, links it to the booking's invoice, and puts the signing link in the booking email and on the confirmation page.
- Until it is signed, the invoice page shows "Sign your agreement first" instead of the pay buttons, and online payment and applying credit are refused (409). After signing, the client gets a "Continue to payment" button.
- Staff can still record payments by hand, and voiding the agreement lifts the hold.
- The template may only use fields a booking knows: client name, first name and email, studio name and email, order title and total, and today's date. This is checked when the page is saved.
- Needs a price on the page. Pages with no agreement behave as before.
