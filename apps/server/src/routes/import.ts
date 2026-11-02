import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { DomainError } from "../domain/context.js";
import { parseTable } from "../import/csv.js";
import { FIELDS, autoMap } from "../import/fields.js";
import { runImport } from "../import/importer.js";
import { parse } from "../validate.js";
import { serviceContext } from "./crm.js";

const Body = z.object({
  kind: z.enum(["contacts", "shoots", "invoices"]),
  text: z.string().min(1, "Choose a file first.").max(15_000_000),
  /** Field key to the file's column name. Omit to let OpenPortrait guess from the column names. */
  mapping: z.record(z.string(), z.string()).optional(),
  source: z.string().trim().min(1).max(60).default("Previous system"),
  updateExisting: z.boolean().optional(),
});

/** One-time import of contacts, shoots and invoices from files exported elsewhere. Owner only. */
export async function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);

  app.get("/fields", async () => ({ fields: FIELDS }));

  const handle = (apply: boolean) => async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const body = parse(Body, req.body, reply);
    if (!body) return;
    let table;
    try {
      table = parseTable(body.text);
    } catch (err) {
      throw new DomainError("invalid", err instanceof Error ? err.message : "That file couldn't be read.");
    }
    if (!table.headers.length || !table.rows.length) throw new DomainError("invalid", "That file has no rows to import.");
    const mapping = body.mapping ?? autoMap(body.kind, table.headers);
    const report = runImport(serviceContext(app, req), body.kind, table, { source: body.source, mapping, updateExisting: body.updateExisting }, apply);
    return { ...report, headers: table.headers, mapping, sample: table.rows.slice(0, 3) };
  };
  const opts = { bodyLimit: 16 * 1024 * 1024 };
  app.post("/preview", opts, handle(false));
  app.post("/commit", opts, handle(true));
}
