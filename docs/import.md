# Importing your data

**Settings > Import data** (owner only) brings clients, shoots, and invoices with their payments into OpenPortrait from a file. It is built for a one-time move from another system, and it works with any CSV or JSON list.

## How it works

1. Choose what you are importing: **Clients**, **Shoots**, or **Invoices and payments**. Import in that order, so shoots and invoices can find their client.
2. Choose a file. A CSV (comma, semicolon or tab separated) or a JSON list of records works.
3. OpenPortrait guesses which column is which from common column names. Change any it got wrong.
4. Read the **Preview**. It runs the real import inside a database transaction and then undoes it, so what it shows is exactly what will happen. Nothing is saved yet.
5. Press **Import**. Rows with a problem are left out and listed with the reason; fix them in the file and import again.

Importing the same file twice never duplicates anything. Each imported row is remembered by the old system's id when the file has one, otherwise by email, name, order number or similar.

## What each import does

| Import | Reads | Notes |
|---|---|---|
| Clients | name, company, email, phone, address, source, tags, notes | A client that already exists (same email, or same name when there is no email) is skipped. Turn on **Update clients I already have** to fill in blank details, add tags and notes. Existing details are never overwritten. |
| Shoots | name, date, type, status, client, notes | Shoot types that don't exist yet are created. Statuses are mapped (for example Pre-Shoot to Booked, Post-Shoot to Editing, Complete and Archived to Complete). The client is found by email or name, or added. Folders are not created for imported shoots. |
| Invoices and payments | order number, title, client, total, payment date, amount, method, status, shoot | Rows with the same order number become one invoice with several payments. If the file has no total, the total is the sum of the payments. Payment methods are mapped (Credit Card to card, and so on). Invoices are saved as sent, or void when the status says void or cancelled. Nothing is emailed to clients. Re-importing a later payments report adds only the new payments. |

## Getting data out of your old system

Most studio systems can export a list of clients, a list of shoots, or a payments report as a CSV file. Use the export that matches each import above. If a system has no export, copy the list into a spreadsheet and use column names like these, which OpenPortrait recognises: First Name, Last Name, Company, Street Address, State/Prov, Zip/Postal Code, Phone (Primary), Referral Source, Shoot Date, Shoot Type, Order Number, Paid On, Paid Via.

Dates may be written 2026-03-14 or 3/14/2026 (month first). Money may include a currency symbol, thousands separators, or parentheses for negatives.

## For developers

- `POST /api/studio/import/preview` and `/commit` take `{ kind, text, source, mapping?, updateExisting? }`. Omit `mapping` to use the automatic guess. `GET /api/studio/import/fields` lists the fields per kind.
- Code is in `apps/server/src/import/` (`csv.ts`, `fields.ts`, `importer.ts`). Remembered rows are in the `import_record` table.

## Exporting your data

Settings > Import and export has a download button for clients, shoots, and invoices with their payments. Each is a CSV file you can open in a spreadsheet or hand to an accountant. The column names are the same ones the importer recognises, so an exported file can be imported again and nothing is duplicated. Only the studio owner can export. For a full copy of everything, including photos and settings, use `openportrait backup` and copy the galleries folder.
