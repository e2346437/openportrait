import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cleanPastedHtml, toEditorHtml } from "../lib/richtext.js";

export type RichVariant = "compact" | "standard" | "full";

interface Props {
  /** The formatted text (the small HTML set). Older plain text is converted when it loads. */
  value: string;
  onChange: (html: string) => void;
  variant?: RichVariant;
  /** Accessible name when there is no visible label. */
  label?: string;
  /** Id of the element labelling this editor, when a Field supplies one. */
  labelledBy?: string;
  id?: string;
  placeholder?: string;
  /** Fields the studio can drop in, like {{client.name}}. */
  fields?: { key: string; label: string }[];
  /** Height of the writing area: the editor grows with its text from here. */
  minHeight?: number;
  disabled?: boolean;
}

type Cmd = { id: string; label: string; title: string; run: () => void; active?: boolean; show: RichVariant[] };

const exec = (cmd: string, arg?: string) => document.execCommand(cmd, false, arg);

/**
 * A formatted-text editor. `compact` is bold, italic, link and bullets for short notes; `standard` adds headings, numbering
 * and underline; `full` adds quotes, alignment, dividers, undo and field insertion for documents like contracts.
 */
export function RichTextEditor({ value, onChange, variant = "standard", label, labelledBy, id, placeholder, fields, minHeight, disabled }: Props) {
  const uid = useId();
  const area = useRef<HTMLDivElement>(null);
  const last = useRef<string>("");
  const saved = useRef<Range | null>(null);
  const [state, setState] = useState<Record<string, boolean>>({});
  const [block, setBlock] = useState("p");
  const [empty, setEmpty] = useState(true);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("https://");

  // Load from outside only when the text differs from what the editor itself last produced, so typing never moves the caret.
  useEffect(() => {
    const el = area.current;
    if (!el || value === last.current) return;
    const html = toEditorHtml(value);
    el.innerHTML = html;
    last.current = value;
    setEmpty(!el.textContent?.trim() && !el.querySelector("hr"));
  }, [value]);
  useEffect(() => {
    try {
      exec("defaultParagraphSeparator", "p");
    } catch {
      /* older browsers keep their own default; the server tidies it */
    }
  }, []);

  const emit = useCallback(() => {
    const el = area.current;
    if (!el) return;
    const blank = !el.textContent?.trim() && !el.querySelector("hr");
    setEmpty(blank);
    const html = blank ? "" : el.innerHTML;
    last.current = html;
    onChange(html);
  }, [onChange]);

  const refresh = useCallback(() => {
    const el = area.current;
    const sel = window.getSelection();
    if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    setState({ bold: q("bold"), italic: q("italic"), underline: q("underline"), ul: q("insertUnorderedList"), ol: q("insertOrderedList"), left: q("justifyLeft"), center: q("justifyCenter") });
    let n: Node | null = sel.anchorNode;
    let b = "p";
    while (n && n !== el) {
      const t = (n as HTMLElement).tagName;
      if (t === "H2" || t === "H3" || t === "BLOCKQUOTE") {
        b = t.toLowerCase();
        break;
      }
      n = n.parentNode;
    }
    setBlock(b);
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, [refresh]);

  const run = (fn: () => void) => {
    area.current?.focus();
    fn();
    emit();
    refresh();
  };

  const openLink = () => {
    const sel = window.getSelection();
    saved.current = sel && sel.rangeCount && area.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const a = sel?.anchorNode?.parentElement?.closest("a");
    setUrl(a?.getAttribute("href") ?? "https://");
    setLinking(true);
  };
  const applyLink = () => {
    area.current?.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    const href = url.trim();
    if (/^(https?:\/\/|mailto:)\S+$/i.test(href)) {
      if (sel && sel.isCollapsed) exec("insertHTML", `<a href="${href.replace(/"/g, "&quot;")}">${href.replace(/</g, "&lt;")}</a>`);
      else exec("createLink", href);
    }
    setLinking(false);
    emit();
  };
  const removeLink = () => {
    area.current?.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    exec("unlink");
    setLinking(false);
    emit();
  };

  const cmds: Cmd[] = [
    { id: "bold", label: "B", title: "Bold (Ctrl+B)", run: () => run(() => exec("bold")), active: state.bold, show: ["compact", "standard", "full"] },
    { id: "italic", label: "I", title: "Italic (Ctrl+I)", run: () => run(() => exec("italic")), active: state.italic, show: ["compact", "standard", "full"] },
    { id: "underline", label: "U", title: "Underline (Ctrl+U)", run: () => run(() => exec("underline")), active: state.underline, show: ["standard", "full"] },
    { id: "ul", label: "• List", title: "Bulleted list", run: () => run(() => exec("insertUnorderedList")), active: state.ul, show: ["compact", "standard", "full"] },
    { id: "ol", label: "1. List", title: "Numbered list", run: () => run(() => exec("insertOrderedList")), active: state.ol, show: ["standard", "full"] },
    { id: "quote", label: "Quote", title: "Quote", run: () => run(() => exec("formatBlock", block === "blockquote" ? "p" : "blockquote")), active: block === "blockquote", show: ["full"] },
    { id: "left", label: "Left", title: "Align left", run: () => run(() => exec("justifyLeft")), show: ["full"] },
    { id: "center", label: "Center", title: "Center", run: () => run(() => exec("justifyCenter")), active: state.center, show: ["full"] },
    { id: "hr", label: "Divider", title: "Insert a divider line", run: () => run(() => exec("insertHorizontalRule")), show: ["full"] },
    { id: "undo", label: "Undo", title: "Undo (Ctrl+Z)", run: () => run(() => exec("undo")), show: ["full"] },
    { id: "redo", label: "Redo", title: "Redo", run: () => run(() => exec("redo")), show: ["full"] },
  ];
  const btn = (c: Cmd): ReactNode => (
    <button key={c.id} type="button" className={`rte-btn rte-${c.id}${c.active ? " on" : ""}`} title={c.title} aria-label={c.title.replace(/ \(.*\)/, "")} aria-pressed={c.active === undefined ? undefined : !!c.active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={c.run}>
      {c.label}
    </button>
  );
  const shown = cmds.filter((c) => c.show.includes(variant));
  const lead = shown.filter((c) => ["bold", "italic", "underline"].includes(c.id));
  const rest = shown.filter((c) => !["bold", "italic", "underline"].includes(c.id));
  const headings = variant !== "compact";

  return (
    <div className={`rte rte-${variant}${disabled ? " disabled" : ""}`}>
      <div className="rte-bar" role="toolbar" aria-label="Formatting" aria-controls={`${uid}-area`}>
        {headings ? (
          <select className="rte-select" aria-label="Text style" value={block} disabled={disabled} onChange={(e) => run(() => exec("formatBlock", e.target.value))}>
            <option value="p">Paragraph</option>
            <option value="h2">Heading</option>
            <option value="h3">Subheading</option>
            {block === "blockquote" ? <option value="blockquote">Quote</option> : null}
          </select>
        ) : null}
        {lead.map(btn)}
        <button type="button" className="rte-btn" title="Link" aria-label="Link" aria-expanded={linking} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={openLink}>Link</button>
        {rest.map(btn)}
        {fields && fields.length ? (
          <select
            className="rte-select rte-fields"
            aria-label="Insert a field"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const k = e.target.value;
              if (k) run(() => exec("insertText", `{{${k}}}`));
            }}
          >
            <option value="">Insert field…</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        ) : null}
      </div>
      {linking ? (
        <div className="rte-link" role="group" aria-label="Link address">
          <input className="input sm" type="url" inputMode="url" autoFocus aria-label="Web address" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinking(false); }} />
          <button type="button" className="btn sm primary" onClick={applyLink}>Apply</button>
          <button type="button" className="btn sm" onClick={removeLink}>Remove link</button>
          <button type="button" className="btn sm ghost" onClick={() => setLinking(false)}>Cancel</button>
        </div>
      ) : null}
      <div className="rte-wrap" style={minHeight ? { minHeight } : undefined}>
        <div
          ref={area}
          id={id ?? `${uid}-area`}
          className={`rte-area${empty ? " is-empty" : ""}`}
          role="textbox"
          aria-multiline="true"
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          data-placeholder={placeholder ?? ""}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck
          onInput={emit}
          onBlur={emit}
          onPaste={(e) => {
            const html = e.clipboardData.getData("text/html");
            const text = e.clipboardData.getData("text/plain");
            e.preventDefault();
            if (html) exec("insertHTML", cleanPastedHtml(html));
            else if (text) exec("insertText", text);
            emit();
          }}
        />
      </div>
    </div>
  );
}
