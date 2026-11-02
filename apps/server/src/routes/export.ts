import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth.js";
import { EXPORT_KINDS, exportCsv, type ExportKind } from "../domain/export.js";
import { serviceContext } from "./crm.js";

/** Download your own data as CSV files you can open in a spreadsheet or import again. Owner only. */
export async function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);
  app.get("/:kind.csv", async (req, reply) => {
    const kind = (req.params as { kind: string }).kind as ExportKind;
    if (!EXPORT_KINDS.includes(kind)) return reply.code(404).send({ error: "not_found", message: "Nothing to export under that name." });
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${kind}-${day}.csv"`)
      .header("cache-control", "no-store")
      .send(exportCsv(serviceContext(app, req), kind));
  });
}
