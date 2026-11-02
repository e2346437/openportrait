import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type PointerEvent, type Ref } from "react";
import { useParams } from "react-router";
import { Button, Callout, Field, Icon, Spinner, StatusChip, TextInput } from "@openportrait/ui";
import { publicApi } from "../../lib/api.js";
import { ContractText } from "../contracts/Contract.js";
import { formatDateTime, ms } from "../../lib/time.js";
import { useSubmit } from "../../lib/useForm.js";
import { useLoad } from "../../lib/useLoad.js";
import { PublicMessage, PublicShell } from "./PublicShell.js";

interface View {
  studioName: string;
  title: string;
  state: "sent" | "signed" | "countersigned" | "void";
  body: string;
  contactName: string;
  signedAt: string | number | null;
  signerName: string | null;
  countersignedAt: string | number | null;
  countersignedBy: string | null;
  hasPdf: boolean;
  consent: string;
}

/** What a client sees at their private link: the agreement to read and sign, then their signed copy. */
export function ContractSignPage() {
  const { token = "" } = useParams();
  const { data, setData, error, loading } = useLoad<View>(`/contract/${encodeURIComponent(token)}`, { api: publicApi });
  const [name, setName] = useState("");
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [consent, setConsent] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  const sign = useSubmit(() => {
    const image = method === "drawn" ? pad.current?.toDataUrl() ?? null : null;
    if (method === "drawn" && !image) throw new Error("Draw your signature in the box, then try again.");
    return publicApi<View>(`/contract/${encodeURIComponent(token)}/sign`, { body: { name, consent, method, image } });
  });

  if (loading) return <PublicShell narrow><Spinner label="Loading" /></PublicShell>;
  if (error || !data) return <PublicMessage title="We couldn't find that page">The link may be incomplete. Please contact the studio directly.</PublicMessage>;
  const v = data;
  const signed = v.state === "signed" || v.state === "countersigned";
  const when = (x: string | number | null) => (x ? formatDateTime(ms(x), Intl.DateTimeFormat().resolvedOptions().timeZone) : "");
  const onSign = async (e: FormEvent) => {
    e.preventDefault();
    const r = await sign.submit();
    if (r) setData(r);
  };

  return (
    <PublicShell studio={v.studioName}>
      <header className="doc-head">
        <div>
          <h1 className="pub-title">{v.title}</h1>
          <p className="muted">For {v.contactName}</p>
        </div>
        <StatusChip tone={signed ? "ok" : v.state === "void" ? "bad" : "warn"}>{signed ? "Signed" : v.state === "void" ? "Void" : "Awaiting your signature"}</StatusChip>
      </header>
      {v.state === "void" ? <Callout tone="bad" title="This is no longer valid">Please contact the studio.</Callout> : null}
      <div className="contract-sheet">
        <ContractText text={v.body} />
      </div>

      {signed ? (
        <section className="doc-section">
          <Callout tone="ok" title={`Signed by ${v.signerName}`}>
            {when(v.signedAt)}
            {v.countersignedAt ? ` · Countersigned by ${v.countersignedBy} ${when(v.countersignedAt)}` : ""}
          </Callout>
          {v.hasPdf ? (
            <div className="form-actions">
              <a className="btn primary lg" href={`/api/public/contract/${encodeURIComponent(token)}/pdf`} download>
                <Icon name="download" /> Download your signed copy
              </a>
            </div>
          ) : null}
        </section>
      ) : v.state === "sent" ? (
        <section className="doc-section accept">
          <h2>Sign this agreement</h2>
          <form onSubmit={onSign} noValidate className="form-grid">
            {sign.error ? <div className="span-2"><Callout tone="bad">{sign.error}</Callout></div> : null}
            <Field className="span-2" label="Your full name">{(p) => <TextInput {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <div className="span-2 seg" role="radiogroup" aria-label="How to sign">
              {(["typed", "drawn"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? "on" : ""} onClick={() => setMethod(m)}>
                  {m === "typed" ? "Type my name" : "Draw my signature"}
                </button>
              ))}
            </div>
            {method === "typed" ? (
              <div className="span-2 sig-preview" aria-live="polite">{name.trim() ? name : "Your signature appears here"}</div>
            ) : (
              <div className="span-2">
                <SignaturePad ref={pad} />
              </div>
            )}
            <label className="span-2 check-inline consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{v.consent}</span>
            </label>
            <div className="span-2 form-actions">
              <Button variant="primary" size="lg" type="submit" loading={sign.busy} disabled={!consent || name.trim().length < 2}>Sign agreement</Button>
            </div>
          </form>
        </section>
      ) : null}
    </PublicShell>
  );
}

interface SignaturePadHandle {
  toDataUrl: () => string | null;
}

/** A small drawing box that works with a finger, a stylus or a mouse. */
function SignaturePad({ ref }: { ref?: Ref<SignaturePadHandle> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const g = c.getContext("2d")!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#171613";
  }, []);
  const pos = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const g = canvas.current!.getContext("2d")!;
    const [x, y] = pos(e);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 0.01, y + 0.01);
    g.stroke();
    setEmpty(false);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = canvas.current!.getContext("2d")!;
    const [x, y] = pos(e);
    g.lineTo(x, y);
    g.stroke();
  };
  const clear = () => {
    const c = canvas.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };
  // The ref exposes one thing: the drawing as a PNG, or nothing if the box is blank.
  useImperativeHandle(ref, () => ({ toDataUrl: () => (empty ? null : shrink(canvas.current!)) }), [empty]);
  return (
    <div className="sig-pad">
      <canvas ref={canvas} aria-label="Draw your signature here" onPointerDown={down} onPointerMove={move} onPointerUp={() => (drawing.current = false)} onPointerCancel={() => (drawing.current = false)} />
      <div className="sig-pad-foot">
        <span>{empty ? "Sign here with your finger or mouse" : ""}</span>
        <Button type="button" size="sm" variant="ghost" onClick={clear}>Clear</Button>
      </div>
    </div>
  );
}
/** Scales the drawing down so it stays a small file. */
function shrink(c: HTMLCanvasElement): string {
  const w = 600;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = Math.round((c.height / c.width) * w);
  out.getContext("2d")!.drawImage(c, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
