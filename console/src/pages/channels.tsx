/** 渠道: list with status / latency / key states / balance, add wizard, key management. */
import { useEffect, useState } from "preact/hooks";
import type { PageProps } from "../app";
import { type Channel, type ChannelKey, type Model, type ModelMeta, ApiError, api, get } from "../api";
import { fmtTime, t } from "../i18n";
import {
  Badge,
  Drawer,
  ErrorBox,
  Field,
  type FieldErrors,
  Loading,
  Modal,
  failed,
  notify,
  savedToast,
  useLoad,
} from "../ui";

export type KeyState = "ok" | "cooling" | "disabled";

/** ok / cooling (429 cooldown running) / disabled (off, invalid or out of quota). */
export function keyState(k: ChannelKey, now = Date.now()): KeyState {
  if (!k.enabled || k.status === "invalid" || k.status === "quota") return "disabled";
  if (k.cooldownUntil && Date.parse(k.cooldownUntil) > now) return "cooling";
  return "ok";
}

export function KeyBadge(props: { k: ChannelKey }) {
  const s = keyState(props.k);
  const label =
    s === "disabled" && props.k.enabled && (props.k.status === "invalid" || props.k.status === "quota")
      ? t(`ch.keyStatus.${props.k.status}` as "ch.keyStatus.invalid")
      : t(`ch.keyStatus.${s}`);
  return <Badge kind={s === "ok" ? "ok" : s === "cooling" ? "warn" : "bad"}>{label}</Badge>;
}

interface Balance {
  supported: boolean;
  ok?: boolean;
  available?: boolean;
  balances?: Array<{ currency: string; total: string }>;
  error?: string;
}

interface Preset {
  id: string;
  baseURL: string | null;
  baseURLRequired: boolean;
  adminUsable: boolean;
  models: Array<{ id: string; metadata?: ModelMeta }>;
}

const BALANCE_PRESETS = new Set(["deepseek", "openrouter"]);

