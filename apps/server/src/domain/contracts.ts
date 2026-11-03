import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName, logActivity } from "./contacts.js";
import { DomainError, linkTo, newId, notFound, type ServiceContext } from "./context.js";
import { composeEmail, queueEmail } from "./email.js";
import { formatMoney } from "./money.js";
import { renderContractPdf } from "./contract-pdf.js";
import { escapeHtml, htmlToText, isHtml, sanitizeRich } from "./richtext.js";

const { contract, contractTemplate, contact, shoot, shootEvent, shootType, order, user } = tables;

export type ContractRow = typeof contract.$inferSelect;

/** The merge fields a template may use, with what each means. Shown in the editor. */
export const MERGE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "client.name", label: "Client's full name" },
  { key: "client.firstName", label: "Client's first name" },
  { key: "client.email", label: "Client's email" },
  { key: "client.phone", label: "Client's phone" },
  { key: "client.address", label: "Client's address" },
  { key: "studio.name", label: "Your studio name" },
  { key: "studio.email", label: "Your studio email" },
  { key: "studio.phone", label: "Your studio phone" },
  { key: "studio.address", label: "Your studio's physical address" },
  { key: "studio.mailingAddress", label: "Your studio's mailing address" },
  { key: "shoot.subject", label: "The shoot's name" },
  { key: "shoot.type", label: "The type of shoot" },
  { key: "shoot.date", label: "The shoot's first date" },
  { key: "order.title", label: "The linked quote or invoice's title" },
  { key: "order.total", label: "The linked quote or invoice's total" },
  { key: "today", label: "Today's date" },
];
const KNOWN = new Set(MERGE_FIELDS.map((f) => f.key.toLowerCase()));
const FIELD = /\{\{\s*([A-Za-z.]+)\s*\}\}/g;

/** "12 Harbor St, Suite 2, Portland, ME 04101", or null when nothing is filled in. */
function oneLine(a: { street: string; unit: string; city: string; state: string; postal: string } | null | undefined): string | null {
  if (!a) return null;
  const region = [a.state, a.postal].filter(Boolean).join(" ");
  const line = [a.street, a.unit, a.city, region].filter(Boolean).join(", ");
  return line || null;
}

export const CONSENT = "I have read this agreement and agree to be legally bound by it. I understand that typing my name or drawing my signature here is the same as signing on paper.";

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const tzOf = (ctx: ServiceContext) => ctx.settings.get("studio.timezone") ?? "UTC";
const cur = (ctx: ServiceContext) => ctx.settings.get("money.currency") || "USD";

/** Fields used in some text that this app doesn't know, so a typo is caught when the template is saved. */
export function unknownFields(text: string): string[] {
  return [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!).filter((k) => !KNOWN.has(k.toLowerCase())))];
}

/** Tidies wording on its way in: plain text keeps its lines, formatted text is cleaned down to the allowed markup. */
function clean(text: string): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  return isHtml(t) ? sanitizeRich(t) : t;
}

// ---- templates ----

export function listTemplates(ctx: ServiceContext, includeArchived = false) {
  return ctx.db.select().from(contractTemplate).where(includeArchived ? undefined : sql`${contractTemplate.archivedAt} is null`).orderBy(asc(sql`lower(${contractTemplate.name})`)).all();
}

function checkTemplate(input: { name: string; body: string }) {
  const name = input.name.trim();
  const body = clean(input.body);
  if (!name) throw new DomainError("invalid", "Give the template a name, like “Wedding agreement”.");
  if (!body || (isHtml(body) && !htmlToText(body))) throw new DomainError("invalid", "Write the contract wording.");
  if (body.length > 60_000) throw new DomainError("invalid", "That's too long for one contract.");
  const bad = unknownFields(body);
  if (bad.length) throw new DomainError("invalid", `${bad.map((b) => `{{${b}}}`).join(", ")} isn't a field OpenPortrait knows. Check the spelling against the list of fields.`);
  return { name: name.slice(0, 120), body };
}

export function createTemplate(ctx: ServiceContext, input: { name: string; body: string }) {
  const v = checkTemplate(input);
  const id = newId();
  ctx.db.insert(contractTemplate).values({ id, ...v }).run();
  return ctx.db.select().from(contractTemplate).where(eq(contractTemplate.id, id)).get()!;
}

