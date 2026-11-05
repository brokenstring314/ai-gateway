/** 设置: aliases, global rate limit, plugins, model source, console sessions, language. */
import { useEffect, useState } from "preact/hooks";
import { LangSwitch, type PageProps } from "../app";
import { ApiError, api, get } from "../api";
import { fmtTime, t } from "../i18n";
import { ErrorBox, Field, type FieldErrors, Loading, TableWrap, failed, savedToast, useLoad } from "../ui";

interface Settings {
  strategy: unknown;
  aliases: Record<string, string>;
  plugins: Array<{ name: string; stage?: string; enabled?: boolean; config?: Record<string, unknown> }>;
  compatibility: unknown;
  limits?: { maxOutputTokens?: number };
  modelSource: "explicit" | "derived";
  revision: number;
  readOnly?: boolean;
}

interface SessionRow {
  id: string;
  actor: string;
  scopes: string[];
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}

const RATE_LIMIT = /^rate[-_]limit$/;

/** Plugins with the rate-limit entry set to the given per-key limits (null/null removes it). */
export function withRateLimit(
  plugins: Settings["plugins"],
  rpm: number | null,
  tpm: number | null,
): Settings["plugins"] {
  const others = plugins.filter((p) => !RATE_LIMIT.test(p.name));
  const existing = plugins.find((p) => RATE_LIMIT.test(p.name));
  if (rpm === null && tpm === null) {
    // Keep a daily limit if one was configured.
    const cfg = { ...(existing?.config ?? {}) };
    for (const k of ["maxRequestsPerMinute", "keyRpm", "rpm", "maxTokensPerMinute", "tpm"]) delete cfg[k];
    const hasDaily = cfg["maxRequestsPerDay"] !== undefined || cfg["rpd"] !== undefined;
    return hasDaily && existing ? [...others, { ...existing, config: cfg }] : others;
  }
  const cfg: Record<string, unknown> = { ...(existing?.config ?? {}) };
  for (const k of ["keyRpm", "rpm", "tpm"]) delete cfg[k];
  if (rpm === null) delete cfg["maxRequestsPerMinute"];
  else cfg["maxRequestsPerMinute"] = rpm;
  if (tpm === null) delete cfg["maxTokensPerMinute"];
  else cfg["maxTokensPerMinute"] = tpm;
  return [
    ...others,
    {
      name: existing?.name ?? "rate-limit",
      stage: existing?.stage ?? "before_request",
      enabled: existing?.enabled ?? true,
      config: cfg,
    },
  ];
}

