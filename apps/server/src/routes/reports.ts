import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth.js";
import { financialReport, paymentsCsv, resolveRange } from "../domain/reports.js";
import { serviceContext } from "./crm.js";

/** Money reports. Owner only: they total everything the studio earns. */
export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);
  const range = (req: { query: unknown }, ctx: ReturnType<typeof serviceContext>) => {
    const q = req.query as { from?: string; to?: string };
    return resolveRange(ctx, q.from, q.to);
  };

  app.get("/reports/financial", async (req) => {
    const ctx = serviceContext(app, req);
    return financialReport(ctx, range(req, ctx));
  });

  app.get("/reports/payments.csv", async (req, reply) => {
    const ctx = serviceContext(app, req);
    const r = range(req, ctx);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="payments-${r.from}-to-${r.to}.csv"`)
      .header("cache-control", "no-store")
      .send(paymentsCsv(ctx, r));
  });
}