export function BalanceCell(props: { channel: Channel }) {
  const [b, setB] = useState<Balance | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const supported = BALANCE_PRESETS.has(props.channel.preset.toLowerCase());
  const load = async () => {
    setBusy(true);
    try {
      setB(await get<Balance>(`/channels/${encodeURIComponent(props.channel.id)}/balance`));
    } catch (err) {
      setB({ supported: true, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per channel
  useEffect(() => {
    if (supported && props.channel.keys.some((k) => k.enabled)) void load();
  }, [props.channel.id]);
  if (!supported) return <span class="muted">—</span>;
  if (busy) return <span class="muted">…</span>;
  if (!b) return <span class="muted">—</span>;
  if (!b.supported) return <span class="muted">—</span>;
  if (!b.ok)
    return (
      <span class="muted" title={b.error}>
        ⚠{" "}
        <button type="button" class="link" onClick={() => void load()}>
          {t("refresh")}
        </button>
      </span>
    );
  return (
    <span title={t("ch.balanceHint")}>
      {(b.balances ?? []).map((x) => `${x.total} ${x.currency}`).join(" · ") || "—"}
      {b.available === false ? <Badge kind="bad">!</Badge> : null}
    </span>
  );
}

export function ChannelsPage(props: PageProps) {
  const list = useLoad(() => get<{ data: Channel[]; readOnly?: boolean }>("/channels"));
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [latency, setLatency] = useState<Record<string, string>>({});
  const canWrite = props.canWrite && list.data?.readOnly !== true;

  const test = async (ch: Channel) => {
    setLatency((l) => ({ ...l, [ch.id]: "…" }));
    try {
      const r = await api<{ ok: boolean; latencyMs: number; error?: string }>(
        `/channels/${encodeURIComponent(ch.id)}/test`,
        { method: "POST", body: {} },
      );
      setLatency((l) => ({
        ...l,
        [ch.id]: r.data.ok ? t("ch.testOk", { ms: r.data.latencyMs }) : t("ch.testFail", { e: r.data.error ?? "" }),
      }));
    } catch (err) {
      setLatency((l) => ({ ...l, [ch.id]: t("ch.testFail", { e: err instanceof Error ? err.message : "" }) }));
    }
  };

  return (
    <div class="stack">
      <div class="toolbar">
        {canWrite ? (
          <button type="button" class="primary" onClick={() => setAdding(true)}>
            {t("ch.add")}
          </button>
        ) : null}
        <button type="button" onClick={list.reload}>
          {t("refresh")}
        </button>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <table class="card">
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th>{t("ch.preset")}</th>
              <th>{t("status")}</th>
              <th>{t("ch.keys")}</th>
              <th>{t("ch.latency")}</th>
              <th>{t("ch.balance")}</th>
              <th>{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((ch) => (
              <tr key={ch.id}>
                <td>
                  <strong>{ch.name}</strong>
                  <div class="muted small">{ch.effectiveBaseURL}</div>
                </td>
                <td>{ch.preset}</td>
                <td>
                  <span class={`dot ${ch.enabled ? "ok" : "muted"}`} />
                  {ch.enabled ? t("enabled") : t("disabled")}
                </td>
                <td>
                  {ch.keys.length === 0 ? <span class="muted">{t("none")}</span> : null}
                  {ch.keys.map((k) => (
                    <span key={k.id} class="keychip" title={k.lastError ?? ""}>
                      <code>{k.hint}</code> <KeyBadge k={k} />
                    </span>
                  ))}
                </td>
                <td class="small">{latency[ch.id] ?? "—"}</td>
                <td>
                  <BalanceCell channel={ch} />
                </td>
                <td class="nowrap">
                  {canWrite ? (
                    <button type="button" onClick={() => void test(ch)}>
                      {t("ch.test")}
                    </button>
                  ) : null}{" "}
                  <button type="button" onClick={() => setEditing(ch.id)}>
                    {t("edit")}
                  </button>{" "}
                  {canWrite ? (
                    <button
                      type="button"
                      class="danger"
                      onClick={async () => {
                        if (!confirm(t("confirmDelete", { name: ch.name }))) return;
                        try {
                          savedToast(
                            await api(`/channels/${encodeURIComponent(ch.id)}`, {
                              method: "DELETE",
                              revision: ch.revision,
                            }),
                          );
                          list.reload();
                        } catch (err) {
                          failed(err);
                        }
                      }}
                    >
                      {t("delete")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <ChannelDrawer
          id={editing}
          canWrite={canWrite}
          onClose={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
      {adding ? (
        <AddChannelWizard
          onClose={() => {
            setAdding(false);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Edit drawer: settings and keys ──

/** Scheme + host + port of a base URL ("" = the preset default; unparsable text as typed). */
export function originOf(url: string): string {
  if (url.trim() === "") return "";
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return url.trim();
  }
}

/**
 * Whether saving `next` as the base URL moves a channel with stored keys to
 * another origin: then the API requires the key(s) again (RC1), since stored
 * keys are never sent to a new origin.
 */
export function needsKeysForBaseURL(current: string | null, next: string, storedKeys: number): boolean {
  if (storedKeys === 0) return false;
  const before = current ?? "";
  if (next.trim() === before.trim()) return false;
  return originOf(next) !== originOf(before);
}

function ChannelDrawer(props: { id: string; canWrite: boolean; onClose: () => void }) {
  const ch = useLoad(() => get<Channel>(`/channels/${encodeURIComponent(props.id)}`), [props.id]);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [newKeys, setNewKeys] = useState("");
  const [reKeys, setReKeys] = useState("");
  const c = ch.data;
  const needKeys = c ? needsKeysForBaseURL(c.baseURL, String(form["baseURL"] ?? ""), c.keys.length) : false;
  useEffect(() => {
    if (!c) return;
    setForm({
      name: c.name,
      baseURL: c.baseURL ?? "",
      enabled: c.enabled,
      priority: String(c.priority),
      keyStrategy: c.keyStrategy,
      keyCooldownSeconds: c.keyCooldownSeconds === null ? "" : String(c.keyCooldownSeconds),
      models: c.models.join("\n"),
    });
  }, [c]);
  const set = (k: string) => (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    setForm((f) => ({ ...f, [k]: el.type === "checkbox" ? el.checked : el.value }));
  };
  const keyOp = async (path: string, method: string, body?: unknown) => {
    if (!c) return;
    try {
      savedToast(
        await api(`/channels/${encodeURIComponent(c.id)}${path}`, {
          method,
          revision: c.revision,
          ...(body ? { body } : {}),
        }),
      );
      ch.reload();
    } catch (err) {
      failed(err);
      if (err instanceof ApiError && err.status === 409) ch.reload();
    }
  };
  return (
    <Drawer title={c?.name ?? t("loading")} onClose={props.onClose} wide>
      <ErrorBox error={ch.error} />
      {!c ? (
        <Loading />
      ) : (
        <div class="stack">
          <form
            class="grid2"
            onSubmit={async (e) => {
              e.preventDefault();
              const cd = String(form["keyCooldownSeconds"] ?? "");
              const apiKeys = reKeys
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((key) => ({ key }));
              if (needKeys && apiKeys.length === 0) {
                setErrors({ apiKeys: t("ch.rekeyRequired") });
                return;
              }
              const body = {
                name: form["name"],
                baseURL: String(form["baseURL"] ?? "") === "" ? null : form["baseURL"],
                enabled: form["enabled"],
                priority: Number(form["priority"]),
                keyStrategy: form["keyStrategy"],
                ...(cd !== "" ? { keyCooldownSeconds: Number(cd) } : {}),
                models: String(form["models"] ?? "")
                  .split(/\s*[\n,]\s*/)
                  .filter(Boolean),
                ...(needKeys ? { apiKeys } : {}),
              };
              try {
                const r = await api(`/channels/${encodeURIComponent(c.id)}`, {
                  method: "PATCH",
                  body,
                  revision: c.revision,
                });
                setErrors({});
                setReKeys("");
                savedToast(r);
                ch.reload();
              } catch (err) {
                const fe = failed(err);
                if (err instanceof ApiError && err.code === "api_keys_required_on_base_url_change") {
                  fe["apiKeys"] = t("ch.rekeyRequired");
                }
                setErrors(fe);
              }
            }}
          >
            <Field label={t("name")} error={errors["name"]}>
              <input value={String(form["name"] ?? "")} onInput={set("name")} disabled={!props.canWrite} />
            </Field>
            <Field label={t("ch.baseURL")} error={errors["baseURL"]} hint={t("ch.baseURLHint")}>
              <input
                value={String(form["baseURL"] ?? "")}
                onInput={set("baseURL")}
                disabled={!props.canWrite}
                placeholder={c.effectiveBaseURL ?? ""}
              />
            </Field>
            {needKeys || errors["apiKeys"] ? (
              <div class="rekey" data-testid="rekey">
                <p class="error-box" role="note">
                  {t("ch.rekeyNotice", { n: String(c.keys.length) })}
                </p>
                <Field label={t("ch.rekeyLabel")} error={errors["apiKeys"]} hint={t("ch.keysHint")}>
                  <textarea
                    rows={2}
                    name="apiKeys"
                    value={reKeys}
                    autocomplete="off"
                    spellcheck={false}
                    disabled={!props.canWrite}
                    onInput={(e) => setReKeys((e.currentTarget as HTMLTextAreaElement).value)}
                  />
                </Field>
              </div>
            ) : null}
            <Field label={t("ch.priority")} error={errors["priority"]}>
              <input
                type="number"
                value={String(form["priority"] ?? "0")}
                onInput={set("priority")}
                disabled={!props.canWrite}
              />
            </Field>
            <Field label={t("ch.keyStrategy")} error={errors["keyStrategy"]}>
              <select
                value={String(form["keyStrategy"] ?? "round_robin")}
                onChange={set("keyStrategy")}
                disabled={!props.canWrite}
              >
                <option value="round_robin">round_robin</option>
                <option value="weighted">weighted</option>
                <option value="fill_first">fill_first</option>
              </select>
            </Field>
            <Field label={t("ch.cooldown")} error={errors["keyCooldownSeconds"]}>
              <input
                type="number"
                min="1"
                max="3600"
                value={String(form["keyCooldownSeconds"] ?? "")}
                onInput={set("keyCooldownSeconds")}
                disabled={!props.canWrite}
                placeholder="30"
              />
            </Field>
            <label class="check">
              <input
                type="checkbox"
                checked={form["enabled"] === true}
                onChange={set("enabled")}
                disabled={!props.canWrite}
              />{" "}
              {t("enabled")}
            </label>
            <Field label={t("ch.models")} error={errors["models"]}>
              <textarea
                rows={4}
                value={String(form["models"] ?? "")}
                onInput={set("models")}
                disabled={!props.canWrite}
              />
            </Field>
            {props.canWrite ? (
              <div class="actions">
                <button type="submit" class="primary">
                  {t("save")}
                </button>
              </div>
            ) : null}
          </form>

          <section>
            <h3>{t("ch.keys")}</h3>
            <table>
              <thead>
                <tr>
                  <th>key</th>
                  <th>{t("status")}</th>
                  <th>{t("ch.weight")}</th>
                  <th>{t("ch.lastError")}</th>
                  <th>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {c.keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <code>{k.hint}</code>
                      {k.kind === "env_ref" ? <span class="muted small"> env</span> : null}
                    </td>
                    <td>
                      <KeyBadge k={k} />
                      {k.cooldownUntil ? <div class="muted small">→ {fmtTime(k.cooldownUntil)}</div> : null}
                    </td>
                    <td>
                      <input
                        class="narrow"
                        type="number"
                        min="0"
                        value={String(k.weight)}
                        disabled={!props.canWrite}
                        onChange={(e) =>
                          void keyOp(`/keys/${k.id}`, "PATCH", {
                            weight: Number((e.currentTarget as HTMLInputElement).value),
                          })
                        }
                      />
                    </td>
                    <td class="small">{k.lastError ? `${k.lastError} (${fmtTime(k.lastErrorAt)})` : "—"}</td>
                    <td class="nowrap">
                      {props.canWrite ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void keyOp(
                                `/keys/${k.id}/${k.enabled && k.status === "ok" ? "disable" : "enable"}`,
                                "POST",
                              )
                            }
                          >
                            {k.enabled && k.status === "ok" ? t("ch.disable") : t("ch.enable")}
                          </button>{" "}
                          <button
                            type="button"
                            class="danger"
                            onClick={() =>
                              confirm(t("confirmDelete", { name: k.hint })) && void keyOp(`/keys/${k.id}`, "DELETE")
                            }
                          >
                            {t("delete")}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {props.canWrite ? (
              <form
                class="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const keys = newKeys
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((key) => ({ key }));
                  if (keys.length === 0) return;
                  await keyOp("/keys", "POST", { keys });
                  setNewKeys("");
                }}
              >
                <Field label={t("ch.addKeys")} hint={t("ch.keysHint")}>
                  <textarea
                    rows={2}
                    value={newKeys}
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(e) => setNewKeys((e.currentTarget as HTMLTextAreaElement).value)}
                  />
                </Field>
                <button type="submit">{t("add")}</button>
              </form>
            ) : null}
          </section>
        </div>
      )}
    </Drawer>
  );
}

// ── Add wizard: preset → keys → test → fetch models → select to publish ──

export function AddChannelWizard(props: { onClose: () => void }) {
  const presets = useLoad(() => get<{ data: Preset[] }>("/presets"));
  const [step, setStep] = useState(1);
  const [preset, setPreset] = useState("deepseek");
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [keys, setKeys] = useState("");
  const [keyStrategy, setKeyStrategy] = useState("round_robin");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [channel, setChannel] = useState<Channel | null>(null);
  const [testResult, setTestResult] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const p = presets.data?.data.find((x) => x.id === preset);

  const create = async () => {
    setBusy(true);
    try {
      const body = {
        name: name || preset,
        preset,
        ...(baseURL ? { baseURL } : {}),
        keyStrategy,
        keys: keys
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((key) => ({ key })),
      };
      const r = await api<Channel>("/channels", { method: "POST", body });
      setErrors({});
      setChannel(r.data);
      savedToast(r);
      setStep(3);
    } catch (err) {
      const f = failed(err);
      setErrors(f);
      if (f["name"] || f["preset"] || f["baseURL"]) setStep(1);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!channel) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; latencyMs: number; error?: string }>(`/channels/${channel.id}/test`, {
        method: "POST",
        body: {},
      });
      setTestResult(r.data.ok ? t("ch.testOk", { ms: r.data.latencyMs }) : t("ch.testFail", { e: r.data.error ?? "" }));
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    if (!channel) return;
    setBusy(true);
    try {
      const r = await api<{ models: string[] }>(`/channels/${channel.id}/fetch-models`, { method: "POST", body: {} });
      setModels(r.data.models);
      setStep(5);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!channel) return;
    setBusy(true);
    try {
      const existing = await get<{ modelSource: string; data: Model[] }>("/models");
      const chosen = Object.entries(selected);
      if (existing.modelSource !== "explicit") {
        // Derived models: the channel's own model list is what it publishes.
        const fresh = await get<Channel>(`/channels/${channel.id}`);
        const r = await api(`/channels/${channel.id}`, {
          method: "PATCH",
          revision: fresh.revision,
          body: { models: [...new Set([...fresh.models, ...chosen.map(([m]) => m)])] },
        });
        savedToast(r);
      } else {
        for (const [upstream, publicName] of chosen) {
          const meta = p?.models.find((m) => m.id === upstream)?.metadata;
          const current = existing.data.find((m) => m.name === publicName);
          if (current) {
            const bindings = [
              ...current.bindings.map((b) => ({
                channelId: b.channelId,
                upstreamModel: b.upstreamModel,
                priority: b.priority,
                weight: b.weight,
                enabled: b.enabled,
              })),
              { channelId: channel.id, upstreamModel: upstream },
            ];
            savedToast(
              await api(`/models/${current.id}/bindings`, {
                method: "PUT",
                revision: current.revision,
                body: { bindings },
              }),
            );
          } else {
            savedToast(
              await api("/models", {
                method: "POST",
                body: {
                  name: publicName,
                  ...(meta ? { metadata: meta } : {}),
                  bindings: [{ channelId: channel.id, upstreamModel: upstream }],
                },
              }),
            );
          }
        }
      }
      notify(t("ch.created"));
      props.onClose();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const steps = ["ch.step1", "ch.step2", "ch.step3", "ch.step4", "ch.step5"] as const;
  return (
    <Modal title={t("ch.add")} onClose={props.onClose}>
      <ol class="steps">
        {steps.map((s, i) => (
          <li key={s} class={i + 1 === step ? "active" : i + 1 < step ? "done" : ""}>
            {t(s)}
          </li>
        ))}
      </ol>
      <ErrorBox error={presets.error} />
      {step === 1 ? (
        <div class="stack">
          <Field label={t("ch.preset")} error={errors["preset"]}>
            <select value={preset} onChange={(e) => setPreset((e.currentTarget as HTMLSelectElement).value)}>
              {(presets.data?.data ?? [])
                .filter((x) => x.adminUsable)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t("name")} error={errors["name"]}>
            <input
              value={name}
              placeholder={preset}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("ch.baseURL")} error={errors["baseURL"]} hint={t("ch.baseURLHint")}>
            <input
              value={baseURL}
              placeholder={p?.baseURL ?? "https://…/v1"}
              onInput={(e) => setBaseURL((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <div class="actions">
            <button
              type="button"
              class="primary"
              disabled={p?.baseURLRequired === true && baseURL === ""}
              onClick={() => setStep(2)}
            >
              {t("next")}
            </button>
          </div>
        </div>
      ) : null}
      {step === 2 ? (
        <div class="stack">
          <Field label={t("ch.keys")} error={errors["keys"]} hint={t("ch.keysHint")}>
            <textarea
              rows={4}
              value={keys}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setKeys((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </Field>
          <Field label={t("ch.keyStrategy")}>
            <select value={keyStrategy} onChange={(e) => setKeyStrategy((e.currentTarget as HTMLSelectElement).value)}>
              <option value="round_robin">round_robin</option>
              <option value="weighted">weighted</option>
              <option value="fill_first">fill_first</option>
            </select>
          </Field>
          <div class="actions">
            <button type="button" onClick={() => setStep(1)}>
              {t("back")}
            </button>
            <button type="button" class="primary" disabled={busy} onClick={() => void create()}>
              {t("create")}
            </button>
          </div>
        </div>
      ) : null}
      {step === 3 ? (
        <div class="stack">
          <p>
            <button type="button" disabled={busy} onClick={() => void test()}>
              {t("ch.test")}
            </button>{" "}
            <span>{testResult}</span>
          </p>
          <div class="actions">
            <button type="button" class="primary" onClick={() => setStep(4)}>
              {t("next")}
            </button>
          </div>
        </div>
      ) : null}
      {step === 4 ? (
        <div class="stack">
          <p>
            <button type="button" class="primary" disabled={busy} onClick={() => void fetchModels()}>
              {t("ch.fetchModels")}
            </button>
          </p>
          <div class="actions">
            <button type="button" onClick={props.onClose}>
              {t("close")}
            </button>
          </div>
        </div>
      ) : null}
      {step === 5 ? (
        <div class="stack">
          <label class="check">
            <input
              type="checkbox"
              checked={models.length > 0 && Object.keys(selected).length === models.length}
              onChange={(e) =>
                setSelected(
                  (e.currentTarget as HTMLInputElement).checked ? Object.fromEntries(models.map((m) => [m, m])) : {},
                )
              }
            />{" "}
            {t("ch.selectAll")}
          </label>
          <div class="model-pick">
            {models.map((m) => (
              <div key={m} class="pick-row">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={selected[m] !== undefined}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = { ...s };
                        if ((e.currentTarget as HTMLInputElement).checked) n[m] = m;
                        else delete n[m];
                        return n;
                      })
                    }
                  />{" "}
                  {m}
                </label>
                {selected[m] !== undefined ? (
                  <input
                    aria-label={t("ch.publishedAs")}
                    value={selected[m]}
                    onInput={(e) => setSelected((s) => ({ ...s, [m]: (e.currentTarget as HTMLInputElement).value }))}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <div class="actions">
            <button type="button" onClick={props.onClose}>
              {t("close")}
            </button>
            <button
              type="button"
              class="primary"
              disabled={busy || Object.keys(selected).length === 0}
              onClick={() => void publish()}
            >
              {t("ch.publish")}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