export function SettingsPage(props: PageProps) {
  const s = useLoad(() => get<Settings>("/settings"));
  const sessions = useLoad(() => get<{ data: SessionRow[] }>("/sessions"));
  const [aliases, setAliases] = useState<Array<[string, string]>>([]);
  const [pluginsText, setPluginsText] = useState("");
  const [rpm, setRpm] = useState("");
  const [tpm, setTpm] = useState("");
  const [maxOut, setMaxOut] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const ro = !props.canWrite || s.data?.readOnly === true;

  useEffect(() => {
    if (!s.data) return;
    setAliases(Object.entries(s.data.aliases ?? {}));
    setPluginsText(JSON.stringify(s.data.plugins ?? [], null, 2));
    const rl = (s.data.plugins ?? []).find((p) => RATE_LIMIT.test(p.name))?.config ?? {};
    const r = rl["maxRequestsPerMinute"] ?? rl["keyRpm"] ?? rl["rpm"];
    const tk = rl["maxTokensPerMinute"] ?? rl["tpm"];
    setRpm(typeof r === "number" ? String(r) : "");
    setTpm(typeof tk === "number" ? String(tk) : "");
    const mo = s.data.limits?.maxOutputTokens;
    setMaxOut(typeof mo === "number" ? String(mo) : "");
  }, [s.data]);

  const patch = async (body: Record<string, unknown>) => {
    if (!s.data) return;
    try {
      const r = await api("/settings", { method: "PATCH", revision: s.data.revision, body });
      setErrors({});
      savedToast(r);
      s.reload();
    } catch (err) {
      setErrors(failed(err));
      if (err instanceof ApiError && err.status === 409) s.reload();
    }
  };

  return (
    <div class="stack">
      <ErrorBox error={s.error} />
      {!s.data ? (
        <Loading />
      ) : (
        <>
          <section class="card">
            <h2>{t("s.modelSource")}</h2>
            <p>{s.data.modelSource === "explicit" ? t("s.explicit") : t("s.derivedSrc")}</p>
            {s.data.modelSource !== "explicit" && !ro ? (
              <button type="button" class="primary" onClick={() => void patch({ modelSource: "explicit" })}>
                {t("s.switchExplicit")}
              </button>
            ) : null}
          </section>

          <section class="card">
            <h2>{t("s.aliases")}</h2>
            {errors["aliases"] ? <p class="field-error">{errors["aliases"]}</p> : null}
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>{t("s.aliasFrom")}</th>
                    <th>{t("s.aliasTo")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {aliases.map(([from, to], i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
                    <tr key={i}>
                      <td>
                        <input
                          value={from}
                          disabled={ro}
                          onInput={(e) =>
                            setAliases(
                              aliases.map((a, j) =>
                                j === i ? [(e.currentTarget as HTMLInputElement).value, a[1]] : a,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={to}
                          disabled={ro}
                          onInput={(e) =>
                            setAliases(
                              aliases.map((a, j) =>
                                j === i ? [a[0], (e.currentTarget as HTMLInputElement).value] : a,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        {!ro ? (
                          <button
                            type="button"
                            class="ghost danger"
                            onClick={() => setAliases(aliases.filter((_, j) => j !== i))}
                          >
                            ×
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {!ro ? (
              <div class="actions">
                <button type="button" onClick={() => setAliases([...aliases, ["", ""]])}>
                  {t("add")}
                </button>
                <button
                  type="button"
                  class="primary"
                  onClick={() => void patch({ aliases: Object.fromEntries(aliases.filter(([a, b]) => a && b)) })}
                >
                  {t("save")}
                </button>
              </div>
            ) : null}
          </section>

          <section class="card">
            <h2>{t("s.rateLimit")}</h2>
            <div class="grid2">
              <Field label={t("s.rpm")} error={errors["plugins"]}>
                <input
                  type="number"
                  min="1"
                  value={rpm}
                  disabled={ro}
                  placeholder={t("unlimited")}
                  onInput={(e) => setRpm((e.currentTarget as HTMLInputElement).value)}
                />
              </Field>
              <Field label={t("s.tpm")}>
                <input
                  type="number"
                  min="1"
                  value={tpm}
                  disabled={ro}
                  placeholder={t("unlimited")}
                  onInput={(e) => setTpm((e.currentTarget as HTMLInputElement).value)}
                />
              </Field>
            </div>
            {!ro ? (
              <button
                type="button"
                class="primary"
                onClick={() =>
                  void patch({
                    plugins: withRateLimit(s.data?.plugins ?? [], rpm ? Number(rpm) : null, tpm ? Number(tpm) : null),
                  })
                }
              >
                {t("save")}
              </button>
            ) : null}
          </section>

          <section class="card">
            <h2>{t("s.limits")}</h2>
            <Field
              label={t("s.maxOutputTokens")}
              error={errors["limits.maxOutputTokens"] ?? errors["limits"]}
              hint={t("s.maxOutputTokensHint")}
            >
              <input
                type="number"
                min="1"
                data-testid="max-output-tokens"
                value={maxOut}
                disabled={ro}
                placeholder="65536"
                onInput={(e) => setMaxOut((e.currentTarget as HTMLInputElement).value)}
              />
            </Field>
            {!ro ? (
              <button
                type="button"
                class="primary"
                onClick={() => void patch({ limits: maxOut ? { maxOutputTokens: Number(maxOut) } : null })}
              >
                {t("save")}
              </button>
            ) : null}
          </section>

          <section class="card">
            <h2>{t("s.plugins")}</h2>
            <Field label="plugins" error={errors["plugins"]}>
              <textarea
                class="mono"
                rows={10}
                value={pluginsText}
                disabled={ro}
                spellcheck={false}
                onInput={(e) => setPluginsText((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </Field>
            {!ro ? (
              <button
                type="button"
                class="primary"
                onClick={() => {
                  let plugins: unknown;
                  try {
                    plugins = JSON.parse(pluginsText);
                  } catch {
                    setErrors({ plugins: t("s.invalidJson") });
                    return;
                  }
                  void patch({ plugins });
                }}
              >
                {t("save")}
              </button>
            ) : null}
          </section>
        </>
      )}

      <section class="card">
        <h2>{t("s.sessions")}</h2>
        <ErrorBox error={sessions.error} />
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>{t("v.actor")}</th>
                <th>IP</th>
                <th>{t("s.lastSeen")}</th>
                <th>{t("s.expires")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(sessions.data?.data ?? []).map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.actor} {x.current ? <span class="badge ok">{t("s.current")}</span> : null}
                    <div class="muted small">{x.userAgent}</div>
                  </td>
                  <td>{x.ip}</td>
                  <td class="small">{fmtTime(x.lastSeenAt)}</td>
                  <td class="small">{fmtTime(x.expiresAt)}</td>
                  <td>
                    {props.canWrite || x.current ? (
                      <button
                        type="button"
                        class="danger"
                        onClick={async () => {
                          try {
                            await api(`/sessions/${encodeURIComponent(x.id)}`, { method: "DELETE" });
                            if (x.current) location.reload();
                            else sessions.reload();
                          } catch (err) {
                            failed(err);
                          }
                        }}
                      >
                        {t("s.revokeSession")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section class="card">
        <h2>{t("s.language")}</h2>
        <LangSwitch />
      </section>
    </div>
  );
}