export function updateTemplate(ctx: ServiceContext, id: string, input: { name: string; body: string }) {
  if (!ctx.db.select({ id: contractTemplate.id }).from(contractTemplate).where(eq(contractTemplate.id, id)).get()) throw notFound("Template");
  ctx.db.update(contractTemplate).set({ ...checkTemplate(input), updatedAt: new Date() }).where(eq(contractTemplate.id, id)).run();
  return ctx.db.select().from(contractTemplate).where(eq(contractTemplate.id, id)).get()!;
}

export function archiveTemplate(ctx: ServiceContext, id: string, archived: boolean) {
  if (!ctx.db.select({ id: contractTemplate.id }).from(contractTemplate).where(eq(contractTemplate.id, id)).get()) throw notFound("Template");
  ctx.db.update(contractTemplate).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(contractTemplate.id, id)).run();
  return { ok: true };
}

// ---- making contracts ----

function values(ctx: ServiceContext, c: { contactId: string; shootId?: string | null; orderId?: string | null }) {
  const cl = ctx.db.select().from(contact).where(eq(contact.id, c.contactId)).get();
  if (!cl) throw notFound("Contact");
  const sh = c.shootId ? ctx.db.select({ subject: shoot.subject, type: shootType.name, id: shoot.id }).from(shoot).innerJoin(shootType, eq(shootType.id, shoot.shootTypeId)).where(eq(shoot.id, c.shootId)).get() : undefined;
  if (c.shootId && !sh) throw notFound("Shoot");
  const first = sh ? ctx.db.select({ at: sql<number | null>`min(${shootEvent.startsAt})` }).from(shootEvent).where(eq(shootEvent.shootId, sh.id)).get()?.at : null;
  const od = c.orderId ? ctx.db.select().from(order).where(eq(order.id, c.orderId)).get() : undefined;
  if (c.orderId && !od) throw notFound("That quote or invoice");
  const tz = tzOf(ctx);
  const long = (ms: number) => new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: tz }).format(ms);
  const address = [cl.addressLine1, cl.addressLine2, [cl.city, cl.region].filter(Boolean).join(", "), cl.postalCode, cl.country].filter(Boolean).join(", ");
  const m: Record<string, string | null> = {
    "client.name": displayName(cl),
    "client.firstname": cl.firstName || null,
    "client.email": cl.email,
    "client.phone": cl.phone,
    "client.address": address || null,
    "studio.name": ctx.settings.get("studio.name") || null,
    "studio.email": ctx.settings.get("studio.email") || null,
    "studio.phone": ctx.settings.get("studio.phone") || null,
    "studio.address": oneLine(ctx.settings.get("studio.physicalAddress")),
    "studio.mailingaddress": oneLine(ctx.settings.get("studio.mailingAddress") ?? ctx.settings.get("studio.physicalAddress")),
    "shoot.subject": sh?.subject ?? null,
    "shoot.type": sh?.type ?? null,
    "shoot.date": first ? long(Number(first)) : null,
    "order.title": od?.title ?? null,
    "order.total": od ? formatMoney(od.totalCents, cur(ctx)) : null,
    today: long(Date.now()),
  };
  return { m, contact: cl };
}

/** Fills in the merge fields. A field with nothing to fill it is an error that says what is missing, never a blank. */
export function render(ctx: ServiceContext, text: string, c: { contactId: string; shootId?: string | null; orderId?: string | null }): string {
  const bad = unknownFields(text);
  if (bad.length) throw new DomainError("invalid", `${bad.map((b) => `{{${b}}}`).join(", ")} isn't a field OpenPortrait knows.`);
  const { m } = values(ctx, c);
  const missing = new Set<string>();
  const html = isHtml(text);
  const out = text.replace(FIELD, (_all, key: string) => {
    const v = m[key.toLowerCase()];
    if (!v) missing.add(key);
    return html ? escapeHtml(v ?? "") : (v ?? "");
  });
  if (missing.size) {
    const hint = (k: string) => (k.startsWith("shoot.") ? "link a shoot" : k.startsWith("order.") ? "link a quote or invoice" : `add the ${k.replace("client.", "client's ").replace("studio.", "studio ")} first`);
    throw new DomainError("invalid", `Couldn't fill in ${[...missing].map((k) => `{{${k}}}`).join(", ")}: ${[...missing].map(hint).join("; ")}, or remove the field.`);
  }
  return out;
}

