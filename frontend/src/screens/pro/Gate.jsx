import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Keyboard, QrCode, ScanLine, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { Dropdown, Notice, Verdict, triggerControlClass } from "../../ui";
import { useI18n } from "../../i18n";
import QrScanner from "./QrScanner";
import { Badge, Btn, Card, EmptyState, PageHead, PersonCell } from "./ui";
import { cn, eventText, intlLocaleTag } from "../../utils";
import {
  flushQueue,
  loadManifest,
  loadQueue,
  manifestHas,
  queueScan,
  refFromScan,
  saveManifest,
} from "./offlineGate";
import { text } from "./copy";
import { useConfirm } from "./ConfirmContext";

/** The headline word for each outcome. The full sentence goes underneath as
 * the detail — at a door you read the word first and the reason second. */
const VERDICT_WORD = (t) => ({
  ok: t.vOk,
  used: t.vUsed,
  cancelled: t.vCancelled,
  moved: t.vMoved,
  invalid: t.vInvalid,
  missing: t.vMissing,
});

export default function Gate() {
  const { locale } = useI18n();
  const t = text[locale];
  const confirm = useConfirm();
  const [mode, setMode] = useState("scan");
  const [ref, setRef] = useState("");
  const [result, setResult] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const [events, setEvents] = useState([]);
  const [manifest, setManifest] = useState(() => loadManifest());
  const [queued, setQueued] = useState(() => loadQueue().length);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    api.get("/organiser/events").then((data) => setEvents(data.events)).catch(() => {});
  }, []);

  const downloadManifest = async (slug) => {
    try {
      const data = await api.get(`/gate/events/${slug}/manifest`);
      saveManifest(data);
      setManifest(data);
      toast.success(t.manifestReady.replace("{n}", String(data.refs.length)));
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Replay anything taken offline as soon as the network is back.
  const flush = useCallback(async () => {
    const { sent, conflicts } = await flushQueue((payload) => api.post("/gate/check-in", payload));
    setQueued(loadQueue().length);
    if (sent > 0) toast.success(t.queueSynced.replace("{n}", String(sent)));
    for (const conflict of conflicts) {
      toast.warning(`${conflict.payload.ref} · ${conflict.reason}`);
    }
  }, [t]);

  useEffect(() => {
    if (online && queued > 0) flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  /** One check-in attempt, from either the camera or the manual field. */
  const checkIn = useCallback(
    async (code, source) => {
      const scanned = String(code).trim();
      // Guard with a ref, not state: the camera loop can fire again before a
      // state update has rendered.
      if (!scanned || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);

      // Offline: decide from the downloaded manifest and queue the scan. The
      // manifest says the ticket was valid when it was downloaded — it cannot
      // know whether another door has since admitted it, so the server has
      // the last word on replay.
      if (!navigator.onLine && manifest) {
        const bare = refFromScan(scanned);
        const known = manifestHas(manifest, bare);
        if (known) {
          setQueued(queueScan({ payload: { ref: scanned, source }, at: Date.now() }));
          setResult({ ok: true, code: "ok", ref: bare, holder: "", message: t.admittedOffline });
          setLog((prev) => [{ ref: bare, code: "ok", holder: "", at: new Date() }, ...prev].slice(0, 10));
          toast.success(t.admittedOffline);
        } else {
          setResult({ ok: false, code: "missing", ref: bare, holder: "", message: t.missing });
          setLog((prev) => [{ ref: bare, code: "missing", holder: "", at: new Date() }, ...prev].slice(0, 10));
          toast.error(t.missing);
        }
        setBusy(false);
        setTimeout(() => {
          inFlight.current = false;
        }, 600);
        return;
      }

      try {
        const res = await api.post("/gate/check-in", { ref: scanned, source });
        const holder = res.ticket?.holderName ?? "";
        setResult({ ok: true, code: "ok", ref: res.ticket?.ref ?? scanned, holder, message: t.admitted });
        setLog((prev) => [{ ref: res.ticket?.ref ?? scanned, code: "ok", holder, at: new Date() }, ...prev].slice(0, 10));
        toast.success(t.admitted);
        setRef("");
      } catch (err) {
        const code2 = err.data?.result ?? (err.status === 400 ? "invalid" : "missing");
        const message =
          code2 === "used"
            ? t.already
            : code2 === "listed"
              ? t.onSale
              : code2 === "cancelled"
              ? t.cancelled
              : code2 === "moved"
                ? t.moved
                : code2 === "invalid"
                  ? t.invalidCode
                  : t.missing;
        const shown = err.data?.ticket?.ref ?? scanned;
        setResult({ ok: false, code: code2, ref: shown, holder: "", message });
        setLog((prev) => [{ ref: shown, code: code2, holder: "", at: new Date() }, ...prev].slice(0, 10));
        toast.error(message);
      } finally {
        setBusy(false);
        // Brief cooldown so a held ticket doesn't immediately retry.
        setTimeout(() => {
          inFlight.current = false;
        }, 600);
      }
    },
    [t, manifest],
  );

  const submitManual = (e) => {
    e.preventDefault();
    checkIn(ref, "manual");
  };

  /*
   * Take back the admission that just happened.
   *
   * Offered only on the scan that succeeded, because that is the moment the
   * mistake is noticed — the wrong person stepped forward, or a group was
   * waved through and one of them was turned away. Anything older belongs on
   * the Orders desk, where the whole order is in view.
   *
   * Confirmed first: this makes a spent ticket work again, and a stray tap on
   * a phone held in one hand at a dark door is exactly how that happens by
   * accident. It needs the network, so it is hidden while offline rather than
   * queued — an undo that silently did nothing would be worse than none.
   */
  const undoLast = async () => {
    if (!result?.ok || !result.ref) return;
    const confirmed = await confirm({
      title: t.undoTitle,
      message: t.undoConfirm,
      tone: "warn",
      confirmLabel: t.undoConfirmLabel,
      cancelLabel: t.undoKeep,
    });
    if (!confirmed) return;
    try {
      await api.post("/gate/undo", { ref: result.ref });
      setResult(null);
      // Drop it from the recent list too: leaving it there would show the
      // door staff an admission that no longer stands.
      setLog((prev) => prev.filter((entry) => entry.ref !== result.ref));
      toast.success(t.undoDone);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const admitted = log.filter((entry) => entry.code === "ok").length;

  return (
    <div>
      <PageHead
        title={t.gate}
        sub={t.gateSub}
        actions={
          <div className="flex items-center rounded-full bg-paper p-1 text-xs font-bold">
            <button
              type="button"
              onClick={() => setMode("scan")}
              className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-2", mode === "scan" && "bg-card text-encre shadow-card")}
            >
              <ScanLine className="size-4" />
              {t.scanMode}
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-2", mode === "manual" && "bg-card text-encre shadow-card")}
            >
              <Keyboard className="size-4" />
              {t.manualEntry}
            </button>
          </div>
        }
      />

      {/*
        Losing the network at a door changes what the gate can promise: it is
        now deciding from a downloaded manifest, which was accurate when it
        was fetched and cannot see a refund since. That was previously a small
        amber badge in a quiet strip — easy to miss mid-queue, which is
        exactly when it matters.
      */}
      {!online ? (
        <Notice
          tone="warn"
          icon={<WifiOff className="size-5" />}
          title={t.offline}
          className="mb-4"
        >
          {manifest ? t.manifestFor.replace("{e}", manifest.eventSlug).replace("{n}", String(manifest.refs.length)) : t.noManifest}
        </Notice>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-line/10 bg-card p-3 shadow-card">
        <Badge tone={online ? "success" : "warn"}>
          {online ? t.online : t.offline}
        </Badge>
        {manifest ? (
          <span className="text-xs text-muted">{t.manifestFor.replace("{e}", manifest.eventSlug).replace("{n}", String(manifest.refs.length))}</span>
        ) : (
          <span className="text-xs text-muted">{t.noManifest}</span>
        )}
        {queued > 0 ? <Badge tone="warn">{t.queuedScans.replace("{n}", String(queued))}</Badge> : null}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {/* A menu, not a value: picking an event downloads its manifest and
              the control goes straight back to its prompt, so `value` stays
              empty on purpose and the placeholder is the only label it ever
              shows. */}
          <span className="block w-full sm:inline-block sm:w-56">
            <Dropdown
              value=""
              onChange={(slug) => { if (slug) downloadManifest(slug); }}
              options={events.map((ev) => ({ value: ev.slug, label: eventText(ev, "title", locale) }))}
              placeholder={t.downloadManifest}
              label={t.downloadManifest}
              triggerClassName={triggerControlClass({ className: "h-10 text-sm" })}
            />
          </span>
          {queued > 0 && online ? (
            <Btn variant="secondary" size="sm" onClick={flush} icon={<Download className="size-4" />}>
              {t.syncNow}
            </Btn>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        {/* Deliberately always dark, like a device/camera stage — see the
            note on --et-stage in styles.css. Was bg-encre/text-foam, which
            in dark mode flipped this to a near-white card with dark text
            sitting inside an otherwise-dark dashboard, as seen in the Gate
            screenshot. */}
        {/* min-w-0: a grid item defaults to min-width: auto, so without
            this each card is held to its own content's min-content width
            instead of the grid track — overflowing the viewport on the
            single-column mobile layout. */}
        <Card className="min-w-0 bg-stage text-stage-fg">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-control bg-stage-fg/10 text-accent" aria-hidden>
              <QrCode className="size-5" />
            </span>
            <div>
              <h2 className="font-display text-lg font-extrabold">{mode === "scan" ? t.scanMode : t.scan}</h2>
              <p className="text-xs text-stage-muted">{t.gateLead}</p>
            </div>
          </div>

          <div className="mt-5">
            {mode === "scan" ? (
              <QrScanner onScan={(code) => checkIn(code, "camera")} paused={busy} />
            ) : (
              <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={submitManual}>
                {/* The manual-entry field is intentionally a bright, light
                    input even inside the dark stage card -- it is what staff
                    actually read at arm's length, so it gets maximum
                    contrast rather than matching the stage. Kept as
                    card/encre (theme's own light surface + ink) rather than
                    a fixed white, so it is still legible if dark mode's
                    "ink" text colour is ever revisited. */}
                <input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="ET-2027-GA6DAV66RQ"
                  autoFocus
                  className="h-14 w-full rounded-control border border-stage-fg/20 bg-stage-fg px-4 font-mono text-lg text-stage outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/30"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="h-14 shrink-0 rounded-full bg-action px-6 text-sm font-semibold text-action-fg transition hover:bg-action-hover active:scale-[0.97] disabled:opacity-50"
                >
                  {t.check}
                </button>
              </form>
            )}
          </div>

          {/*
            The verdict. Read standing up, one-handed, at a venue door, often
            in the dark, with a queue waiting - so it is the largest thing on
            the screen, one icon and one word per outcome, and it never relies
            on colour alone.
          */}
          <Verdict
            code={result?.code}
            headline={result ? VERDICT_WORD(t)[result.code] ?? t.vMissing : undefined}
            detail={result?.message}
            holder={result?.holder}
            ticketRef={result?.ref}
            idleLabel={t.waiting}
            className="mt-5"
          />

          {/*
            Understated on purpose: it sits under the verdict, not beside the
            scanner, so it is reachable in the seconds after a wrong scan
            without ever competing with the next person in the queue.
          */}
          {result?.ok && result.ref && online ? (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={undoLast}
                /* stage-muted, not encre/60: this sits on the always-dark
                   scan card, and encre flips with the theme. hover was
                   `corail`, a token the v3 charte deleted — so it emitted
                   no CSS and the link had no hover state at all. */
                className="text-xs font-bold text-stage-muted underline decoration-dotted underline-offset-4 transition hover:text-stage-fg"
              >
                {t.undoLast}
              </button>
            </div>
          ) : null}
        </Card>

        <Card className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-display text-lg font-extrabold">{t.recent}</h2>
            {log.length > 0 ? (
              <Badge tone="success">
                {admitted}/{log.length}
              </Badge>
            ) : null}
          </div>
          {log.length === 0 ? (
            <EmptyState icon="🎫" title={t.waiting} />
          ) : (
            <ul className="grid gap-2">
              {log.map((entry, i) => (
                <li key={`${entry.ref}-${i}`} className="flex min-w-0 items-center justify-between gap-3 rounded-control bg-paper px-3 py-2.5">
                  <PersonCell
                    name={entry.holder || entry.ref}
                    sub={entry.at.toLocaleTimeString(intlLocaleTag(locale), { hour: "2-digit", minute: "2-digit" })}
                  />
                  <Badge tone={entry.code === "ok" ? "success" : entry.code === "used" ? "warn" : "danger"}>
                    {entry.code === "ok"
                      ? t.valid
                      : entry.code === "listed"
                        ? t.onSaleShort
                        : entry.code === "used"
                        ? t.used
                        : entry.code === "moved"
                          ? t.transferred
                          : entry.code === "invalid"
                            ? t.invalidCode
                            : t.missing}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {log.length > 0 ? (
            <Btn variant="secondary" size="sm" className="mt-3 w-full" onClick={() => setLog([])}>
              {t.close}
            </Btn>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
