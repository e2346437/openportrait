export type ImportKind = "contacts" | "shoots" | "invoices";

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  /** Header names (compared ignoring case, spaces and punctuation) that fill this field automatically. */
  aliases: string[];
}

const f = (key: string, label: string, aliases: string[], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, aliases, ...extra });

export const FIELDS: Record<ImportKind, FieldDef[]> = {
  contacts: [
    f("externalId", "ID in the old system", ["id", "contactid", "clientid"], { hint: "Optional. Lets you re-import the same file without duplicates." }),
    f("firstName", "First name", ["firstname", "first", "givenname"]),
    f("lastName", "Last name", ["lastname", "last", "surname", "familyname"]),
    f("company", "Company", ["company", "organization", "business"]),
    f("email", "Email", ["email", "emailaddress", "primaryemail", "email1"]),
    f("phone", "Phone", ["phone", "phoneprimary", "phonenumber", "mobile", "cell"]),
    f("addressLine1", "Street address", ["streetaddress", "address", "address1", "street"]),
    f("addressLine2", "Street address 2", ["streetaddress2", "address2"]),
    f("city", "City", ["city", "town"]),
    f("region", "State / province", ["stateprov", "state", "province", "region"]),
    f("postalCode", "Zip / postal code", ["zippostalcode", "zip", "postalcode", "postcode"]),
    f("country", "Country", ["country"]),
    f("source", "Where they found you", ["referralsource", "leadsource", "source", "howdidyouhearaboutus"]),
    f("tags", "Tags", ["tags", "tag", "labels"], { hint: "Separate several with commas or semicolons." }),
    f("notes", "Notes", ["notes", "note", "comments"]),
  ],
  shoots: [
    f("externalId", "ID in the old system", ["id", "shootid", "projectid"]),
    f("name", "Shoot name", ["name", "shootname", "title", "project"], { required: true }),
    f("date", "Shoot date", ["date", "shootdate", "eventdate"]),
    f("type", "Shoot type", ["type", "shoottype", "category"]),
    f("status", "Status", ["status", "shootstatus"]),
    f("firstName", "Client first name", ["firstname", "clientfirstname", "first"]),
    f("lastName", "Client last name", ["lastname", "clientlastname", "last"]),
    f("email", "Client email", ["email", "clientemail", "emailaddress"]),
    f("notes", "Notes", ["notes", "note", "comments"]),
  ],
  invoices: [
    f("externalId", "ID in the old system", ["id", "invoiceid"]),
    f("orderNumber", "Order or invoice number", ["ordernumber", "order", "invoice", "invoicenumber", "number"], { required: true, hint: "Rows with the same number become one invoice with several payments." }),
    f("title", "Title", ["title", "ordername", "name", "attached", "description"]),
    f("firstName", "Client first name", ["firstname", "first"]),
    f("lastName", "Client last name", ["lastname", "last"]),
    f("company", "Client company", ["company"]),
    f("email", "Client email", ["email", "emailaddress"]),
    f("shoot", "Shoot it belongs to", ["attached", "shoot", "shootname", "project"], { hint: "Matched to a shoot by name when one exists." }),
    f("total", "Invoice total", ["total", "invoicetotal", "ordertotal"], { hint: "Leave unmapped to use the sum of the payments." }),
    f("created", "Invoice date", ["created", "invoicedate", "orderdate", "date"]),
    f("paidOn", "Payment date", ["paidon", "paymentdate", "datepaid", "date"]),
    f("amount", "Payment amount", ["amount", "paid", "paymentamount"]),
    f("method", "Payment method", ["paymentmethod", "method", "paidvia"]),
    f("status", "Status", ["status", "invoicestatus"], { hint: "Void or cancelled invoices are imported as void." }),
  ],
};

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Picks a header for each field by name. Each header is used once, earlier fields win. */
export function autoMap(kind: ImportKind, headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const field of FIELDS[kind]) {
    const hit = headers.find((h) => !used.has(h) && field.aliases.includes(norm(h)));
    if (hit) {
      map[field.key] = hit;
      used.add(hit);
    }
  }
  return map;
}

// ---- value readers ----

export function parseMoneyCents(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return null;
  // 1.234,56 (European) vs 1,234.56
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/** Reads 2026-03-14, 3/14/2026, 3/14/26 and "March 14, 2026" as YYYY-MM-DD. Slash dates are month first. */
export function parseYmd(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) {
    [m, d, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else {
    const t = Date.parse(`${s} UTC`);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  const iso = `${String(y!).padStart(4, "0")}-${String(m!).padStart(2, "0")}-${String(d!).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function mapMethod(raw: string): "cash" | "check" | "card" | "venmo" | "zelle" | "paypal" | "bank" | "other" {
  const s = norm(raw);
  if (s.includes("cash")) return "cash";
  if (s.includes("check") || s.includes("cheque")) return "check";
  if (s.includes("venmo")) return "venmo";
  if (s.includes("zelle")) return "zelle";
  if (s.includes("paypal")) return "paypal";
  if (s.includes("card") || s.includes("stripe") || s.includes("square")) return "card";
  if (s.includes("bank") || s.includes("ach") || s.includes("wire") || s.includes("transfer")) return "bank";
  return "other";
}

export function mapShootStatus(raw: string): "booked" | "shot" | "editing" | "delivered" | "complete" | "cancelled" {
  const s = norm(raw);
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("postshoot") || s.includes("edit")) return "editing";
  if (s.includes("deliver")) return "delivered";
  if (s.includes("shot")) return "shot";
  if (s.includes("complete") || s.includes("archiv") || s.includes("done")) return "complete";
  return "booked";
}