/** Fields a booking page's contract may use: only things known before any shoot exists. */
const BOOKING_FIELDS = new Set(["client.name", "client.firstname", "client.email", "studio.name", "studio.email", "studio.phone", "studio.address", "studio.mailingaddress", "order.title", "order.total", "today"]);

/** Checked when a booking page is saved, so a booking never fails later because a field can't be filled. */
export function assertBookingTemplate(ctx: ServiceContext, templateId: string) {
  const t = ctx.db.select().from(contractTemplate).where(eq(contractTemplate.id, templateId)).get();
  if (!t || t.archivedAt) throw new DomainError("invalid", "Choose a contract template that isn't archived.");
  const bad = [...new Set([...t.body.matchAll(FIELD)].map((m) => m[1]!.toLowerCase()))].filter((k) => !BOOKING_FIELDS.has(k));
  if (bad.length) throw new DomainError("invalid", `${t.name} uses ${bad.map((b) => `{{${b}}}`).join(", ")}, which a booking page can't fill in yet. Use client name, client email, studio, order or date fields.`);
}

/** If the invoice needs a contract that isn't signed yet, says where to sign. Null means nothing stands in the way. */
export function requiredContract(ctx: ServiceContext, o: { requiredContractId: string | null }) {
  if (!o.requiredContractId) return null;
  const c = ctx.db.select().from(contract).where(eq(contract.id, o.requiredContractId)).get();
  if (!c || c.status === "signed" || c.status === "void") return null;
  return { title: c.title, url: linkTo(ctx, `/c/${c.token}`) };
}

function rowOf(ctx: ServiceContext, id: string): ContractRow {
  const c = ctx.db.select().from(contract).where(eq(contract.id, id)).get();
  if (!c) throw notFound("That contract");
  return c;
}

export function byToken(ctx: ServiceContext, token: string): ContractRow {
  const c = ctx.db.select().from(contract).where(eq(contract.token, token)).get();
  if (!c || c.status === "draft") throw notFound("This page");
  return c;
}

export interface ContractInput {
  contactId: string;
  templateId?: string | null;
  title?: string;
  body?: string;
  shootId?: string | null;
  orderId?: string | null;
}

export function createContract(ctx: ServiceContext, input: ContractInput) {
  const tpl = input.templateId ? ctx.db.select().from(contractTemplate).where(eq(contractTemplate.id, input.templateId)).get() : null;
  if (input.templateId && !tpl) throw notFound("Template");
  const raw = clean(input.body ?? tpl?.body ?? "");
  const title = (input.title ?? tpl?.name ?? "").trim();
  if (!title) throw new DomainError("invalid", "Give the contract a title.");
  if (!raw) throw new DomainError("invalid", "Choose a template or write the wording.");
  const body = render(ctx, raw, input);
  const id = newId();
  ctx.db.insert(contract).values({ id, templateId: tpl?.id ?? null, contactId: input.contactId, shootId: input.shootId ?? null, orderId: input.orderId ?? null, title: title.slice(0, 200), body, bodyHash: hash(body), token: crypto.randomBytes(24).toString("base64url") }).run();
  const c = rowOf(ctx, id);
  logActivity(ctx, { contactId: c.contactId, kind: "contract.created", summary: `Contract drafted: ${c.title}`, shootId: c.shootId });
  return view(ctx, c);
}

export function updateDraft(ctx: ServiceContext, id: string, input: { title: string; body: string }) {
  const c = rowOf(ctx, id);
  if (c.status !== "draft") throw new DomainError("locked", "Only a draft can be edited. Void it and make a new one.");
  const title = input.title.trim();
  if (!title) throw new DomainError("invalid", "Give the contract a title.");
  const body = render(ctx, clean(input.body), c);
  if (!body || (isHtml(body) && !htmlToText(body))) throw new DomainError("invalid", "The contract is empty.");
  ctx.db.update(contract).set({ title: title.slice(0, 200), body, bodyHash: hash(body), updatedAt: new Date() }).where(eq(contract.id, id)).run();
  return view(ctx, rowOf(ctx, id));
}

