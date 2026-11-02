/** 概览: request / token / error trends and channel health. */
import { type Channel, type UsageReport, get } from "../api";
import { fmtNum, t } from "../i18n";
import { Badge, ErrorBox, LineChart, Loading, browserTz, dateRange, todayIn, useLoad } from "../ui";
import { keyState } from "./channels";

interface Status {
  version: string;
  upstreamAvailable: boolean;
  circuitBreakers: Record<string, string>;
  providers: number;
}

const DAYS = 14;

export function OverviewPage() {
  const tz = browserTz();
  const status = useLoad(() => get<Status>("/status"));
  const channels = useLoad(() => get<{ data: Channel[] }>("/channels"));
  const usage = useLoad(() =>
    get<UsageReport>("/usage", {
      groupBy: "model",
      daily: true,
      from: todayIn(tz, -(DAYS - 1)),
      to: todayIn(tz),
      tz,
    }).catch(() => undefined),
  );

  const labels = dateRange(todayIn(tz, -(DAYS - 1)), todayIn(tz));
  const perDay = new Map<string, { requests: number; errors: number; tokens: number }>();
  for (const g of usage.data?.data ?? []) {
    for (const d of g.daily ?? []) {
      const x = perDay.get(d.date) ?? { requests: 0, errors: 0, tokens: 0 };
      x.requests += d.requests;
      x.errors += d.errors;
      x.tokens += d.totalTokens;
      perDay.set(d.date, x);
    }
  }
  const pick = (k: "requests" | "errors" | "tokens") => labels.map((l) => perDay.get(l)?.[k] ?? 0);
  const totals = usage.data?.totals;

  return (
    <div class="stack">
      <section class="cards">
        <div class="card stat">
          <span class="label">{t("ov.requests")}</span>
          <strong>{fmtNum(totals?.requests ?? 0)}</strong>
        </div>
        <div class="card stat">
          <span class="label">{t("ov.tokens")}</span>
          <strong>{fmtNum(totals?.totalTokens ?? 0)}</strong>
        </div>
        <div class="card stat">
          <span class="label">{t("ov.errors")}</span>
          <strong>{fmtNum(totals?.errors ?? 0)}</strong>
        </div>
        <div class="card stat">
          <span class="label">{t("ov.errorRate")}</span>
          <strong>
            {totals && totals.requests > 0 ? `${((totals.errors / totals.requests) * 100).toFixed(1)}%` : "—"}
          </strong>
        </div>
        <div class="card stat">
          <span class="label">{t("ov.upstream")}</span>
          <strong>
            {status.data ? (
              status.data.upstreamAvailable ? (
                <Badge kind="ok">{t("yes")}</Badge>
              ) : (
                <Badge kind="bad">{t("no")}</Badge>
              )
            ) : (
              "—"
            )}
          </strong>
          <span class="muted small">
            {t("ov.version")} {status.data?.version ?? ""}
          </span>
        </div>
      </section>

      <section class="card">
        <h2>{t("ov.trend", { n: DAYS })}</h2>
        {usage.loading ? (
          <Loading />
        ) : (
          <>
            <LineChart
              labels={labels}
              series={[
                { name: t("ov.requests"), values: pick("requests") },
                { name: t("ov.errors"), values: pick("errors") },
              ]}
            />
            <LineChart labels={labels} series={[{ name: t("ov.tokens"), values: pick("tokens") }]} height={160} />
          </>
        )}
      </section>

      <section class="card">
        <h2>{t("ov.health")}</h2>
        <ErrorBox error={channels.error ?? status.error} />
        {channels.loading ? (
          <Loading />
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("status")}</th>
                <th>{t("ov.breaker")}</th>
                <th>{t("ov.keys")}</th>
              </tr>
            </thead>
            <tbody>
              {(channels.data?.data ?? []).map((ch) => {
                const breaker = status.data?.circuitBreakers[ch.name] ?? "closed";
                const counts = { ok: 0, cooling: 0, disabled: 0 };
                for (const k of ch.keys) counts[keyState(k)]++;
                return (
                  <tr key={ch.id}>
                    <td>{ch.name}</td>
                    <td>
                      {ch.enabled ? (
                        <Badge kind="ok">{t("enabled")}</Badge>
                      ) : (
                        <Badge kind="muted">{t("disabled")}</Badge>
                      )}
                    </td>
                    <td>
                      <Badge kind={breaker === "closed" ? "ok" : breaker === "open" ? "bad" : "warn"}>{breaker}</Badge>
                    </td>
                    <td>
                      <Badge kind="ok">
                        {t("ch.keyStatus.ok")} {counts.ok}
                      </Badge>{" "}
                      {counts.cooling > 0 ? (
                        <Badge kind="warn">
                          {t("ch.keyStatus.cooling")} {counts.cooling}
                        </Badge>
                      ) : null}{" "}
                      {counts.disabled > 0 ? (
                        <Badge kind="bad">
                          {t("ch.keyStatus.disabled")} {counts.disabled}
                        </Badge>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
