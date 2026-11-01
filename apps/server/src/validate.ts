import type { FastifyReply } from "fastify";
import { z } from "zod";

/** Parses a body with zod; on failure sends a 400 with the first readable message and returns null. */
export function parse<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  void reply.code(400).send({ error: "invalid", field: issue?.path.join(".") || undefined, message: issue?.message ?? "Invalid request." });
  return null;
}

export const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const password = z.string().min(10, "Use at least 10 characters.").max(200, "That password is too long.");
export const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Choose a valid time zone.");
