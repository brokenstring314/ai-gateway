/** 模型: published models table + edit drawer (metadata, bindings with drag-to-reorder priority). */
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PageProps } from "../app";
import { type Channel, type Model, type ModelMeta, ApiError, api, get } from "../api";
import { DICTIONARY, fmtNum, type MsgKey, t } from "../i18n";
import {
  Badge,
  Drawer,
  ErrorBox,
  Field,
  type FieldErrors,
  Loading,
  TableWrap,
  failed,
  notify,
  savedToast,
  useLoad,
} from "../ui";
import { keyState } from "./channels";

/** Enum value → "label" in the console's language, falling back to the value. */
function enumLabel(prefix: string, v: string): string {
  const key = `${prefix}.${v}`;
  return DICTIONARY[key] ? t(key as MsgKey) : v;
}

/** Bindings as the router uses them (U6): loadbalance = one weighted set; fallback = priority groups in order. */
export function bindingGroups(m: Pick<Model, "strategy" | "bindings">): {
  balanced: boolean;
  groups: Array<Array<{ label: string; weight: number; share: number; enabled: boolean }>>;
} {
  const balanced = m.strategy === "loadbalance";
  const sorted = [...m.bindings].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const buckets: Array<typeof sorted> = [];
  if (balanced) buckets.push(sorted);
  else
    for (const b of sorted) {
      const last = buckets[buckets.length - 1];
      if (last && (last[0]?.priority ?? 0) === (b.priority ?? 0)) last.push(b);
      else buckets.push([b]);
    }
  return {
    balanced,
    groups: buckets.map((g) => {
      const total = g.reduce((n, b) => n + (b.enabled === false ? 0 : (b.weight ?? 1)), 0);
      return g.map((b) => {
        const w = b.weight ?? 1;
        return {
          label: `${b.channel ?? b.channelId ?? "?"}:${b.upstreamModel ?? ""}`,
          weight: w,
          share: total > 0 && b.enabled !== false ? Math.round((w / total) * 100) : 0,
          enabled: b.enabled !== false,
        };
      });
    }),
  };
}