export function deleteDraft(ctx: ServiceContext, id: string) {
  if (rowOf(ctx, id).status !== "draft") throw new DomainError("locked", "Only a draft can be deleted. Void anything that has been sent.");
  ctx.db.delete(contract).where(eq(contract.id, id)).run();
  return { ok: true };
}

// ---- viewing ----

function stateOf(c: ContractRow): "draft" | "sent" | "signed" | "countersigned" | "void" {
  return c.status === "signed" && c.countersignedAt ? "countersigned" : c.status;
}

function view(ctx: ServiceContext, c: ContractRow) {
  const cl = ctx.db.select().from(contact).where(eq(contact.id, c.contactId)).get();
  return {
    id: c.id,
    title: c.title,
    state: stateOf(c),
    contactId: c.contactId,
    contactName: cl ? displayName(cl) : "",
    contactEmail: cl?.email ?? null,
    shootId: c.shootId,
    orderId: c.orderId,
    body: isHtml(c.body) ? sanitizeRich(c.body) : c.body,
    bodyHash: c.bodyHash,
    sentAt: c.sentAt,
    viewedAt: c.viewedAt,
    signedAt: c.signedAt,
    signerName: c.signerName,
    signMethod: c.signMethod,
    countersignedAt: c.countersignedAt,
    countersignedBy: c.countersignedBy,
    hasPdf: !!c.pdfPath,
    createdAt: c.createdAt,
    link: linkTo(ctx, `/c/${c.token}`),
  };
}

export const getContract = (ctx: ServiceContext, id: string) => view(ctx, rowOf(ctx, id));

export function listContracts(ctx: ServiceContext, f: { contactId?: string; shootId?: string; status?: string; q?: string; limit?: number } = {}) {
  const conds = [f.contactId ? eq(contract.contactId, f.contactId) : undefined, f.shootId ? eq(contract.shootId, f.shootId) : undefined, f.status && ["draft", "sent", "signed", "void"].includes(f.status) ? eq(contract.status, f.status as ContractRow["status"]) : undefined];
  const q = f.q?.trim();
  if (q) {
    const p = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(sql`${contract.title} like ${p} escape '\\'`, sql`${contract.contactId} in (select id from contact where first_name || ' ' || last_name like ${p} escape '\\')`));
  }
  const rows = ctx.db.select().from(contract).where(and(...conds)).orderBy(desc(contract.createdAt)).limit(Math.min(f.limit ?? 100, 200)).all();
  return rows.map((c) => {
    const { body: _b, bodyHash: _h, link: _l, ...rest } = view(ctx, c);
    return rest;
  });
}

// ---- sending ----

function studioName(ctx: ServiceContext) {
  return ctx.settings.get("studio.name") || "OpenPortrait";
}

function emailClient(ctx: ServiceContext, c: ContractRow, subject: string, paragraphs: string[], action: { label: string; url: string }, kind: string) {
  const cl = ctx.db.select().from(contact).where(eq(contact.id, c.contactId)).get();
  if (!cl?.email) return false;
  const mail = composeEmail(studioName(ctx), [`Hi ${cl.firstName || "there"},`, ...paragraphs], action);
  return !!queueEmail(ctx, { to: cl.email, toName: displayName(cl), subject, text: mail.text, html: mail.html, kind, contactId: cl.id, shootId: c.shootId });
}

function emailStudio(ctx: ServiceContext, subject: string, text: string) {
  const to = ctx.settings.get("studio.email");
  if (!to) return;
  const mail = composeEmail(studioName(ctx), [text]);
  queueEmail(ctx, { to, subject, text: mail.text, html: mail.html, kind: "contract.notice" });
}

/** Makes a draft signable without emailing it, for callers that put the link in their own email. */
export function markSent(ctx: ServiceContext, id: string) {
  const c = rowOf(ctx, id);
  if (c.status !== "draft") return;
  ctx.db.update(contract).set({ status: "sent", sentAt: new Date(), updatedAt: new Date() }).where(eq(contract.id, id)).run();
  logActivity(ctx, { contactId: c.contactId, kind: "contract.sent", summary: `Contract sent with booking: ${c.title}`, shootId: c.shootId });
}

