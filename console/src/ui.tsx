/** Shared console UI: data loading, toasts, form fields, drawer/modal, SVG charts. */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiResult } from "./api";
import { errorMessage, localizeServerText, t } from "./i18n";

// ── Data loading ──

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload };
}

// ── Toasts ──

type Toast = { id: number; text: string; kind: "ok" | "error"; timer: ReturnType<typeof setTimeout> | undefined };
let toastId = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
/** At most this many toasts at once; the oldest goes first. */
export const MAX_TOASTS = 3;

function publishToasts(): void {
  for (const fn of toastListeners) fn(toasts);
}

export function dismissToast(id: number): void {
  const hit = toasts.find((x) => x.id === id);
  if (hit?.timer) clearTimeout(hit.timer);
  toasts = toasts.filter((x) => x.id !== id);
  publishToasts();
}

/** Remove every toast (sign-out, tests). */
export function clearToasts(): void {
  for (const x of toasts) if (x.timer) clearTimeout(x.timer);
  toasts = [];
  publishToasts();
}

/**
 * Show a toast. The same text again does not stack a second copy: the
 * existing one moves to the end and its timer restarts (UI test U3).
 */
export function notify(text: string, kind: "ok" | "error" = "ok"): void {
  const same = toasts.find((x) => x.text === text && x.kind === kind);
  if (same?.timer) clearTimeout(same.timer);
  const toast: Toast = { id: ++toastId, text, kind, timer: undefined };
  toast.timer = setTimeout(() => dismissToast(toast.id), kind === "error" ? 8000 : 4000);
  const rest = toasts.filter((x) => x !== same);
  const dropped = rest.slice(0, Math.max(0, rest.length - (MAX_TOASTS - 1)));
  for (const d of dropped) if (d.timer) clearTimeout(d.timer);
  toasts = [...rest.slice(dropped.length), toast];
  publishToasts();
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => {
      toastListeners.delete(setList);
    };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((x) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: optional click-to-dismiss; it also times out
        <div key={x.id} class={`toast ${x.kind}`} title={t("dismiss")} onClick={() => dismissToast(x.id)}>
          {x.text}
        </div>
      ))}
    </div>
  );
}

/** The text to show for an error: an Admin API error by its code (zh / en), else its message. */
export function errText(err: unknown): string {
  if (err instanceof ApiError) {
    return errorMessage(err.code, err.message, err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {});
  }
  return err instanceof Error ? err.message : String(err);
}

/** Toast for a successful write: "已生效 · 版本 #N" when it created a config version. */
export function savedToast(res: ApiResult<unknown> | { configVersion?: number }): void {
  const v =
    res.configVersion ?? ((res as ApiResult<unknown>).data as { configVersion?: number } | undefined)?.configVersion;
  notify(typeof v === "number" ? t("savedVersion", { v }) : t("saved"));
}

/** Field errors keyed by the first path segment (and the full path). */
export type FieldErrors = Record<string, string>;

export function fieldErrorsOf(err: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (err instanceof ApiError) {
    for (const f of err.fields) {
      const top = f.path.split(".")[0] ?? f.path;
      const msg = localizeServerText(f.message);
      out[f.path] ??= msg;
      out[top] ??= msg;
    }
  }
  return out;
}

/**
 * Toast for a failed write; 409 → "已被修改，请刷新". Returns field errors for
 * the form. When the error names fields, the form shows each message next to
 * its input and the toast only says to fix them (no duplicate text, U3).
 */
export function failed(err: unknown): FieldErrors {
  if (err instanceof ApiError && err.status === 409 && err.code === "revision_mismatch") {
    notify(t("conflict"), "error");
    return {};
  }
  const fields = fieldErrorsOf(err);
  notify(Object.keys(fields).length > 0 ? t("fixFields") : errText(err), "error");
  return fields;
}

// ── Building blocks ──

export function Field(props: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label class={`field${props.error ? " invalid" : ""}`}>
      <span class="label">{props.label}</span>
      {props.children}
      {props.hint && !props.error ? <span class="hint">{props.hint}</span> : null}
      {props.error ? (
        <span class="field-error" role="alert">
          {props.error}
        </span>
      ) : null}
    </label>
  );
}

/** Close unless there are unsaved changes the user does not want to drop (U15). */
function guardedClose(dirty: boolean | undefined, onClose: () => void): () => void {
  return () => {
    if (dirty && !confirm(t("unsavedConfirm"))) return;
    onClose();
  };
}

