import { isHtml } from "../lib/richtext.js";

/**
 * Text written in a RichTextEditor, or plain text from before the editors existed. The server cleans formatted
 * text before it is saved and before it is sent to a page, so it is safe to place as it arrives.
 */
export function RichText({ text, className = "" }: { text: string; className?: string }) {
  if (isHtml(text)) return <div className={`rich ${className}`} dangerouslySetInnerHTML={{ __html: text }} />;
  return <p className={className}>{text}</p>;
}