export function sendContract(ctx: ServiceContext, id: string) {
  const c = rowOf(ctx, id);
  if (c.status !== "draft") throw new DomainError("invalid", "This has already been sent.");
  const cl = ctx.db.select().from(contact).where(eq(contact.id, c.contactId)).get();
  if (!cl?.email) throw new DomainError("no_email", "Add an email address to this contact before sending.");
  ctx.db.update(contract).set({ status: "sent", sentAt: new Date(), updatedAt: new Date() }).where(eq(contract.id, id)).run();
  const emailed = emailClient(ctx, c, `${c.title}: please review and sign`, [`${studioName(ctx)} has sent you ${c.title} to review and sign online. It takes a minute.`], { label: "Review and sign", url: linkTo(ctx, `/c/${c.token}`) }, "contract.sent");
  logActivity(ctx, { contactId: c.contactId, kind: "contract.sent", summary: `Contract sent: ${c.title}`, shootId: c.shootId });
  return { ...getContract(ctx, id), emailed };
}

export function voidContract(ctx: ServiceContext, id: string) {
  const c = rowOf(ctx, id);
  if (c.status === "void") return getContract(ctx, id);
  if (c.status === "signed") throw new DomainError("invalid", "A signed contract can't be voided. If it is wrong, make a new one and have it signed.");
  ctx.db.update(contract).set({ status: "void", voidedAt: new Date(), updatedAt: new Date() }).where(eq(contract.id, id)).run();
  logActivity(ctx, { contactId: c.contactId, kind: "contract.void", summary: `Contract voided: ${c.title}`, shootId: c.shootId });
  return getContract(ctx, id);
}

// ---- what the client sees and signs ----

export function publicView(ctx: ServiceContext, token: string) {
  const c = byToken(ctx, token);
  if (!c.viewedAt) {
    ctx.db.update(contract).set({ viewedAt: new Date() }).where(eq(contract.id, c.id)).run();
    emailStudio(ctx, `${c.title} was opened`, `${view(ctx, c).contactName} opened ${c.title}.`);
  }
  const v = view(ctx, c);
  // Booking agreements point back to the invoice they were holding, so signing leads straight to paying.
  const inv = c.orderId ? ctx.db.select({ token: order.token, kind: order.kind, status: order.status }).from(order).where(and(eq(order.id, c.orderId), eq(order.requiredContractId, c.id))).get() : null;
  const payUrl = inv && inv.kind === "invoice" && inv.status === "sent" ? linkTo(ctx, `/o/${inv.token}`) : null;
  return { payUrl, studioName: studioName(ctx), title: v.title, state: v.state, body: v.body, contactName: v.contactName, signedAt: v.signedAt, signerName: v.signerName, countersignedAt: v.countersignedAt, countersignedBy: v.countersignedBy, hasPdf: v.hasPdf, consent: CONSENT };
}

export interface SignInput {
  name: string;
  consent: boolean;
  method: "typed" | "drawn";
  image?: string | null;
  ip?: string;
  userAgent?: string;
}

export async function signContract(ctx: ServiceContext, token: string, input: SignInput) {
  const c = byToken(ctx, token);
  if (c.status === "void") throw new DomainError("invalid", "This contract is no longer available. Please contact the studio.");
  if (c.status === "signed") throw new DomainError("invalid", "This has already been signed. Thank you!");
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("invalid", "Type your full name.");
  if (!input.consent) throw new DomainError("invalid", "Tick the box to confirm you agree.");
  if (input.method === "drawn") {
    if (!input.image || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image) || input.image.length > 200_000) throw new DomainError("invalid", "Draw your signature in the box, then try again.");
  }
  // The wording must be exactly what was shown.
  if (hash(c.body) !== c.bodyHash) throw new DomainError("integrity", "This contract can't be signed because its text changed. Please contact the studio.", 409);
  const cl = ctx.db.select().from(contact).where(eq(contact.id, c.contactId)).get();
  const claimed = ctx.db
    .update(contract)
    .set({ status: "signed", signedAt: new Date(), signerName: name.slice(0, 120), signerEmail: cl?.email ?? null, signMethod: input.method, signatureImage: input.method === "drawn" ? input.image! : null, signerIp: input.ip?.slice(0, 64) ?? null, signerUserAgent: input.userAgent?.slice(0, 300) ?? null, consentText: CONSENT, updatedAt: new Date() })
    .where(and(eq(contract.id, c.id), eq(contract.status, "sent")))
    .run();
  if (claimed.changes === 0) throw new DomainError("invalid", "This has already been signed. Thank you!");
  await writePdf(ctx, c.id);
  logActivity(ctx, { contactId: c.contactId, kind: "contract.signed", summary: `${name} signed ${c.title}`, shootId: c.shootId });
  emailStudio(ctx, `Signed: ${c.title}`, `${name} signed ${c.title}. The signed copy is saved on their page. Open the contract in OpenPortrait to countersign it.`);
  emailClient(ctx, c, `Signed: ${c.title}`, [`Thank you. We received your signature on ${c.title}. You can download your signed copy any time.`], { label: "Download your copy", url: linkTo(ctx, `/c/${c.token}`) }, "contract.signed");
  return publicView(ctx, token);
}

