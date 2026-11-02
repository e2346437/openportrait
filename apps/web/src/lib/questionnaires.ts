export type FieldType = "heading" | "text" | "textarea" | "number" | "date" | "yesno" | "select" | "multiselect";

export interface QuestionField {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  options?: string[];
}
export type AnswerValue = string | string[] | boolean;
export type Answers = Record<string, AnswerValue>;

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  heading: "Section title",
  text: "Short answer",
  textarea: "Long answer",
  number: "Number",
  date: "Date",
  yesno: "Yes or no",
  select: "Pick one",
  multiselect: "Pick several",
};

export interface Template {
  id: string;
  name: string;
  intro: string | null;
  fields: QuestionField[];
  questions: number;
  sent: number;
  usedBy: Array<{ id: string; name: string }>;
  updatedAt: number;
}
export interface Starter {
  key: string;
  name: string;
  description: string;
  intro: string;
  fields: Array<Partial<QuestionField>>;
}
export interface TypeDefault {
  shootTypeId: string;
  templateId: string;
  sendMode: "manual" | "on_booking";
}
export interface SentQuestionnaire {
  id: string;
  title: string;
  fields: QuestionField[];
  status: "draft" | "sent" | "submitted";
  origin: "manual" | "auto";
  answers: Answers | null;
  link: string;
  sentAt: number | null;
  viewedAt: number | null;
  submittedAt: number | null;
  answered: number;
  questions: number;
}

/** A readable version of one answer. */
export function answerText(f: QuestionField, v: AnswerValue | undefined): string {
  if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return Array.isArray(v) ? v.join(", ") : v;
}
