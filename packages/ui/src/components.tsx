import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./icons.js";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** The OpenPortrait mark. Ink follows the text color, the lens is always the accent. */
export function Mark({ size = 28, title = "OpenPortrait" }: { size?: number; title?: string }) {
  return (
    <svg viewBox="142 102 240 308" width={size * (240 / 308)} height={size} role="img" aria-label={title}>
      <path fill="currentColor" fillRule="evenodd" d="M142 222a120 120 0 1 0 240 0a120 120 0 1 0 -240 0ZM198 222a64 64 0 1 1 128 0a64 64 0 1 1 -128 0Z" />
      <path fill="currentColor" d="M142 222H198V410H142Z" />
      <circle cx="262" cy="222" r="31" fill="var(--accent)" />
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? "status" : undefined} aria-label={label} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "accent" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  icon?: IconName;
  iconRight?: IconName;
};

export function Button({ variant = "default", size = "md", block, loading, icon, iconRight, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx("btn", variant !== "default" && variant, size !== "md" && size, block && "block", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} /> : null}
    </button>
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  className?: string;
}

/** Label, control, hint and error wired together for screen readers. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("field", className)}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <span className="error-text" id={errId}>
          <Icon name="alert" width={16} height={16} />
          {error}
        </span>
      ) : null}
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("input", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("input", props.className)} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "info" | "bad";

export function StatusChip({ tone = "neutral", pulse, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return <span className={cx("chip", tone !== "neutral" && tone, pulse && "pulse")}>{children}</span>;
}

const toneIcon: Record<Tone, IconName> = { neutral: "info", ok: "check", warn: "alert", info: "info", bad: "alert" };

export function Callout({ tone = "neutral", title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("callout", tone !== "neutral" && tone)} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={toneIcon[tone]} />
      <div className="callout-body">
        {title ? <b>{title}</b> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art">
        <Icon name={icon} />
      </div>
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({ title, description, actions, children, footer }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="panel">
      {title ? (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className="panel-body">{children}</div>
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}

/** A value with a one-click copy button, for things people paste into other apps. */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked on plain http; the value is still selectable.
    }
  };
  return (
    <div className="copy">
      <code>{value}</code>
      <Button size="sm" variant="ghost" icon={copied ? "check" : "copy"} onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/* Toasts */
interface Toast {
  id: number;
  tone: "ok" | "bad";
  text: string;
}
const ToastContext = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = next.current++;
    setToasts((t) => [...t, { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 6000 : 3200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("toast", t.tone)}>
            <Icon name={t.tone === "ok" ? "check" : "alert"} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/**
 * A modal dialog on the native <dialog> element: focus is trapped, Escape closes it, and the page
 * behind is inert. Clicking the backdrop closes it too.
 */
export function Dialog({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("dialog", wide && "wide")}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="dialog-in">
          <div className="dialog-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description ? <p>{description}</p> : null}
            </div>
            <Button variant="ghost" size="sm" className="icon" icon="x" aria-label="Close" onClick={onClose} />
          </div>
          {children ? <div className="dialog-body">{children}</div> : null}
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Tabs that keep the selected one in the URL hash is the caller's job; this is just the accessible strip. */
export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: ReactNode; icon?: IconName; count?: number }>; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.icon ? <Icon name={t.icon} /> : null}
          {t.label}
          {t.count !== undefined ? <span className="ct">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A row of mutually exclusive choices (a styled radio group). */
export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
