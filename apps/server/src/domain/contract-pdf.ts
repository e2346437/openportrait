import PDFDocument from "pdfkit";
import { blocks, isHtml, sanitizeRich } from "./richtext.js";

export interface PdfInput {
  studio: string;
  title: string;
  body: string;
  signature: { name: string; method: "typed" | "drawn"; image: string | null; at: string } | null;
  countersignature: { name: string; at: string } | null;
  audit: Array<[string, string]>;
}

/**
 * A signed contract as a PDF: the wording, the signatures, and on its own page the audit trail
 * (who, when, from where, and a hash of the exact text). Uses the standard PDF fonts, so very unusual
 * characters may not print.
 */
export function renderContractPdf(input: PdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 64, bottom: 64, left: 72, right: 72 }, info: { Title: input.title, Author: input.studio, Producer: "OpenPortrait" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica").fontSize(9).fillColor("#6b655b").text(input.studio.toUpperCase(), { characterSpacing: 1 });
    doc.moveDown(0.4).font("Helvetica-Bold").fontSize(20).fillColor("#171613").text(input.title);
    doc.moveDown(0.8);
    if (isHtml(input.body)) {
      for (const b of blocks(sanitizeRich(input.body))) {
        if (b.kind === "hr") {
          doc.moveDown(0.4);
          doc.moveTo(72, doc.y).lineTo(540, doc.y).strokeColor("#b9b2a5").stroke();
          doc.moveDown(0.6);
        } else if (b.kind === "h") {
          doc.moveDown(0.4).font("Helvetica-Bold").fontSize(b.level === 2 ? 14 : 12).fillColor("#171613").text(b.text);
          doc.moveDown(0.2);
        } else if (b.kind === "li") {
          const indent = 72 + 14 * (b.level ?? 1);
          const y = doc.y;
          doc.font("Helvetica").fontSize(10.5).fillColor("#171613").text(b.marker ?? "•", indent - 14, y, { lineBreak: false });
          doc.text(b.text, indent + 6, y, { lineGap: 2, width: 468 - 14 * (b.level ?? 1) - 6 });
          doc.x = 72;
        } else if (b.kind === "quote") {
          doc.font("Helvetica-Oblique").fontSize(10.5).fillColor("#4a463f").text(b.text, 90, doc.y, { lineGap: 2, width: 450 });
          doc.x = 72;
          doc.moveDown(0.6);
        } else {
          doc.font("Helvetica").fontSize(10.5).fillColor("#171613").text(b.text, 72, doc.y, { lineGap: 2 });
          doc.moveDown(0.6);
        }
      }
    } else
    for (const raw of input.body.split("\n")) {
      const line = raw.trimEnd();
      if (!line) {
        doc.moveDown(0.6);
      } else if (line.startsWith("# ")) {
        doc.moveDown(0.4).font("Helvetica-Bold").fontSize(13).fillColor("#171613").text(line.slice(2));
      } else {
        doc.font("Helvetica").fontSize(10.5).fillColor("#171613").text(line, { lineGap: 2 });
      }
    }

    if (input.signature) {
      if (doc.y > doc.page.height - 260) doc.addPage();
      doc.moveDown(1.5);
      const top = doc.y;
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#171613").text("Signed", 72, top);
      const sig = input.signature;
      let y = top + 22;
      if (sig.method === "drawn" && sig.image) {
        try {
          doc.image(Buffer.from(sig.image.split(",")[1]!, "base64"), 72, y, { fit: [220, 70] });
        } catch {
          /* an unreadable image falls back to the typed name below */
        }
        y += 74;
      } else {
        doc.font("Times-Italic").fontSize(22).text(sig.name, 72, y);
        y += 32;
      }
      doc.moveTo(72, y).lineTo(300, y).strokeColor("#b9b2a5").stroke();
      doc.font("Helvetica").fontSize(9.5).fillColor("#6b655b").text(`${sig.name}, ${sig.at}`, 72, y + 4);
      if (input.countersignature) {
        const cs = input.countersignature;
        doc.font("Times-Italic").fontSize(22).fillColor("#171613").text(cs.name, 330, top + 22);
        doc.moveTo(330, y).lineTo(540, y).strokeColor("#b9b2a5").stroke();
        doc.font("Helvetica").fontSize(9.5).fillColor("#6b655b").text(`${cs.name} for ${input.studio}, ${cs.at}`, 330, y + 4, { width: 210 });
      }
    }

    if (input.audit.length) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#171613").text("Audit trail");
      doc.moveDown(0.3).font("Helvetica").fontSize(9.5).fillColor("#6b655b").text("This record was made automatically when the contract was signed. The document hash is a fingerprint of the exact text above: if even one character changed, the hash would not match.", { lineGap: 2 });
      doc.moveDown(1);
      for (const [k, v] of input.audit) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#6b655b").text(k.toUpperCase(), { characterSpacing: 0.6 });
        doc.font(k.includes("SHA") || k.includes("ID") ? "Courier" : "Helvetica").fontSize(10).fillColor("#171613").text(v || "-", { lineGap: 1 });
        doc.moveDown(0.6);
      }
    }
    doc.end();
  });
}
