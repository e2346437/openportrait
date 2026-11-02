export type ContractState = "draft" | "sent" | "signed" | "countersigned" | "void";

export interface ContractSummary {
  id: string;
  title: string;
  state: ContractState;
  contactId: string;
  contactName: string;
  shootId: string | null;
  sentAt: string | number | null;
  signedAt: string | number | null;
  createdAt: string | number;
}
export interface ContractDetail extends ContractSummary {
  contactEmail: string | null;
  orderId: string | null;
  body: string;
  bodyHash: string;
  viewedAt: string | number | null;
  signerName: string | null;
  signMethod: "typed" | "drawn" | null;
  countersignedAt: string | number | null;
  countersignedBy: string | null;
  hasPdf: boolean;
  link: string;
}

export const contractLabel: Record<ContractState, string> = { draft: "Draft", sent: "Awaiting signature", signed: "Signed", countersigned: "Fully signed", void: "Void" };
export const contractTone = (s: ContractState): "neutral" | "ok" | "warn" | "info" | "bad" => (s === "signed" || s === "countersigned" ? "ok" : s === "sent" ? "warn" : s === "void" ? "bad" : "neutral");

/** A plain starting point. It is only an example: have a lawyer review any contract before you rely on it. */
export const EXAMPLE_CONTRACT = `# Photography services agreement

This agreement is between {{studio.name}} ("the Photographer") and {{client.name}} ("the Client"), dated {{today}}.

# Services
The Photographer will photograph {{shoot.subject}} ({{shoot.type}}) on {{shoot.date}} and deliver edited images through an online gallery.

# Payment
The total fee is {{order.total}}. A retainer is due to hold the date and is not refundable. The balance is due as shown on the invoice.

# Cancellation and rescheduling
If the Client cancels, the retainer is kept. The Photographer will make a reasonable effort to reschedule once, subject to availability.

# Copyright and usage
The Photographer owns the copyright in all images. The Client receives a personal-use license to print and share the delivered images. The Photographer may use the images in portfolios and marketing unless the Client asks otherwise in writing.

# Delivery
Images are delivered within a reasonable time after the shoot. Timing may vary with season and workload.

# Liability
If the Photographer cannot deliver images for a reason beyond their control, their liability is limited to the fees paid.

Questions about this agreement can be sent to {{studio.email}}.`;
