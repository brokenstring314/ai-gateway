/** 日志: persisted request log with filters and paging. */
import { useState } from "preact/hooks";
import { get } from "../api";
import { fmtNum, fmtTime, t } from "../i18n";
import { Badge, ErrorBox, Field, Loading, useLoad } from "../ui";

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
  durationMs?: number;
  status?: number;
}

const PAGE = 50;

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
                  <td>{e.model}</td>
                  <td>{e.provider}</td>
                  <td class="small">{e.keyId ?? "—"}</td>
                  <td>
                    <Badge kind={bad ? "bad" : "ok"}>{e.status ?? e.stage}</Badge>
                    {e.errorMessage ? <div class="small error-text">{e.errorMessage}</div> : null}
                  </td>
                  <td class="small">
                    {fmtNum(e.promptTokens)} + {fmtNum(e.completionTokens)} = {fmtNum(e.totalTokens)}
                  </td>
                  <td class="small">{e.durationMs !== undefined ? `${fmtNum(e.durationMs)} ms` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
