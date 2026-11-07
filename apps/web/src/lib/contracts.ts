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

/**
 * A plain starting point. It is only an example: have a lawyer review any contract before you rely on it.
 */
export const EXAMPLE_CONTRACT = `# Photography services agreement

This agreement is between {{studio.name}} ("the Photographer") and {{client.name}} ("the Client"), dated {{today}}.

# Services
The Photographer will photograph {{shoot.subject}} ({{shoot.type}}) on {{shoot.date}} and deliver edited images through an online gallery.

# Retainer and payment
The total fee is {{order.total}}. A non-refundable retainer is due when this agreement is signed. It is earned on signing because the Photographer reserves the date and turns away other work for it. The retainer is applied toward the total fee. The balance is due as shown on the invoice. If the balance is not paid by its due date, the Photographer may delay delivery, and may cancel the booking and keep the retainer.

# Cancellation and rescheduling
If the Client cancels, the retainer is kept. The Photographer will make a reasonable effort to reschedule once, subject to availability.

# Proofs
Proofs are low-resolution previews shared so the Client can choose images. They are for selection only. The Client agrees not to copy, download, edit, print, post or share proofs, and not to remove watermarks or other marks from them. Proofs remain the Photographer's property and may be withdrawn at any time.

# Delivery
Final edited images are delivered through an online gallery after the final payment is received. The Photographer aims to deliver within the time stated at booking, or within a reasonable time after the shoot if none was stated. Timing may vary with season and workload. The number of final images depends on the session and the light, and the Photographer does not promise an exact count.

# Copyright and usage
The Photographer owns the copyright in all images. After the final payment, the Client receives a personal-use license to print and share the delivered images, but not to sell them or use them commercially without the Photographer's written permission. The Photographer may use the images in portfolios and marketing unless the Client asks otherwise in writing.

# Chargebacks and payment disputes
The Client agrees to contact the Photographer to resolve any concern before disputing a payment with a bank or card company. The Client's payments are for services the Photographer has reserved time for and performed. If a payment is reversed or disputed, the Photographer may withhold delivery and suspend access to the gallery until it is resolved, and may provide this agreement, the signing record and the delivery record as evidence.

# Liability
If the Photographer cannot deliver images for a reason beyond their control, their liability is limited to the fees paid.

Questions about this agreement can be sent to {{studio.email}}.`;
