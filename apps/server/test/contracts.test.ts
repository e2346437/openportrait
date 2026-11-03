import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@openportrait/config";
import { buildApp } from "../src/app.js";
import { setTransportFactory } from "../src/domain/email.js";

let app: FastifyInstance;
let cookie: string;
let root: string;
let sent: Array<{ to: unknown; subject: string; text: string }>;
const TZ = "America/Chicago";
const smtp = { host: "smtp.example.com", port: 587, security: "starttls", user: "u", password: "secret-pass", fromName: "Lumen Studio", fromAddress: "hello@example.com" };

beforeEach(async () => {
  sent = [];
  setTransportFactory(() => ({
    sendMail: async (m: { to: unknown; subject: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
      return {} as never;
    },
  }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-contracts-"));
  const config = loadConfig({ OPENPORTRAIT_DATA_ROOT: root, WEB_DIR: path.join(root, "web") });
  fs.mkdirSync(config.galleriesDir, { recursive: true });
  app = await buildApp({ config, startBackground: false, setupCode: null, logger: false });
  const res = await app.inject({ method: "POST", url: "/api/studio/setup", payload: { studioName: "Lumen Studio", ownerName: "Pat", email: "pat@example.com", password: "correct horse battery", timezone: TZ } });
  cookie = `op_session=${res.cookies.find((c) => c.name === "op_session")!.value}`;
  app.ctx.settings.set("studio.email", "owner@example.com");
  await app.inject({ method: "PUT", url: "/api/studio/email", payload: smtp, headers: { cookie } });
});
afterEach(async () => {
  setTransportFactory(null);
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const staff = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/studio${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const pub = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `/api/public${url}`, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};



const TEMPLATE = "# Photography agreement\n\nThis agreement is between {{studio.name}} and {{client.name}} for {{shoot.subject}} on {{shoot.date}}.\n\nThe total is {{order.total}}. Signed on {{today}}.";
const SIMPLE = "Agreement between {{studio.name}} and {{client.name}}, {{today}}.";
async function client() {
  return (await staff("POST", "/contacts", { firstName: "Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
}
async function template(body = SIMPLE, name = "Basic agreement") {
  return (await staff("POST", "/contract-templates", { name, body })).body.id as string;
}
async function sentContract(body = SIMPLE) {
  const contactId = await client();
  const c = await staff("POST", "/contracts", { contactId, templateId: await template(body) });
  await staff("POST", `/contracts/${c.body.id}/send`);
  const row = app.ctx.db.$client.prepare("select token from contract where id = ?").get(c.body.id) as { token: string };
  return { id: c.body.id as string, token: row.token, contactId };
}
const sign = (token: string, extra: object = {}) => pub("POST", `/contract/${token}/sign`, { name: "Jane Smith", consent: true, method: "typed", ...extra });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("templates", () => {
  it("saves wording and catches mistyped merge fields", async () => {
    const t = await staff("POST", "/contract-templates", { name: "Wedding", body: SIMPLE });
    expect(t.status).toBe(201);
    const bad = await staff("POST", "/contract-templates", { name: "Oops", body: "Hello {{client.nmae}}" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/\{\{client\.nmae\}\}/);
    expect((await staff("POST", "/contract-templates", { name: " ", body: "x" })).body.message).toMatch(/name/);
    expect((await staff("GET", "/contract-templates")).body.items).toHaveLength(1);
    await staff("POST", `/contract-templates/${t.body.id}/archive`);
    expect((await staff("GET", "/contract-templates")).body.items).toHaveLength(0);
    expect((await staff("GET", "/contract-fields")).body.fields.length).toBeGreaterThan(5);
  });
  it("is owner-only to change", async () => {
    const r = await app.inject({ method: "POST", url: "/api/studio/contract-templates", payload: { name: "x", body: "y" } });
    expect(r.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/studio/contracts" })).statusCode).toBe(401);
  });
});

describe("formatted wording", () => {
  const RICH = '<h1>Agreement</h1><p style="text-align:center;color:red" onclick="x()">Hello <strong>{{client.name}}</strong><script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <a href="https://example.com/terms">terms</a></p><ul><li>One</li><li>Two</li></ul>';
  it("cleans the markup, escapes merge values, and keeps it through signing and the PDF", async () => {
    const contactId = (await staff("POST", "/contacts", { firstName: "<b>Jane", lastName: "Smith", email: "jane@example.com" })).body.id as string;
    const t = await staff("POST", "/contract-templates", { name: "Rich", body: RICH });
    expect(t.status).toBe(201);
    const stored = (await staff("GET", "/contract-templates")).body.items[0].body as string;
    expect(stored).toContain("<h2>Agreement</h2>");
    expect(stored).toContain("text-align:center");
    expect(stored).not.toMatch(/script|onclick|javascript:|color:red/);
    expect(stored).toContain('href="https://example.com/terms"');
    const c = await staff("POST", "/contracts", { contactId, templateId: t.body.id });
    expect(c.body.body).toContain("&lt;b&gt;Jane Smith");
    expect(c.body.body).not.toContain("<b>Jane");
    await staff("POST", `/contracts/${c.body.id}/send`);
    const token = (app.ctx.db.$client.prepare("select token from contract where id = ?").get(c.body.id) as { token: string }).token;
    expect((await pub("GET", `/contract/${token}`)).body.body).toContain("<li>One</li>");
    expect((await sign(token)).status).toBe(200);
    const pdf = await app.inject({ method: "GET", url: `/api/public/contract/${token}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("refuses wording that is only empty markup", async () => {
    expect((await staff("POST", "/contract-templates", { name: "Empty", body: "<p><br></p>" })).status).toBe(400);
  });
});

describe("drafting", () => {
  it("fills merge fields from the client, shoot and quote", async () => {
    const contactId = await client();
    const types = (await staff("GET", "/shoot-types")).body;
    const shoot = await staff("POST", "/shoots", { subject: "Smith wedding", shootTypeId: types.types[0].id, primaryContactId: contactId, events: [{ title: "Ceremony", startsAt: Date.UTC(2027, 5, 12, 20), endsAt: Date.UTC(2027, 5, 12, 22) }] });
    expect(shoot.status).toBeLessThan(300);
    const q = await staff("POST", "/orders", { kind: "quote", contactId, title: "Wedding", lines: [{ description: "Wedding", unitCents: 250_000, taxable: false }] });
    const c = await staff("POST", "/contracts", { contactId, templateId: await template(TEMPLATE), shootId: shoot.body.shoot.id, orderId: q.body.id });
    expect(c.status).toBe(201);
    expect(c.body.body).toContain("between Lumen Studio and Jane Smith for Smith wedding on June 12, 2027");
    expect(c.body.body).toContain("The total is $2,500.00.");
    expect(c.body).toMatchObject({ title: "Basic agreement", state: "draft" });
  });
  it("says what is missing instead of leaving a blank", async () => {
    const r = await staff("POST", "/contracts", { contactId: await client(), templateId: await template(TEMPLATE) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/\{\{shoot\.subject\}\}.*link a shoot/);
  });
  it("lets a draft be edited and deleted, but not after it is sent", async () => {
    const contactId = await client();
    const c = (await staff("POST", "/contracts", { contactId, templateId: await template() })).body;
    const edited = await staff("PUT", `/contracts/${c.id}`, { title: "Edited", body: "New wording for {{client.firstName}}." });
    expect(edited.body).toMatchObject({ title: "Edited", body: "New wording for Jane." });
    expect(edited.body.bodyHash).not.toBe(c.bodyHash);
    await staff("POST", `/contracts/${c.id}/send`);
    expect((await staff("PUT", `/contracts/${c.id}`, { title: "x", body: "y" })).status).toBe(400);
    expect((await staff("DELETE", `/contracts/${c.id}`)).status).toBe(400);
  });
  it("won't send to a client with no email", async () => {
    const contactId = (await staff("POST", "/contacts", { firstName: "No", lastName: "Email" })).body.id;
    const c = (await staff("POST", "/contracts", { contactId, templateId: await template() })).body;
    expect((await staff("POST", `/contracts/${c.id}/send`)).body.message).toMatch(/email address/);
  });
});

describe("signing", () => {
  it("emails the link, hides drafts, and marks the contract opened", async () => {
    const { id, token } = await sentContract();
    await app.ctx.jobs.drain();
    expect(sent.find((m) => /please review and sign/.test(m.subject))?.text).toContain(`/c/${token}`);
    const v = await pub("GET", `/contract/${token}`);
    expect(v.body).toMatchObject({ state: "sent", title: "Basic agreement", studioName: "Lumen Studio" });
    expect(v.body.body).toContain("Agreement between Lumen Studio and Jane Smith");
    expect((await staff("GET", `/contracts/${id}`)).body.viewedAt).toBeTruthy();
    const draft = (await staff("POST", "/contracts", { contactId: await client(), templateId: await template() })).body;
    const t = app.ctx.db.$client.prepare("select token from contract where id = ?").get(draft.id) as { token: string };
    expect((await pub("GET", `/contract/${t.token}`)).status).toBe(404);
  });
  it("needs a name and the consent box", async () => {
    const { token } = await sentContract();
    expect((await sign(token, { name: "J" })).body.message).toMatch(/full name/);
    expect((await sign(token, { consent: false })).body.message).toMatch(/Tick the box/);
  });
  it("records a typed signature with where it came from, once", async () => {
    const { id, token } = await sentContract();
    const r = await app.inject({ method: "POST", url: `/api/public/contract/${token}/sign`, payload: { name: "Jane Smith", consent: true, method: "typed" }, headers: { "user-agent": "TestBrowser/1.0" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "signed", signerName: "Jane Smith", hasPdf: true });
    const row = app.ctx.db.$client.prepare("select status, signer_ip, signer_user_agent, signer_email, consent_text from contract where id = ?").get(id) as Record<string, string>;
    expect(row).toMatchObject({ status: "signed", signer_user_agent: "TestBrowser/1.0", signer_email: "jane@example.com" });
    expect(row.signer_ip).toBeTruthy();
    expect(row.consent_text).toMatch(/legally bound/);
    expect((await sign(token)).body.message).toMatch(/already been signed/);
    await app.ctx.jobs.drain();
    expect(sent.some((m) => m.to === "owner@example.com" && /Signed: Basic agreement/.test(m.subject))).toBe(true);
  });
  it("accepts a drawn signature and rejects junk", async () => {
    const { token } = await sentContract();
    expect((await sign(token, { method: "drawn", image: "not an image" })).status).toBe(400);
    expect((await sign(token, { method: "drawn" })).body.message).toMatch(/Draw your signature/);
    const ok = await sign(token, { method: "drawn", image: PNG });
    expect(ok.body).toMatchObject({ state: "signed" });
  });
  it("produces a PDF with the wording and an audit trail, for both sides", async () => {
    const { id, token } = await sentContract();
    await sign(token);
    const pub1 = await app.inject({ method: "GET", url: `/api/public/contract/${token}/pdf` });
    expect(pub1.statusCode).toBe(200);
    expect(pub1.headers["content-type"]).toBe("application/pdf");
    expect(pub1.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pub1.headers["content-disposition"]).toMatch(/Basic-agreement-signed\.pdf/);
    const staffPdf = await app.inject({ method: "GET", url: `/api/studio/contracts/${id}/pdf`, headers: { cookie } });
    expect(staffPdf.statusCode).toBe(200);
    expect(staffPdf.rawPayload.length).toBeGreaterThan(1000);
  });
  it("refuses to sign if the stored wording no longer matches its hash", async () => {
    const { id, token } = await sentContract();
    app.ctx.db.$client.prepare("update contract set body = 'sneaky change' where id = ?").run(id);
    const r = await sign(token);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/text changed/);
  });
  it("won't let a voided contract be signed, or a signed one be voided", async () => {
    const a = await sentContract();
    await staff("POST", `/contracts/${a.id}/void`);
    expect((await sign(a.token)).body.message).toMatch(/no longer available/);
    const b = await sentContract();
    await sign(b.token);
    expect((await staff("POST", `/contracts/${b.id}/void`)).body.message).toMatch(/can't be voided/);
  });
  it("lets the owner countersign once the client has signed", async () => {
    const { id, token } = await sentContract();
    expect((await staff("POST", `/contracts/${id}/countersign`)).body.message).toMatch(/client needs to sign/);
    await sign(token);
    const r = await staff("POST", `/contracts/${id}/countersign`);
    expect(r.body).toMatchObject({ state: "countersigned", countersignedBy: "Pat" });
    expect((await staff("POST", `/contracts/${id}/countersign`)).status).toBe(400);
    expect((await pub("GET", `/contract/${token}`)).body.countersignedBy).toBe("Pat");
  });
  it("lists contracts and shows them on the contact's timeline", async () => {
    const { contactId } = await sentContract();
    expect((await staff("GET", `/contracts?contactId=${contactId}`)).body.items).toHaveLength(1);
    expect((await staff("GET", "/contracts?status=signed")).body.items).toHaveLength(0);
    const detail = (await staff("GET", `/contacts/${contactId}`)).body;
    expect(JSON.stringify(detail.timeline)).toMatch(/Contract sent: Basic agreement/);
  });
});
