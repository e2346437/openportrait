import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { tables } from "@openportrait/db";
import { displayName } from "../domain/contacts.js";
import { awaitingAutoSend } from "../domain/questionnaires.js";
import { defineAutomation, type WorkItem } from "./registry.js";

const { lead, leadStage, contact, shoot, shootEvent } = tables;
const DAY = 86_400_000;

defineAutomation({
  id: "lead-first-reply",
  title: "Reply to new inquiries",
  description: "New leads that have waited more than a day in the first pipeline stage.",
  items: (ctx) => {
    const first = ctx.db.select().from(leadStage).where(eq(leadStage.kind, "open")).orderBy(asc(leadStage.position)).get();
    if (!first) return [];
    return ctx.db
      .select({ id: lead.id, createdAt: lead.createdAt, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email })
      .from(lead)
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .where(and(eq(lead.stageId, first.id), isNull(lead.closedAt), lt(lead.createdAt, new Date(Date.now() - DAY))))
      .orderBy(asc(lead.createdAt))
      .limit(25)
      .all()
      .map<WorkItem>((r) => ({
        id: `lead-first-reply:${r.id}`,
        automation: "lead-first-reply",
        title: `Reply to ${displayName(r)}`,
        detail: "This inquiry has had no reply or stage change for over a day.",
        ref: { type: "lead", id: r.id },
        since: r.createdAt.getTime(),
      }));
  },
});

defineAutomation({
  id: "lead-follow-up",
  title: "Follow up on quiet leads",
  description: "Open leads past the first stage that haven't changed in a week.",
  items: (ctx) => {
    const first = ctx.db.select().from(leadStage).where(eq(leadStage.kind, "open")).orderBy(asc(leadStage.position)).get();
    return ctx.db
      .select({ id: lead.id, updatedAt: lead.updatedAt, firstName: contact.firstName, lastName: contact.lastName, company: contact.company, email: contact.email, stage: leadStage.name })
      .from(lead)
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .innerJoin(leadStage, eq(leadStage.id, lead.stageId))
      .where(and(eq(leadStage.kind, "open"), first ? sql`${lead.stageId} != ${first.id}` : undefined, isNull(lead.closedAt), lt(lead.updatedAt, new Date(Date.now() - 7 * DAY))))
      .orderBy(asc(lead.updatedAt))
      .limit(25)
      .all()
      .map<WorkItem>((r) => ({
        id: `lead-follow-up:${r.id}`,
        automation: "lead-follow-up",
        title: `Follow up with ${displayName(r)}`,
        detail: `Sitting in “${r.stage}” with no change for over a week.`,
        ref: { type: "lead", id: r.id },
        since: r.updatedAt.getTime(),
      }));
  },
});

defineAutomation({
  id: "shoot-prep",
  title: "Prepare upcoming shoots",
  description: "Shoots in the next two weeks that have no location yet.",
  items: (ctx) => {
    const now = Date.now();
    return ctx.db
      .select({ id: shoot.id, subject: shoot.subject, startsAt: sql<number>`min(${shootEvent.startsAt})`, located: sql<number>`max(case when ${shootEvent.location} is not null and ${shootEvent.location} != '' then 1 else 0 end)` })
      .from(shoot)
      .innerJoin(shootEvent, eq(shootEvent.shootId, shoot.id))
      .where(sql`${shoot.status} not in ('complete', 'cancelled', 'delivered')`)
      .groupBy(shoot.id)
      .having(sql`min(${shootEvent.startsAt}) between ${now} and ${now + 14 * DAY} and max(case when ${shootEvent.location} is not null and ${shootEvent.location} != '' then 1 else 0 end) = 0`)
      .orderBy(sql`min(${shootEvent.startsAt})`)
      .limit(25)
      .all()
      .map<WorkItem>((r) => ({
        id: `shoot-prep:${r.id}`,
        automation: "shoot-prep",
        title: `Add a location for ${r.subject}`,
        detail: `Shoots ${new Date(r.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: ctx.settings.get("studio.timezone") ?? "UTC" })} and has no location yet.`,
        ref: { type: "shoot", id: r.id },
        since: now,
      }));
  },
});

defineAutomation({
  id: "questionnaire-send",
  title: "Send questionnaires",
  description: "Booked shoots whose type has a questionnaire set to go out on booking, but where the client hasn't been sent one.",
  items: (ctx) =>
    awaitingAutoSend(ctx).map<WorkItem>((r) => ({
      id: `questionnaire-send:${r.id}`,
      automation: "questionnaire-send",
      title: `Send the questionnaire for ${r.subject}`,
      detail: "This shoot type has a questionnaire that goes out when a shoot is booked. It hasn't been sent to the client yet.",
      ref: { type: "shoot", id: r.id },
      since: r.createdAt.getTime(),
    })),
});
