/** 用量: tokens / requests / errors by key, model or channel over a date range in a time zone. */
import { useState } from "preact/hooks";
import { type UsageGroup, type UsageReport, get } from "../api";
import { fmtNum, t } from "../i18n";
import { BarList, ErrorBox, Field, LineChart, Loading, TableWrap, browserTz, dateRange, todayIn, useLoad } from "../ui";

type GroupBy = "key" | "model" | "channel";

export function groupLabel(g: UsageGroup, by: GroupBy): string {
  if (by === "model") return g.model ?? "—";
  if (by === "channel") return g.channel === "none" ? t("noneParen") : (g.channel ?? "—");
  if (g.kind === "none") return t("noKey");
  return g.name ?? g.key ?? "—";
}

/** Whether an IANA time zone name is known to this browser. */
export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Checked before asking the server (B6): the localized problem with the query, else undefined. */
export function usageProblem(from: string, to: string, tz: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return t("u.badDate");
  if (from > to) return t("u.fromAfterTo");
  if (!validTz(tz)) return t("u.badTz", { tz });
  return undefined;
}

/** Chart lines: the top `top` groups plus one "其他" line for the rest (U14). */
export function usageSeries(groups: readonly UsageGroup[], labels: readonly string[], by: GroupBy, top = 6) {
  const line = (list: readonly UsageGroup[]) => {
    const byDate = new Map<string, number>();
    for (const g of list) for (const d of g.daily ?? []) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.totalTokens);
    return labels.map((l) => byDate.get(l) ?? 0);
  };
  const series = groups.slice(0, top).map((g) => ({ name: groupLabel(g, by), values: line([g]) }));
  const rest = groups.slice(top);
  if (rest.length > 0) series.push({ name: `${t("other")} (${rest.length})`, values: line(rest) });
  return series;
}

export function UsagePage() {
  const [tz, setTz] = useState(browserTz());
  const [groupBy, setGroupBy] = useState<GroupBy>("key");
  const [from, setFrom] = useState(todayIn(browserTz(), -6));
  const [to, setTo] = useState(todayIn(browserTz()));
  const problem = usageProblem(from, to, tz);
  const usage = useLoad(
    () => (problem ? Promise.resolve(undefined) : get<UsageReport>("/usage", { groupBy, from, to, tz, daily: true })),
    [groupBy, from, to, tz],
  );
  // A bad query or a failed request shows only the error: never the previous charts beside it (B6).
  const report = problem || usage.error ? undefined : usage.data;
  const labels = problem ? [] : dateRange(from, to);
  const series = usageSeries(report?.data ?? [], labels, groupBy);

  return (
    <div class="stack">
      <div class="toolbar filters">
        <Field label={t("u.groupBy")}>
          <select value={groupBy} onChange={(e) => setGroupBy((e.currentTarget as HTMLSelectElement).value as GroupBy)}>
            <option value="key">{t("u.byKey")}</option>
            <option value="model">{t("u.byModel")}</option>
            <option value="channel">{t("u.byChannel")}</option>
          </select>
        </Field>
        <Field label={t("u.from")}>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t("u.to")}>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <Field label={t("u.tz")}>
          <input
            value={tz}
            list="tz-list"
            onChange={(e) => setTz((e.currentTarget as HTMLInputElement).value || "UTC")}
          />
          <datalist id="tz-list">
            {[
              "UTC",
              "Asia/Shanghai",
              "Asia/Tokyo",
              "America/Los_Angeles",
              "America/New_York",
              "Europe/London",
              "Europe/Berlin",
            ].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
      </div>
      {problem ? (
        <p class="error-box" role="alert">
          {problem}
        </p>
      ) : (
        <ErrorBox error={usage.error} />
      )}
      {problem || usage.error ? null : usage.loading && !usage.data ? (
        <Loading />
      ) : (
        <>
          <section class="card">
            <h2>{t("ov.tokens")}</h2>
            <LineChart labels={labels} series={series} />
          </section>
          <section class="card">
            <h2>{t("ov.requests")}</h2>
            <BarList
              items={(report?.data ?? [])
                .slice(0, 12)
                .map((g) => ({ label: groupLabel(g, groupBy), value: g.requests }))}
            />
          </section>
          <TableWrap>
            <table class="card">
              <thead>
                <tr>
                  <th>{groupBy === "key" ? t("l.key") : groupBy === "model" ? t("l.model") : t("l.provider")}</th>
                  <th>{t("ov.requests")}</th>
                  <th>{t("ov.errors")}</th>
                  <th>{t("u.input")}</th>
                  <th>{t("u.output")}</th>
                  <th>{t("u.cache")}</th>
                  <th>{t("u.reasoning")}</th>
                  <th>{t("ov.tokens")}</th>
                  <th>{t("u.latency")}</th>
                </tr>
              </thead>
              <tbody>
                {(report?.data ?? []).map((g) => (
                  <tr key={`${groupLabel(g, groupBy)}-${g.key ?? ""}`}>
                    <td>{groupLabel(g, groupBy)}</td>
                    <td>{fmtNum(g.requests)}</td>
                    <td>{fmtNum(g.errors)}</td>
                    <td>{fmtNum(g.inputTokens)}</td>
                    <td>{fmtNum(g.outputTokens)}</td>
                    <td>{fmtNum(g.cacheHitTokens)}</td>
                    <td>{fmtNum(g.reasoningTokens)}</td>
                    <td>
                      <strong>{fmtNum(g.totalTokens)}</strong>
                    </td>
                    <td>{fmtNum(Math.round(g.avgLatencyMs))} ms</td>
                  </tr>
                ))}
              </tbody>
              {report ? (
                <tfoot>
                  <tr>
                    <th>{t("u.total")}</th>
                    <th>{fmtNum(report.totals.requests)}</th>
                    <th>{fmtNum(report.totals.errors)}</th>
                    <th>{fmtNum(report.totals.inputTokens)}</th>
                    <th>{fmtNum(report.totals.outputTokens)}</th>
                    <th>{fmtNum(report.totals.cacheHitTokens)}</th>
                    <th>{fmtNum(report.totals.reasoningTokens)}</th>
                    <th>{fmtNum(report.totals.totalTokens)}</th>
                    <th>{fmtNum(Math.round(report.totals.avgLatencyMs))} ms</th>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
