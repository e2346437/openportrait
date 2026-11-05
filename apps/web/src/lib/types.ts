/** Shapes returned by the staff API. Kept in one place so pages and the API stay in step. */

/** Dates arrive as ISO strings (from the database layer) or epoch milliseconds (from raw queries). Use `ms()` to read one. */
export type Ts = string | number;

export interface ContactSummary {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  tags: string[];
}

export interface ContactFields {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  source: string | null;
}

export type TimelineItem =
  | { type: "note"; id: string; at: Ts; text: string; by: string | null; leadId: string | null; shootId: string | null }
  | { type: "activity"; id: string; at: Ts; kind: string; text: string; by: string | null; leadId: string | null; shootId: string | null };

export interface ContactDetail extends ContactFields {
  id: string;
  name: string;
  tags: string[];
  archivedAt: Ts | null;
  createdAt: Ts;
  leads: Array<{ id: string; createdAt: Ts; stage: string; stageKind: "open" | "won" | "lost"; shootType: string | null; eventDate: string | null; convertedShootId: string | null }>;
  shoots: Array<{ id: string; subject: string; status: ShootStatus; shootType: string; startsAt: Ts | null }>;
  timeline: TimelineItem[];
  /** The household this contact is in, with the other members. Null when they aren't in one. */
  household: { id: string; name: string; members: Array<{ id: string; name: string; email: string | null; phone: string | null }> } | null;
}

export interface ShootType {
  id: string;
  name: string;
  folderLabel: string;
  autoPublish: boolean;
  position: number;
  archived: boolean;
  shoots: number;
}

export interface LeadStage {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  position: number;
  leads: number;
}

export interface LeadCard {
  id: string;
  contactId: string;
  stageId: string;
  shootTypeId: string | null;
  shootType: string | null;
  source: string | null;
  eventDate: string | null;
  createdAt: Ts;
  name: string;
  email: string | null;
  convertedShootId: string | null;
}

export interface BoardStage {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  position: number;
  total: number;
  leads: LeadCard[];
}

export interface LeadDetail {
  id: string;
  contactId: string;
  stageId: string;
  stage: { id: string; name: string; kind: "open" | "won" | "lost" };
  shootType: { id: string; name: string } | null;
  shootTypeId: string | null;
  source: string | null;
  message: string | null;
  eventDate: string | null;
  lostReason: string | null;
  convertedShootId: string | null;
  createdAt: Ts;
  closedAt: Ts | null;
  contact: { id: string; name: string; email: string | null; phone: string | null };
  notes: Array<{ id: string; body: string; createdAt: Ts }>;
  activity: Array<{ id: number; at: Ts; kind: string; text: string }>;
}

export type ShootStatus = "booked" | "shot" | "editing" | "delivered" | "complete" | "cancelled";

export interface ShootListItem {
  id: string;
  subject: string;
  status: ShootStatus;
  folderPath: string | null;
  shootType: string;
  shootTypeId: string;
  contactId: string;
  client: string;
  startsAt: Ts | null;
  location: string | null;
}

export interface ShootEvent {
  id: string;
  title: string;
  startsAt: Ts;
  endsAt: Ts;
  allDay: boolean;
  location: string | null;
}

export interface GroupDayChild {
  id: string;
  subject: string;
  status: ShootStatus;
  folderPath: string | null;
  contactId: string;
  email: string | null;
  billTo: "self" | "parent";
  showOnMaster: boolean;
}

export interface ShootDetail {
  id: string;
  subject: string;
  status: ShootStatus;
  notes: string | null;
  folderPath: string | null;
  createdAt: Ts;
  leadId: string | null;
  kind: "single" | "group_day";
  parentId: string | null;
  billTo: "self" | "parent";
  showOnMaster: boolean;
  headcount: number;
  parent: { id: string; subject: string } | null;
  children: GroupDayChild[];
  shootType: { id: string; name: string; folderLabel: string };
  primary: { id: string; name: string; email: string | null; phone: string | null };
  events: ShootEvent[];
  contacts: Array<{ contactId: string; role: string; name: string; email: string | null }>;
  folder: { path: string; exists: boolean; rawSubdir: string; deliverySubdir: string } | null;
}

export interface FolderSettings {
  pattern: string;
  rawSubdir: string;
  deliverySubdir: string;
  example: string;
  root: string;
}

export const SHOOT_STATUS: Record<ShootStatus, { label: string; tone: "info" | "warn" | "ok" | "bad" | "neutral" }> = {
  booked: { label: "Booked", tone: "info" },
  shot: { label: "Shot", tone: "warn" },
  editing: { label: "Editing", tone: "warn" },
  delivered: { label: "Delivered", tone: "ok" },
  complete: { label: "Complete", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