/** The studio adds its own signature to a signed contract. */
export async function countersign(ctx: ServiceContext, id: string) {
  const c = rowOf(ctx, id);
  if (c.status !== "signed") throw new DomainError("invalid", "The client needs to sign first.");
  if (c.countersignedAt) throw new DomainError("invalid", "You've already countersigned this.");
  const u = ctx.actorId ? ctx.db.select({ name: user.name }).from(user).where(eq(user.id, ctx.actorId)).get() : null;
  ctx.db.update(contract).set({ countersignedAt: new Date(), countersignedBy: u?.name ?? studioName(ctx), updatedAt: new Date() }).where(eq(contract.id, id)).run();
  await writePdf(ctx, id);
  logActivity(ctx, { contactId: c.contactId, kind: "contract.countersigned", summary: `Countersigned: ${c.title}`, shootId: c.shootId });
  return getContract(ctx, id);
}

// ---- the signed PDF ----

const pdfDir = (ctx: ServiceContext) => path.join(ctx.config.configDir, "contracts");

async function writePdf(ctx: ServiceContext, id: string) {
  const c = rowOf(ctx, id);
  const tz = tzOf(ctx);
  const stamp = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "long", timeZone: tz }).format(d) : "");
  const buf = await renderContractPdf({
    studio: studioName(ctx),
    title: c.title,
    body: c.body,
    signature: c.signedAt ? { name: c.signerName ?? "", method: c.signMethod ?? "typed", image: c.signatureImage, at: stamp(c.signedAt) } : null,
    countersignature: c.countersignedAt ? { name: c.countersignedBy ?? "", at: stamp(c.countersignedAt) } : null,
    audit: c.signedAt
      ? [
          ["Contract ID", c.id],
          ["Signer", c.signerName ?? ""],
          ["Signer email", c.signerEmail ?? ""],
          ["Signed (UTC)", c.signedAt.toISOString()],
          ["IP address", c.signerIp ?? "unknown"],
          ["Browser", c.signerUserAgent ?? "unknown"],
          ["Signature method", c.signMethod === "drawn" ? "Drawn on screen" : "Typed name"],
          ["Document SHA-256", c.bodyHash],
          ["Consent shown", c.consentText ?? ""],
          ...(c.countersignedAt ? [["Countersigned (UTC)", c.countersignedAt.toISOString()], ["Countersigned by", c.countersignedBy ?? ""]] as Array<[string, string]> : []),
        ] as Array<[string, string]>
      : [],
  });
  fs.mkdirSync(pdfDir(ctx), { recursive: true });
  const file = path.join(pdfDir(ctx), `${c.id}.pdf`);
  fs.writeFileSync(file, buf);
  ctx.db.update(contract).set({ pdfPath: file }).where(eq(contract.id, id)).run();
}

export function pdfFor(ctx: ServiceContext, c: ContractRow): { file: string; name: string } {
  if (!c.pdfPath || !fs.existsSync(c.pdfPath)) throw notFound("The signed copy");
  const safe = c.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "contract";
  return { file: c.pdfPath, name: `${safe}-signed.pdf` };
}

export const pdfByToken = (ctx: ServiceContext, token: string) => pdfFor(ctx, byToken(ctx, token));
export const pdfById = (ctx: ServiceContext, id: string) => pdfFor(ctx, rowOf(ctx, id));
