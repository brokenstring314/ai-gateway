/** 日志: persisted request log with filters and paging. */
import { useState } from "preact/hooks";
import { get } from "../api";
import { fmtNum, fmtTime, t } from "../i18n";
import { Badge, ErrorBox, Field, Loading, TableWrap, useLoad } from "../ui";
import { shortId } from "../versions-format";

interface LogEntry {
  traceId: string;
  stage: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage: string;
  createdAt: string;
  keyId?: string;
  /** Name of the client key (newer servers); older ones only send keyId. */
  keyName?: string | null;
  /** Newer servers: what kind of key keyId is (console Playground, config-file key, deleted store key). */
  keyKind?: "store" | "config" | "console" | "deleted";
  /** Upstream model actually called, when the server logs the published name in `model`. */
  upstreamModel?: string | null;
  durationMs?: number;
  status?: number;
}

const PAGE = 50;

/** Key column: the server's key name, else the name from /admin/keys, else a short id (U8). */
export function keyLabel(
  e: Pick<LogEntry, "keyId" | "keyName" | "keyKind">,
  names: ReadonlyMap<string, string>,
): string {
  if (e.keyName) return e.keyName;
  if (!e.keyId) return "—";
  if (e.keyKind === "console" || e.keyId === "console-playground") return t("l.keyConsole");
  const known = names.get(e.keyId);
  if (known) return known;
  if (e.keyKind === "config" || e.keyId.startsWith("cfg_")) return t("l.keyConfig", { id: shortId(e.keyId) });
  if (e.keyKind === "deleted") return t("l.keyDeleted", { id: shortId(e.keyId) });
  return shortId(e.keyId);
}

export function LogsPage() {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [offset, setOffset] = useState(0);
  const logs = useLoad(
    () =>
      get<{ entries: LogEntry[]; total: number }>("/logs", {
        limit: PAGE,
        offset,
        model,
        provider,
        ...(onlyErrors ? { status: "error" } : {}),
      }),
    [model, provider, onlyErrors, offset],
  );
  const keys = useLoad(async (): Promise<Array<{ id: string; name: string }>> => {
    try {
      const r = await get<{ keys?: Array<{ id: string; name: string }>; data?: Array<{ id: string; name: string }> }>(
        "/keys",
      );
      return r.keys ?? r.data ?? [];
    } catch {
      return [];
    }
  });
  const names = new Map<string, string>((keys.data ?? []).map((k) => [k.id, k.name]));
  const total = logs.data?.total ?? 0;
  return (
    <div class="stack">
      <div class="toolbar filters">
        <Field label={t("l.model")}>
          <input
            value={model}
            onChange={(e) => (setOffset(0), setModel((e.currentTarget as HTMLInputElement).value))}
          />
        </Field>
        <Field label={t("l.provider")}>
          <input
            value={provider}
            onChange={(e) => (setOffset(0), setProvider((e.currentTarget as HTMLInputElement).value))}
          />
        </Field>
        <label class="check">
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={(e) => (setOffset(0), setOnlyErrors((e.currentTarget as HTMLInputElement).checked))}
          />{" "}
          {t("l.onlyErrors")}
        </label>
        <button type="button" onClick={logs.reload}>
          {t("refresh")}
        </button>
      </div>
      <ErrorBox error={logs.error} />
      {logs.loading && !logs.data ? (
        <Loading />
      ) : (
        <TableWrap>
          <table class="card">
            <thead>
              <tr>
                <th>{t("l.time")}</th>
                <th>{t("l.model")}</th>
                <th>{t("l.provider")}</th>
                <th>{t("l.key")}</th>
                <th>{t("status")}</th>
                <th>{t("l.tokens")}</th>
                <th>{t("l.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {(logs.data?.entries ?? []).map((e) => {
                const bad = e.errorMessage !== "" || (e.status !== undefined && e.status >= 400);
                return (
                  <tr key={`${e.traceId}-${e.createdAt}`} title={e.traceId}>
                    <td class="nowrap small">{fmtTime(e.createdAt)}</td>
                    <td>
                      {e.model}
                      {e.upstreamModel && e.upstreamModel !== e.model ? (
                        <div class="muted small">{t("l.upstream", { m: e.upstreamModel })}</div>
                      ) : null}
                    </td>
                    <td>{e.provider}</td>
                    <td class="small" title={e.keyId ?? ""}>
                      {keyLabel(e, names)}
                    </td>
                    <td class="err-cell">
                      <Badge kind={bad ? "bad" : "ok"}>{e.status ?? e.stage}</Badge>
                      {e.errorMessage ? <div class="small error-text">{e.errorMessage}</div> : null}
                    </td>
                    <td class="small tokens" title={`${e.promptTokens} + ${e.completionTokens}`}>
                      {fmtNum(e.promptTokens)} + {fmtNum(e.completionTokens)} = {fmtNum(e.totalTokens)}
                    </td>
                    <td class="small num">{e.durationMs !== undefined ? `${fmtNum(e.durationMs)} ms` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div class="toolbar">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {t("l.prev")}
        </button>
        <span class="muted">
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} / {fmtNum(total)}
        </span>
        <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          {t("l.next")}
        </button>
      </div>
    </div>
  );
}
