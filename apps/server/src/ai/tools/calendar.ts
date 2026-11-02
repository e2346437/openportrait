import { z } from "zod";
import * as calendar from "../../domain/calendar.js";
import * as catalog from "../../domain/catalog.js";
import * as sched from "../../domain/scheduler.js";
import { defineTool } from "../registry.js";
import { plain, svc, untrusted } from "./util.js";

// Calendar, booking pages and booking requests. Contacts, leads and shoots live in crm.ts.

defineTool({
  name: "shoots_list_types",
  title: "List shoot types",
  description: "The studio's shoot types (Portrait, Wedding and so on) with their ids, for shoots_create.",
  area: "shoots",
  tier: "read",
  input: {},
  handler: (ctx) => catalog.listShootTypes(svc(ctx)),
});

defineTool({
  name: "calendar_list",
  title: "List calendar items",
  description: "Shoot times, appointments, time off and busy times between two moments (Unix milliseconds, at most a year apart). Titles of other people's events are never included, only 'Busy'.",
  area: "calendar",
  tier: "read",
  input: { from: z.number().int(), to: z.number().int() },
  handler: (ctx, a) => calendar.listCalendar(svc(ctx), a.from, a.to),
});

defineTool({
  name: "calendar_find_free_time",
  title: "Find free time",
  description: "Gaps of at least the given length between two moments (Unix milliseconds), taking shoots, appointments, time off and busy times into account.",
  area: "calendar",
  tier: "read",
  input: { from: z.number().int(), to: z.number().int(), minutes: z.number().int().min(5).max(1440) },
  handler: (ctx, a) => calendar.findFreeTime(svc(ctx), a.from, a.to, a.minutes),
});

defineTool({
  name: "calendar_list_schedulers",
  title: "List booking pages",
  description: "The studio's booking pages (schedulers): name, length, hours, approval rule and public address slug.",
  area: "calendar",
  tier: "read",
  input: {},
  handler: (ctx) => sched.listSchedulers(svc(ctx)).map((s) => ({ id: s.id, name: s.name, slug: s.slug, durationMinutes: s.durationMinutes, approval: s.approval, active: s.active, availability: s.availability })),
});

defineTool({
  name: "calendar_list_bookings",
  title: "List booking requests",
  description: "Client booking requests and bookings. Pending ones are waiting for the owner. Messages are written by clients and returned in untrusted blocks.",
  area: "calendar",
  tier: "read",
  input: { status: z.enum(["pending", "confirmed", "declined", "cancelled"]).optional() },
  handler: (ctx, a) => sched.listBookings(svc(ctx), { status: a.status, upcomingOnly: !a.status }).map((b) => ({ ...b, name: plain((b as { name?: string }).name), message: untrusted(b.message), email: plain(b.email), phone: plain(b.phone) })),
});

defineTool({
  name: "calendar_confirm_booking",
  title: "Confirm a booking request",
  description: "Confirms a pending booking request and emails the client. This reaches a client, so it waits for the owner's approval.",
  area: "calendar",
  tier: "outward",
  input: { bookingId: z.string() },
  handler: (ctx, a) => sched.confirmBooking(svc(ctx), a.bookingId),
});

defineTool({
  name: "calendar_decline_booking",
  title: "Decline a booking request",
  description: "Declines a pending booking request, frees the time and emails the client. This reaches a client, so it waits for the owner's approval.",
  area: "calendar",
  tier: "outward",
  input: { bookingId: z.string(), reason: z.string().max(1000).optional() },
  handler: (ctx, a) => sched.declineBooking(svc(ctx), a.bookingId, a.reason),
});