export function Drawer(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
  /** Unsaved edits: Escape / backdrop / × ask before closing. */
  dirty?: boolean;
}) {
  const close = guardedClose(props.dirty, props.onClose);
  useEscape(close);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop click; Escape closes too
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && close()}>
      <aside class={`drawer${props.wide ? " wide" : ""}`} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button type="button" class="ghost" onClick={close} aria-label={t("close")}>
            ×
          </button>
        </header>
        <div class="drawer-body">{props.children}</div>
      </aside>
    </div>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren; dirty?: boolean }) {
  const close = guardedClose(props.dirty, props.onClose);
  useEscape(close);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop click; Escape closes too
    <div class="overlay center" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal" role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button type="button" class="ghost" onClick={close} aria-label={t("close")}>
            ×
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

function useEscape(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && ref.current();
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
}

export function Badge(props: { kind: "ok" | "warn" | "bad" | "muted"; children: ComponentChildren }) {
  return <span class={`badge ${props.kind}`}>{props.children}</span>;
}

export function ErrorBox(props: { error: unknown }) {
  if (!props.error) return null;
  const msg = errText(props.error);
  return (
    <p class="error-box" role="alert">
      {msg}
    </p>
  );
}

/** A table that scrolls sideways inside its own box instead of widening the page (B1 / B2). */
export function TableWrap(props: { children: ComponentChildren; class?: string }) {
  return <div class={`table-wrap${props.class ? ` ${props.class}` : ""}`}>{props.children}</div>;
}

export function Loading() {
  return <p class="muted">{t("loading")}</p>;
}

export function CopyButton(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t("copied") : t("copy")}
    </button>
  );
}

/** Number input value: "" → null. */
export function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

// ── Charts (plain SVG; no library) ──

const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];

export interface Series {
  name: string;
  values: number[];
}

/** Width of an element in CSS px, following resizes (charts draw at their real size so text stays 10px, U1). */
function useWidth(fallback: number): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(fallback);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const measure = () => {
      const px = Math.round(el.getBoundingClientRect().width);
      if (px > 0) setW(px);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      obs.current = new ResizeObserver(measure);
      obs.current.observe(el);
    }
  }, []);
  return [ref, w];
}

export function LineChart(props: { labels: string[]; series: Series[]; height?: number }) {
  const [ref, measured] = useWidth(640);
  const w = Math.max(240, measured);
  const h = props.height ?? 200;
  const pad = { l: 48, r: 12, t: 10, b: 24 };
  const n = props.labels.length;
  const max = Math.max(1, ...props.series.flatMap((s) => s.values));
  const x = (i: number) => pad.l + (n <= 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  if (n === 0) return <p class="muted">{t("noData")}</p>;
  return (
    <div class="chart" ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={props.series.map((s) => s.name).join(", ")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} class="grid" />
            <text x={pad.l - 6} y={y(v) + 4} text-anchor="end" class="axis">
              {compact(v)}
            </text>
          </g>
        ))}
        {props.labels.map((l, i) =>
          i % every === 0 ? (
            <text key={l} x={x(i)} y={h - 6} text-anchor="middle" class="axis">
              {l.slice(5)}
            </text>
          ) : null,
        )}
        {props.series.map((s, si) => (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={COLORS[si % COLORS.length]}
              stroke-width="2"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
            {s.values.map((v, i) => (
              <circle key={`${s.name}-${i}`} cx={x(i)} cy={y(v)} r="2.5" fill={COLORS[si % COLORS.length]}>
                <title>{`${s.name} ${props.labels[i]}: ${v.toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div class="legend">
        {props.series.map((s, si) => (
          <span key={s.name}>
            <i style={{ background: COLORS[si % COLORS.length] }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BarList(props: { items: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...props.items.map((i) => i.value));
  if (props.items.length === 0) return <p class="muted">{t("noData")}</p>;
  return (
    <div class="barlist">
      {props.items.map((i, idx) => (
        <div class="bar-row" key={i.label}>
          <span class="bar-label" title={i.label}>
            {i.label}
          </span>
          <span class="bar-track">
            <span class="bar" style={{ width: `${(i.value / max) * 100}%`, background: COLORS[idx % COLORS.length] }} />
          </span>
          <span class="bar-value">{i.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Dates (YYYY-MM-DD) from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Today in a time zone, YYYY-MM-DD. */
export function todayIn(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      d,
    );
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
