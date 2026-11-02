/** 用量: tokens / requests / errors by key, model or channel over a date range in a time zone. */
import { useState } from "preact/hooks";
import { type UsageGroup, type UsageReport, get } from "../api";
import { fmtNum, t } from "../i18n";
import { BarList, ErrorBox, Field, LineChart, Loading, browserTz, dateRange, todayIn, useLoad } from "../ui";

type GroupBy = "key" | "model" | "channel";

export function groupLabel(g: UsageGroup, by: GroupBy): string {
  if (by === "model") return g.model ?? "—";
  if (by === "channel") return g.channel === "none" ? "(none)" : (g.channel ?? "—");
  if (g.kind === "none") return "(no key)";
  return g.name ?? g.key ?? "—";
}

export function UsagePage() {
  const [tz, setTz] = useState(browserTz());
  const [groupBy, setGroupBy] = useState<GroupBy>("key");
  const [from, setFrom] = useState(todayIn(browserTz(), -6));
  const [to, setTo] = useState(todayIn(browserTz()));
  const usage = useLoad(
    () => get<UsageReport>("/usage", { groupBy, from, to, tz, daily: true }),
    [groupBy, from, to, tz],
  );
  const labels = dateRange(from, to);
  const top = (usage.data?.data ?? []).slice(0, 6);
  const series = top.map((g) => {
    const byDate = new Map((g.daily ?? []).map((d) => [d.date, d.totalTokens]));
    return { name: groupLabel(g, groupBy), values: labels.map((l) => byDate.get(l) ?? 0) };
  });

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
      <ErrorBox error={usage.error} />
      {usage.loading && !usage.data ? (
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
              items={(usage.data?.data ?? [])
                .slice(0, 12)
                .map((g) => ({ label: groupLabel(g, groupBy), value: g.requests }))}
            />
          </section>
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
              {(usage.data?.data ?? []).map((g) => (
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
            {usage.data ? (
              <tfoot>
                <tr>
                  <th>{t("u.total")}</th>
                  <th>{fmtNum(usage.data.totals.requests)}</th>
                  <th>{fmtNum(usage.data.totals.errors)}</th>
                  <th>{fmtNum(usage.data.totals.inputTokens)}</th>
                  <th>{fmtNum(usage.data.totals.outputTokens)}</th>
                  <th>{fmtNum(usage.data.totals.cacheHitTokens)}</th>
                  <th>{fmtNum(usage.data.totals.reasoningTokens)}</th>
                  <th>{fmtNum(usage.data.totals.totalTokens)}</th>
                  <th>{fmtNum(Math.round(usage.data.totals.avgLatencyMs))} ms</th>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </>
      )}
    </div>
  );
}
