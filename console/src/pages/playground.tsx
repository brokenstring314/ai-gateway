/** Playground: call any published model through the real routing, streaming or not. */
import { useRef, useState } from "preact/hooks";
import type { PageProps } from "../app";
import { errorFrom, get, rawRequest } from "../api";
import { t } from "../i18n";
import { ErrorBox, Field, useLoad } from "../ui";

interface Msg {
  role: "user" | "assistant";
  content: string;
  meta?: string;
  /** The reply was cut off by the Stop button. */
  stopped?: boolean;
}

/**
 * Whether a keydown in the composer sends: Enter alone sends; Shift+Enter is a
 * new line; Ctrl/⌘+Enter also sends; never while an IME is composing (U11).
 */
export function isSendKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  // keyCode 229: the IME's own Enter (Safari reports isComposing false for the committing keystroke).
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

/** Text deltas of an OpenAI SSE chunk stream; returns leftover partial line. */
export function parseSse(buffer: string, onDelta: (text: string, usage?: unknown) => void): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (payload === "[DONE]" || payload === "") continue;
    try {
      const j = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
        usage?: unknown;
      };
      const d = j.choices?.[0]?.delta;
      onDelta(d?.content ?? "", j.usage ?? undefined);
    } catch {
      // ignore keep-alives / partial frames
    }
  }
  return rest;
}

export function PlaygroundPage(props: PageProps) {
  const models = useLoad(
    async () => (await get<{ published?: Array<{ name: string; enabled: boolean }> }>("/models")).published ?? [],
  );
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [input, setInput] = useState("");
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const chosen = model || models.data?.find((m) => m.enabled)?.name || "";

  const send = async () => {
    if (!input.trim() || !chosen) return;
    const msgs: Msg[] = [...history, { role: "user", content: input }];
    setHistory([...msgs, { role: "assistant", content: "" }]);
    setInput("");
    setError(undefined);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const started = performance.now();
    const body = {
      model: chosen,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(temperature ? { temperature: Number(temperature) } : {}),
      ...(maxTokens ? { max_tokens: Number(maxTokens) } : {}),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    let text = "";
    const update = (meta?: string, stopped?: boolean) =>
      setHistory([
        ...msgs,
        { role: "assistant", content: text, ...(meta ? { meta } : {}), ...(stopped ? { stopped: true } : {}) },
      ]);
    try {
      const res = await rawRequest("/playground/chat/completions", { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) throw await errorFrom(res);
      const provider = res.headers.get("X-Gateway-Provider") ?? "";
      if (stream && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let usage: { total_tokens?: number } | undefined;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = parseSse(buf + dec.decode(value, { stream: true }), (d, u) => {
            text += d;
            if (u) usage = u as { total_tokens?: number };
          });
          update();
        }
        update(
          `${provider} · ${Math.round(performance.now() - started)} ms${usage?.total_tokens ? ` · ${usage.total_tokens} tokens` : ""}`,
        );
      } else {
        const j = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        text = j.choices?.[0]?.message?.content ?? "";
        update(
          `${provider} · ${Math.round(performance.now() - started)} ms${j.usage?.total_tokens ? ` · ${j.usage.total_tokens} tokens` : ""}`,
        );
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) setError(err);
      // A failed call with no text leaves no empty bubble; the error box says what happened.
      if (!aborted && text === "") setHistory(msgs);
      else update(undefined, aborted);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div class="playground">
      <aside class="card stack">
        <Field label={t("p.model")}>
          <select value={chosen} onChange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}>
            {(models.data ?? []).map((m) => (
              <option key={m.name} value={m.name} disabled={!m.enabled}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("p.system")}>
          <textarea
            rows={4}
            value={system}
            onInput={(e) => setSystem((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </Field>
        <label class="check">
          <input
            type="checkbox"
            checked={stream}
            onChange={(e) => setStream((e.currentTarget as HTMLInputElement).checked)}
          />{" "}
          {t("p.stream")}
        </label>
        <Field label={t("p.temperature")}>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={temperature}
            onInput={(e) => setTemperature((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t("p.maxTokens")}>
          <input
            type="number"
            min="1"
            value={maxTokens}
            onInput={(e) => setMaxTokens((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <p class="muted small">{t("p.hint")}</p>
        <button type="button" onClick={() => setHistory([])}>
          {t("p.clear")}
        </button>
      </aside>
      <section class="card chat">
        <div class="messages">
          {history.length === 0 ? <p class="muted msg-empty">{t("p.empty")}</p> : null}
          {history.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
            <div key={i} class={`msg ${m.role}`}>
              <div class="bubble">{m.content || (busy && i === history.length - 1 ? "…" : "")}</div>
              {m.meta ? <div class="muted small">{m.meta}</div> : null}
              {m.stopped ? <div class="small stopped">{t("p.stopped")}</div> : null}
            </div>
          ))}
        </div>
        <ErrorBox error={error} />
        <form
          class="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={3}
            value={input}
            placeholder={t("p.message")}
            onInput={(e) => setInput((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (!isSendKey(e)) return;
              e.preventDefault();
              if (!busy && props.canWrite) void send();
            }}
          />
          {busy ? (
            <button type="button" onClick={() => abort.current?.abort()}>
              {t("p.stop")}
            </button>
          ) : (
            <button type="submit" class="primary" disabled={!props.canWrite || !chosen}>
              {t("p.send")}
            </button>
          )}
        </form>
        <p class="muted small composer-hint">{t("p.enterHint")}</p>
      </section>
    </div>
  );
}