function BindingsSummary(props: { model: Model }) {
  const { balanced, groups } = bindingGroups(props.model);
  if (groups.length === 0 || groups[0]!.length === 0) return <span class="muted">{t("none")}</span>;
  const chip = (b: (typeof groups)[number][number], showShare: boolean, key: string) => (
    <span key={key} class={`chip${b.enabled ? "" : " dim"}`} title={`${t("ch.weight")} ${b.weight}`}>
      {b.label}
      {showShare ? <span class="muted"> {b.share}%</span> : null}
    </span>
  );
  if (balanced) {
    return (
      <span class="lb-set" title={t("m.lbSet")}>
        <span class="muted">⇄</span>
        {groups[0]!.map((b, i) => chip(b, groups[0]!.length > 1, `${i}`))}
      </span>
    );
  }
  return (
    <span class="lb-set">
      {groups.map((g, gi) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional
        <Fragment key={gi}>
          {gi > 0 ? <span class="chain-sep">→</span> : null}
          {g.map((b, bi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: members are positional
            <Fragment key={bi}>
              {bi > 0 ? <span class="chain-sep">+</span> : null}
              {chip(b, g.length > 1, `${gi}-${bi}`)}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/** Every key of every channel the enabled bindings use is unusable (U7). */
export function bindingKeysDown(m: Pick<Model, "bindings">, channels: readonly Channel[]): boolean {
  const used = m.bindings.filter((b) => b.enabled !== false).map((b) => channels.find((c) => c.id === b.channelId));
  if (used.length === 0 || used.some((c) => c === undefined)) return false;
  return used.every((c) => c!.keys.length > 0 && c!.keys.every((k) => keyState(k) === "disabled"));
}

interface ModelsResponse {
  modelSource: "explicit" | "derived";
  readOnly?: boolean;
  data: Array<Model & { available?: boolean }>;
  published: Array<{ name: string; enabled: boolean; available: boolean; channels: string[] }>;
}

export function ModelsPage(props: PageProps) {
  const list = useLoad(() => get<ModelsResponse>("/models"));
  const channels = useLoad(() => get<{ data: Channel[] }>("/channels"));
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const explicit = list.data?.modelSource === "explicit";
  const canWrite = props.canWrite && explicit && list.data?.readOnly !== true;

  return (
    <div class="stack">
      <div class="toolbar">
        {canWrite ? (
          <button type="button" class="primary" onClick={() => setEditing("new")}>
            {t("m.add")}
          </button>
        ) : null}
        <button type="button" onClick={list.reload}>
          {t("refresh")}
        </button>
      </div>
      <ErrorBox error={list.error} />
      {list.data && !explicit ? <p class="note">{t("m.derived")}</p> : null}
      {list.loading && !list.data ? (
        <Loading />
      ) : explicit ? (
        <TableWrap>
          <table class="card">
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("status")}</th>
                <th>{t("m.strategy")}</th>
                <th>{t("m.bindings")}</th>
                <th>{t("m.contextWindow")}</th>
                <th>{t("m.maxOutput")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong>
                    {m.displayName ? <div class="muted small">{m.displayName}</div> : null}
                  </td>
                  <td>
                    {!m.enabled ? (
                      <Badge kind="muted">{t("disabled")}</Badge>
                    ) : m.available ? (
                      <Badge kind="ok">{t("m.available")}</Badge>
                    ) : (
                      <Badge kind="bad">{t("m.unavailable")}</Badge>
                    )}
                    {m.enabled && m.available && bindingKeysDown(m, channels.data?.data ?? []) ? (
                      <Badge kind="warn">{t("m.keysDown")}</Badge>
                    ) : null}
                  </td>
                  <td class="small">
                    {enumLabel("ms", m.strategy ?? "fallback")}
                    {m.bindings.length > 1 ? <div class="muted">{enumLabel("mb", m.balance ?? "weighted")}</div> : null}
                  </td>
                  <td class="small">
                    <BindingsSummary model={m} />
                  </td>
                  <td>{fmtNum(m.metadata.contextWindow)}</td>
                  <td>{fmtNum(m.metadata.maxOutputTokens)}</td>
                  <td>
                    <button type="button" onClick={() => setEditing(m.id)}>
                      {canWrite ? t("edit") : t("view")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <TableWrap>
          <table class="card">
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("status")}</th>
                <th>{t("nav.channels")}</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.published ?? []).map((m) => (
                <tr key={m.name}>
                  <td>{m.name}</td>
                  <td>
                    {m.available ? (
                      <Badge kind="ok">{t("m.available")}</Badge>
                    ) : (
                      <Badge kind="bad">{t("m.unavailable")}</Badge>
                    )}
                  </td>
                  <td>{m.channels.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing ? (
        <ModelDrawer
          id={editing}
          canWrite={canWrite}
          channels={channels.data?.data ?? []}
          onClose={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

export interface BindingRow {
  key: number;
  channelId: string;
  upstreamModel: string;
  /** Same priority group as the row above (balanced by weight with it). */
  sameAsPrev: boolean;
  weight: number;
  enabled: boolean;
  params?: Record<string, unknown>;
}

/** Rows (top = first) → API bindings: each row starts a new priority group unless it joins the one above. */
export function rowsToBindings(rows: readonly BindingRow[]) {
  let group = -1;
  return rows.map((r, i) => {
    if (i === 0 || !r.sameAsPrev) group++;
    return {
      channelId: r.channelId,
      ...(r.upstreamModel ? { upstreamModel: r.upstreamModel } : {}),
      priority: group,
      weight: r.weight,
      enabled: r.enabled,
      ...(r.params && Object.keys(r.params).length > 0 ? { params: r.params } : {}),
    };
  });
}

let rowKey = 0;
export function bindingsToRows(bindings: Model["bindings"]): BindingRow[] {
  const sorted = [...bindings].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return sorted.map((b, i) => ({
    key: ++rowKey,
    channelId: b.channelId ?? "",
    upstreamModel: b.upstreamModel ?? "",
    sameAsPrev: i > 0 && (b.priority ?? 0) === (sorted[i - 1]?.priority ?? 0),
    weight: b.weight ?? 1,
    enabled: b.enabled !== false,
    ...(b.params ? { params: b.params } : {}),
  }));
}

/** Move the row at `from` to `to`. */
export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows];
  const [r] = next.splice(from, 1);
  if (r === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, r);
  return next;
}

type Tri = "" | "true" | "false";
const tri = (v: boolean | undefined): Tri => (v === undefined ? "" : v ? "true" : "false");
const fromTri = (v: Tri): boolean | undefined => (v === "" ? undefined : v === "true");

export function ModelDrawer(props: { id: string; canWrite: boolean; channels: Channel[]; onClose: () => void }) {
  const isNew = props.id === "new";
  const loaded = useLoad(
    () => (isNew ? Promise.resolve(undefined) : get<Model>(`/models/${encodeURIComponent(props.id)}`)),
    [props.id],
  );
  const m = loaded.data;
  const [f, setF] = useState({
    name: "",
    displayName: "",
    description: "",
    enabled: true,
    strategy: "fallback",
    balance: "weighted",
  });
  const [meta, setMeta] = useState<ModelMeta>({});
  const [efforts, setEfforts] = useState("");
  const [rows, setRows] = useState<BindingRow[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!m) return;
    setF({
      name: m.name,
      displayName: m.displayName ?? "",
      description: m.description ?? "",
      enabled: m.enabled,
      strategy: m.strategy ?? "fallback",
      balance: m.balance ?? "weighted",
    });
    setMeta(m.metadata ?? {});
    setEfforts(typeof m.metadata?.reasoning === "object" ? (m.metadata.reasoning.efforts ?? []).join(", ") : "");
    setRows(bindingsToRows(m.bindings));
  }, [m]);

  const ro = !props.canWrite;
  const lb = f.strategy === "loadbalance";
  const setMetaField = <K extends keyof ModelMeta>(k: K, v: ModelMeta[K] | undefined) =>
    setMeta((x) => {
      const n = { ...x };
      if (v === undefined || (typeof v === "number" && Number.isNaN(v))) delete n[k];
      else n[k] = v;
      return n;
    });
  const reasoningMode =
    meta.reasoning === undefined ? "" : meta.reasoning === true ? "on" : meta.reasoning === false ? "off" : "efforts";

  const initial = m
    ? {
        f: {
          name: m.name,
          displayName: m.displayName ?? "",
          description: m.description ?? "",
          enabled: m.enabled,
          strategy: m.strategy ?? "fallback",
          balance: m.balance ?? "weighted",
        },
        meta: m.metadata ?? {},
        efforts: typeof m.metadata?.reasoning === "object" ? (m.metadata.reasoning.efforts ?? []).join(", ") : "",
        bindings: JSON.stringify(rowsToBindings(bindingsToRows(m.bindings))),
      }
    : undefined;
  const bindingsNow = JSON.stringify(rowsToBindings(rows));
  const dirty = isNew
    ? f.name !== "" || rows.length > 0
    : initial !== undefined &&
      (JSON.stringify(f) !== JSON.stringify(initial.f) ||
        JSON.stringify(meta) !== JSON.stringify(initial.meta) ||
        efforts !== initial.efforts ||
        bindingsNow !== initial.bindings);

  const save = async () => {
    setBusy(true);
    const metadata: ModelMeta = { ...meta };
    if (reasoningMode === "efforts") {
      const list = efforts
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const prev = typeof meta.reasoning === "object" ? meta.reasoning : {};
      metadata.reasoning = { ...prev, ...(list.length > 0 ? { efforts: list } : {}) };
    }
    const fields = {
      name: f.name,
      // A cleared field is sent as null so the server clears it; omitting it kept the old value (review 2026-11-02 U3).
      displayName: f.displayName.trim() === "" ? null : f.displayName,
      description: f.description.trim() === "" ? null : f.description,
      enabled: f.enabled,
      strategy: f.strategy,
      balance: f.balance,
      metadata,
    };
    try {
      if (isNew) {
        const r = await api<Model>("/models", { method: "POST", body: { ...fields, bindings: rowsToBindings(rows) } });
        savedToast(r);
      } else if (m && initial) {
        // Only what changed (U9: the version summary then names just those fields), and in ONE request:
        // fields and bindings change together or not at all (review 2026-11-02 U5).
        const body: Record<string, unknown> = {};
        const before = {
          ...initial.f,
          displayName: initial.f.displayName.trim() === "" ? null : initial.f.displayName,
          description: initial.f.description.trim() === "" ? null : initial.f.description,
        };
        for (const [k, v] of Object.entries(fields)) {
          if (k === "metadata") {
            if (JSON.stringify(v) !== JSON.stringify(initial.meta)) body[k] = v;
          } else if (JSON.stringify(v) !== JSON.stringify((before as Record<string, unknown>)[k])) body[k] = v;
        }
        if (bindingsNow !== initial.bindings) body["bindings"] = rowsToBindings(rows);
        if (Object.keys(body).length === 0) {
          notify(t("noChanges"));
          setErrors({});
          props.onClose();
          return;
        }
        const r = await api<Model>(`/models/${m.id}`, { method: "PATCH", revision: m.revision, body });
        savedToast(r);
      }
      setErrors({});
      props.onClose();
    } catch (err) {
      setErrors(failed(err));
      if (err instanceof ApiError && err.status === 409) loaded.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={isNew ? t("m.add") : (m?.name ?? t("loading"))} onClose={props.onClose} wide dirty={!ro && dirty}>
      <ErrorBox error={loaded.error} />
      {!isNew && !m ? (
        <Loading />
      ) : (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div class="grid2">
            <Field label={t("name")} error={errors["name"]}>
              <input
                required
                value={f.name}
                disabled={ro}
                onInput={(e) => setF({ ...f, name: (e.currentTarget as HTMLInputElement).value })}
              />
            </Field>
            <Field label={t("m.displayName")} error={errors["displayName"]}>
              <input
                value={f.displayName}
                disabled={ro}
                onInput={(e) => setF({ ...f, displayName: (e.currentTarget as HTMLInputElement).value })}
              />
            </Field>
            <Field label={t("m.description")} error={errors["description"]}>
              <input
                value={f.description}
                disabled={ro}
                onInput={(e) => setF({ ...f, description: (e.currentTarget as HTMLInputElement).value })}
              />
            </Field>
            <label class="check">
              <input
                type="checkbox"
                checked={f.enabled}
                disabled={ro}
                onChange={(e) => setF({ ...f, enabled: (e.currentTarget as HTMLInputElement).checked })}
              />{" "}
              {t("enabled")}
            </label>
            <Field label={t("m.strategy")} error={errors["strategy"]}>
              <select
                value={f.strategy}
                disabled={ro}
                onChange={(e) => setF({ ...f, strategy: (e.currentTarget as HTMLSelectElement).value })}
              >
                {["fallback", "loadbalance"].map((v) => (
                  <option key={v} value={v}>
                    {enumLabel("ms", v)} ({v})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("m.balance")} error={errors["balance"]}>
              <select
                value={f.balance}
                disabled={ro}
                onChange={(e) => setF({ ...f, balance: (e.currentTarget as HTMLSelectElement).value })}
              >
                {["weighted", "round_robin", "least_inflight"].map((v) => (
                  <option key={v} value={v}>
                    {enumLabel("mb", v)} ({v})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <section>
            <h3>{t("m.bindings")}</h3>
            <p class="muted small">{lb ? t("m.lbHint") : t("m.dragHint")}</p>
            {errors["bindings"] ? <p class="field-error">{errors["bindings"]}</p> : null}
            {rows.length === 0 && !ro ? <p class="note small">{t("m.noBindings")}</p> : null}
            <TableWrap>
              <table class="bindings">
                <thead>
                  <tr>
                    <th />
                    <th>{lb ? t("m.share") : t("m.priorityGroup")}</th>
                    <th>{t("nav.channels")}</th>
                    <th>{t("m.upstreamModel")}</th>
                    <th>{t("ch.weight")}</th>
                    <th>{t("enabled")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const group = rowsToBindings(rows)[i]?.priority ?? 0;
                    const upd = (patch: Partial<BindingRow>) =>
                      setRows(rows.map((x) => (x.key === r.key ? { ...x, ...patch } : x)));
                    return (
                      <tr
                        key={r.key}
                        draggable={!ro}
                        class={drag === i ? "dragging" : ""}
                        onDragStart={(e) => {
                          setDrag(i);
                          e.dataTransfer?.setData("text/plain", String(i));
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (drag !== null) setRows(moveRow(rows, drag, i));
                          setDrag(null);
                        }}
                        onDragEnd={() => setDrag(null)}
                      >
                        <td class="handle" title={t("m.drag")}>
                          ⠿
                        </td>
                        <td class="nowrap">
                          {lb ? `${lbShare(rows, i)}%` : `#${group}`}
                          {i > 0 && !lb ? (
                            <label class="check small" title={t("m.sameGroup")}>
                              <input
                                type="checkbox"
                                checked={r.sameAsPrev}
                                disabled={ro}
                                onChange={(e) => upd({ sameAsPrev: (e.currentTarget as HTMLInputElement).checked })}
                              />{" "}
                              =↑
                            </label>
                          ) : null}
                        </td>
                        <td>
                          <select
                            value={r.channelId}
                            disabled={ro}
                            onChange={(e) => upd({ channelId: (e.currentTarget as HTMLSelectElement).value })}
                          >
                            <option value="">—</option>
                            {props.channels.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            value={r.upstreamModel}
                            disabled={ro}
                            list={`models-${r.channelId}`}
                            onInput={(e) => upd({ upstreamModel: (e.currentTarget as HTMLInputElement).value })}
                          />
                          <datalist id={`models-${r.channelId}`}>
                            {(props.channels.find((c) => c.id === r.channelId)?.models ?? []).map((x) => (
                              <option key={x} value={x} />
                            ))}
                          </datalist>
                        </td>
                        <td>
                          <input
                            class="narrow"
                            type="number"
                            min="0"
                            value={String(r.weight)}
                            disabled={ro}
                            onInput={(e) => upd({ weight: Number((e.currentTarget as HTMLInputElement).value) })}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            disabled={ro}
                            onChange={(e) => upd({ enabled: (e.currentTarget as HTMLInputElement).checked })}
                          />
                        </td>
                        <td class="nowrap">
                          {!ro ? (
                            <>
                              <button
                                type="button"
                                class="ghost"
                                disabled={i === 0}
                                onClick={() => setRows(moveRow(rows, i, i - 1))}
                                aria-label={t("m.up")}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                class="ghost"
                                disabled={i === rows.length - 1}
                                onClick={() => setRows(moveRow(rows, i, i + 1))}
                                aria-label={t("m.down")}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                class="ghost danger"
                                onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                                aria-label={t("delete")}
                              >
                                ×
                              </button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            {!ro ? (
              <button
                type="button"
                onClick={() =>
                  setRows([
                    ...rows,
                    {
                      key: ++rowKey,
                      channelId: props.channels[0]?.id ?? "",
                      upstreamModel: "",
                      sameAsPrev: false,
                      weight: 1,
                      enabled: true,
                    },
                  ])
                }
              >
                {t("m.addBinding")}
              </button>
            ) : null}
          </section>

          <section>
            <h3>{t("m.metadata")}</h3>
            {errors["metadata"] ? <p class="field-error">{errors["metadata"]}</p> : null}
            <div class="grid2">
              <Field label={t("m.contextWindow")} error={errors["metadata.contextWindow"]}>
                <input
                  type="number"
                  min="1"
                  disabled={ro}
                  value={meta.contextWindow ?? ""}
                  onInput={(e) =>
                    setMetaField("contextWindow", numOrUndef((e.currentTarget as HTMLInputElement).value))
                  }
                />
              </Field>
              <Field label={t("m.maxOutput")} error={errors["metadata.maxOutputTokens"]}>
                <input
                  type="number"
                  min="1"
                  disabled={ro}
                  value={meta.maxOutputTokens ?? ""}
                  onInput={(e) =>
                    setMetaField("maxOutputTokens", numOrUndef((e.currentTarget as HTMLInputElement).value))
                  }
                />
              </Field>
              <Field label={t("m.inputs")} error={errors["metadata.inputModalities"]}>
                <div class="checks">
                  {["text", "image", "audio", "video", "pdf"].map((mod) => (
                    <label key={mod} class="check">
                      <input
                        type="checkbox"
                        disabled={ro}
                        checked={(meta.inputModalities ?? []).includes(mod)}
                        onChange={(e) => {
                          const on = (e.currentTarget as HTMLInputElement).checked;
                          const cur = new Set(meta.inputModalities ?? []);
                          if (on) cur.add(mod);
                          else cur.delete(mod);
                          setMetaField("inputModalities", cur.size > 0 ? [...cur] : undefined);
                        }}
                      />{" "}
                      {mod}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label={t("m.structured")} error={errors["metadata.structuredOutput"]}>
                <select
                  disabled={ro}
                  value={meta.structuredOutput ?? ""}
                  onChange={(e) =>
                    setMetaField("structuredOutput", (e.currentTarget as HTMLSelectElement).value || undefined)
                  }
                >
                  <option value="">{t("m.inherit")}</option>
                  <option value="none">none</option>
                  <option value="json_object">json_object</option>
                  <option value="json_schema">json_schema</option>
                </select>
              </Field>
              {(
                [
                  ["tools", "m.tools"],
                  ["parallelTools", "m.parallelTools"],
                  ["webSearch", "m.webSearch"],
                  ["logprobs", "m.logprobs"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={t(label)} error={errors[`metadata.${k}`]}>
                  <select
                    disabled={ro}
                    value={tri(meta[k])}
                    onChange={(e) => setMetaField(k, fromTri((e.currentTarget as HTMLSelectElement).value as Tri))}
                  >
                    <option value="">{t("m.inherit")}</option>
                    <option value="true">{t("yes")}</option>
                    <option value="false">{t("no")}</option>
                  </select>
                </Field>
              ))}
              <Field label={t("m.systemMessage")} error={errors["metadata.systemMessage"]}>
                <select
                  disabled={ro}
                  value={meta.systemMessage ?? ""}
                  onChange={(e) =>
                    setMetaField("systemMessage", (e.currentTarget as HTMLSelectElement).value || undefined)
                  }
                >
                  <option value="">{t("m.inherit")}</option>
                  <option value="supported">supported</option>
                  <option value="merge_into_user">merge_into_user</option>
                </select>
              </Field>
              <Field label={t("m.developerRole")} error={errors["metadata.developerRole"]}>
                <select
                  disabled={ro}
                  value={meta.developerRole ?? ""}
                  onChange={(e) =>
                    setMetaField("developerRole", (e.currentTarget as HTMLSelectElement).value || undefined)
                  }
                >
                  <option value="">{t("m.inherit")}</option>
                  <option value="as_system">as_system</option>
                  <option value="passthrough">passthrough</option>
                </select>
              </Field>
              <Field label={t("m.reasoning")} error={errors["metadata.reasoning"]}>
                <select
                  disabled={ro}
                  value={reasoningMode}
                  onChange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    setMetaField(
                      "reasoning",
                      v === ""
                        ? undefined
                        : v === "on"
                          ? true
                          : v === "off"
                            ? false
                            : typeof meta.reasoning === "object"
                              ? meta.reasoning
                              : {},
                    );
                  }}
                >
                  <option value="">{t("m.inherit")}</option>
                  <option value="off">{t("no")}</option>
                  <option value="on">{t("yes")}</option>
                  <option value="efforts">efforts</option>
                </select>
              </Field>
              {reasoningMode === "efforts" ? (
                <Field label={t("m.reasoningEfforts")}>
                  <input
                    disabled={ro}
                    value={efforts}
                    placeholder="low, medium, high"
                    onInput={(e) => setEfforts((e.currentTarget as HTMLInputElement).value)}
                  />
                </Field>
              ) : null}
            </div>
          </section>

          {!ro ? (
            <div class="actions sticky">
              {!isNew && m ? (
                <button
                  type="button"
                  class="danger"
                  onClick={async () => {
                    if (!confirm(t("confirmDelete", { name: m.name }))) return;
                    try {
                      savedToast(await api(`/models/${m.id}`, { method: "DELETE", revision: m.revision }));
                      props.onClose();
                    } catch (err) {
                      failed(err);
                    }
                  }}
                >
                  {t("delete")}
                </button>
              ) : null}
              <button type="submit" class="primary" disabled={busy}>
                {t("save")}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </Drawer>
  );
}

/** Row i's share of traffic in a load-balanced model (enabled rows, by weight). */
function lbShare(rows: readonly BindingRow[], i: number): number {
  const total = rows.reduce((n, r) => n + (r.enabled ? Math.max(0, r.weight) : 0), 0);
  const r = rows[i];
  return r && r.enabled && total > 0 ? Math.round((Math.max(0, r.weight) / total) * 100) : 0;
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
