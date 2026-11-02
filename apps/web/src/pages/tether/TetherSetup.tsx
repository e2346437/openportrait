import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, Callout, CopyValue, EmptyState, Field, Icon, PageHeader, Panel, Spinner, useToast } from "@openportrait/ui";
import { api, type InternetStatus } from "../../lib/api.js";
import { useSubmit } from "../../lib/useForm.js";
import { formatDate, ms } from "../../lib/time.js";
import { useSession } from "../../lib/session.js";
import { isLight, isLocalHost, liveLink, loadBg, saveBg, type TetherSources } from "../../lib/tether.js";
import { useLoad } from "../../lib/useLoad.js";
import { BackgroundPicker } from "./BackgroundPicker.js";
import "./tether.css";

const SOURCE_KEY = "openportrait.tether.source";
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
};

/** "192.168.1.20:8090" or "http://192.168.1.20:8090/" as "http://192.168.1.20:8090", or null when it isn't an address yet. */
function normalizeLanUrl(input: string | null): string | null {
  const v = (input ?? "").trim();
  if (!v) return null;
  const full = /^https?:\/\//.test(v) ? v : `http://${v}`;
  return URL.canParse(full) ? full.replace(/\/+$/, "") : null;
}

export function TetherSetupPage() {
  const { me } = useSession();
  const tz = me?.studio.timezone ?? "UTC";
  const { data, error, loading, reload } = useLoad<TetherSources>("/tether/sources");
  const [source, setSource] = useState(() => remembered(SOURCE_KEY) ?? "incoming");
  const [bg, setBg] = useState(loadBg);
  const [lanDraft, setLanDraft] = useState<string | null>(null);
  const isOwner = me?.user?.role === "owner";
  const toast = useToast();
  const saveLan = useSubmit(() => api<InternetStatus>("/internet/lan-url", { method: "PUT", body: { url: lanDraft ?? "" } }));
  const onLan = isLocalHost(window.location.hostname);

  // If the remembered shoot is gone or finished, fall back to Incoming rather than showing a blank choice.
  useEffect(() => {
    if (data && source !== "incoming" && !data.shoots.some((s) => s.id === source)) setSource("incoming");
  }, [data, source]);

  // A container can't see its host's address or the port Docker mapped, so the home address is a saved setting.
  const typedUrl = normalizeLanUrl(lanDraft);
  const base = onLan ? window.location.origin : (typedUrl ?? data?.lan.url ?? "");
  const link = useMemo(() => liveLink(window.location.origin, source, bg), [source, bg]);
  const localLink = base && !onLan ? liveLink(base, source, bg) : null;

  const choose = (id: string) => {
    setSource(id);
    remember(SOURCE_KEY, id);
  };
  const pickBg = (hex: string) => {
    setBg(hex);
    saveBg(hex);
  };
  const liveHref = `/studio/tether/${encodeURIComponent(source)}?bg=${bg.slice(1)}`;

  if (error && !data)
    return (
      <>
        <PageHeader title="Tethering" />
        <Callout tone="bad" title="Couldn't load your shoots" action={<Button size="sm" onClick={reload}>Try again</Button>}>{error}</Callout>
      </>
    );
  if (!data)
    return (
      <>
        <PageHeader title="Tethering" />
        <div className="center-pad">{loading && <Spinner label="Loading" />}</div>
      </>
    );

  const picked = source === "incoming" ? data.incoming.label : (data.shoots.find((s) => s.id === source)?.subject ?? "");

  return (
    <>
      <PageHeader title="Tethering" description="See each photo on a big screen the moment your camera finishes uploading it, like a tethered shoot without the cable." />
      <div className="split tether-setup">
        <div className="stack">
          <Panel title="1. Which set are you shooting?" description="The live view follows this folder and shows whatever lands in it.">
            <fieldset className="set-list">
              <legend className="sr-only">Set to work with</legend>
              <label className={`set-item${source === "incoming" ? " on" : ""}`}>
                <input type="radio" name="set" checked={source === "incoming"} onChange={() => choose("incoming")} />
                <Icon name="inbox" />
                <span>
                  <b>{data.incoming.label}</b>
                  <small>{data.incoming.description}</small>
                </span>
              </label>
              {data.shoots.map((s) => (
                <label key={s.id} className={`set-item${source === s.id ? " on" : ""}`}>
                  <input type="radio" name="set" checked={source === s.id} onChange={() => choose(s.id)} />
                  <Icon name="camera" />
                  <span>
                    <b>{s.subject}</b>
                    <small>
                      {s.shootType}
                      {s.startsAt ? ` · ${formatDate(ms(s.startsAt), tz)}` : ""}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            {data.shoots.length === 0 && (
              <EmptyState icon="camera" title="No shoots with a folder yet">
                Add a shoot and OpenPortrait creates its folder. Until then you can tether to Incoming.
              </EmptyState>
            )}
          </Panel>

          <Panel title="2. Background" description="Black keeps the room dark. White suits a bright studio. Or match a colour to your set.">
            <BackgroundPicker value={bg} onChange={pickBg} />
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Your live view">
            <div className="tether-preview" style={{ background: bg }} aria-hidden>
              <span className={`mini ${isLight(bg) ? "dark" : "light"}`}>
                <Icon name="image" />
                {picked}
              </span>
            </div>
            <Button variant="accent" size="lg" block iconRight="arrowRight" onClick={() => window.open(liveHref, "_blank", "noopener")}>
              Open live view
            </Button>
            <p className="muted small">Opens in a new tab. Press the full-screen button there, or the F key.</p>
            <Field label="Link for another screen" hint="Open it on a laptop, tablet or monitor. You&rsquo;ll sign in once on each device.">
              {() => <CopyValue value={link} label="live view link" />}
            </Field>
          </Panel>

          <Panel title="Faster at home" description="A photo goes camera, Wi-Fi, router, internet, Cloudflare, then back to your screen. At home you can skip the loop.">
            {onLan ? (
              <Callout tone="ok" title="You&rsquo;re on your local network">The live view will load straight from your server, so photos appear with the least delay.</Callout>
            ) : (
              <>
                <Field label="Your server&rsquo;s address at home" hint="Use this link when the screen is on your home or studio network. It's the address you'd type to open OpenPortrait from home, with the port you mapped." error={saveLan.fieldErrors.url ?? saveLan.error}>
                  {(p) => (
                    <div className="input-row">
                      <input {...p} className="input mono" value={lanDraft ?? data.lan.url ?? ""} placeholder="http://192.168.1.20:8090" readOnly={!isOwner} onChange={(e) => setLanDraft(e.target.value)} spellCheck={false} inputMode="url" />
                      {isOwner ? (
                        <Button
                          type="button"
                          loading={saveLan.busy}
                          disabled={lanDraft === null}
                          onClick={async () => {
                            const next = await saveLan.submit();
                            if (!next) return;
                            setLanDraft(null);
                            toast("Home address saved");
                            reload();
                          }}
                        >
                          Save
                        </Button>
                      ) : null}
                    </div>
                  )}
                </Field>
                {localLink ? (
                  <CopyValue value={localLink} label="local live view link" />
                ) : (
                  <p className="muted small">{isOwner ? "Enter the address once and OpenPortrait remembers it for every screen. In Unraid it's the WebUI link on the Docker tab." : "Ask the studio owner to set the home address in Settings."}</p>
                )}
              </>
            )}
            <p className="muted small">The live view shows its round-trip time while it runs, so you can see which route is faster.</p>
          </Panel>
          <Callout tone="info" title="Camera not uploading yet?">
            <Link to="/studio/settings/camera-upload">Set up camera upload</Link> to send photos from your camera over SFTP, FTPS or FTP.
          </Callout>
        </div>
      </div>
    </>
  );
}
