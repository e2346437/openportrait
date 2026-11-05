import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { listIncoming, moveToShoot, sortByNameCards } from "../domain/incoming.js";
import { serviceContext } from "./crm.js";
import { parse } from "../validate.js";

/** The Incoming screen: camera files uploaded over SFTP, waiting to be sorted into shoots. */
export async function incomingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/", async (req) => listIncoming(serviceContext(app, req)));

  app.post("/move", async (req, reply) => {
    const body = parse(z.object({ shootId: z.string().min(1, "Choose a shoot."), paths: z.array(z.string().min(1)).min(1, "Choose at least one photo.").max(2000) }), req.body ?? {}, reply);
    if (!body) return;
    return moveToShoot(serviceContext(app, req), body.shootId, body.paths);
  });

  /** Splits one group day's frames into people, using the frames that show each person's name. */
  app.post("/sort", async (req, reply) => {
    const body = parse(
      z.object({
        parentId: z.string().min(1, "Choose the group day."),
        paths: z.array(z.string().min(1)).min(1, "Choose at least one photo.").max(5000),
        cards: z.array(z.object({ path: z.string().min(1), name: z.string().trim().max(200), email: z.string().trim().max(200).nullish() })).min(1, "Mark at least one name card.").max(500),
      }),
      req.body ?? {},
      reply,
    );
    if (!body) return;
    return sortByNameCards(serviceContext(app, req), body.parentId, body);
  });
}
