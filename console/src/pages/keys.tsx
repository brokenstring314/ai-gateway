/** 密钥: create (allowed models, token quota, RPM/TPM, expiry; plaintext once), usage, limits, reset. */
import { useState } from "preact/hooks";
import type { PageProps } from "../app";
import { type ClientKey, ApiError, api, get } from "../api";
import { DICTIONARY, fmtNum, fmtTime, type MsgKey, t } from "../i18n";
import {
  Badge,
  CopyButton,
  Drawer,
  ErrorBox,
  Field,
  type FieldErrors,
  Loading,
  Modal,
  TableWrap,
  failed,
  notify,
  numOrNull,
  useLoad,
} from "../ui";

function useModelNames() {
  return useLoad(async () => {
    const r = await get<{ published?: Array<{ name: string }> }>("/models");
    return (r.published ?? []).map((m) => m.name);
  });
}

/** Scope code → label ("调用模型 (inference)"); unknown scopes as sent. */
export function scopeLabel(scope: string): string {
  const key = `scope.${scope}`;
  return DICTIONARY[key] ? t(key as MsgKey) : scope;
}

export function KeysPage(props: PageProps) {
  // `{ keys }` today; `{ data }` if the list moves to the other list endpoints' shape (U16).
  const list = useLoad(async () => {
    const r = await get<{ keys?: ClientKey[]; data?: ClientKey[] }>("/keys");
    return { keys: r.keys ?? r.data ?? [] };
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ClientKey | null>(null);
  /** A secret to show once: from create, or from rotate (with the key's name). */
  const [plaintext, setPlaintext] = useState<{ key: string; title: string } | null>(null);

  return (
    <div class="stack">
      <div class="toolbar">
        {props.canWrite ? (
          <button type="button" class="primary" onClick={() => setCreating(true)}>
            {t("k.create")}
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
        <TableWrap>
          <table class="card">
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("k.scopes")}</th>
                <th>{t("k.allowedModels")}</th>
                <th>{t("k.limits")}</th>
                <th>{t("k.used")}</th>
                <th>{t("k.expires")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.keys ?? []).map((k) => {
                const revoked = k.revokedAt !== null && k.revokedAt !== undefined;
                const pct = k.quotaTokens ? Math.min(100, (k.usedTokens / k.quotaTokens) * 100) : 0;
                return (
                  <tr key={k.id} class={revoked ? "dim" : ""}>
                    <td>
                      <strong>{k.name}</strong>
                      <div class="muted small">
                        <code>{(k as { keyDisplay?: string }).keyDisplay ?? k.id}</code>
                      </div>
                      {revoked ? <Badge kind="muted">{t("k.revoked")}</Badge> : null}
                      {k.quotaExhausted ? <Badge kind="bad">{t("k.exhausted")}</Badge> : null}
                    </td>
                    <td class="small">{k.scopes.map(scopeLabel).join(t("listSep"))}</td>
                    <td class="small">
                      {k.allowedModels === null ? (
                        t("k.allModels")
                      ) : k.allowedModels.length === 0 ? (
                        <Badge kind="bad">{t("k.noModels")}</Badge>
                      ) : (
                        k.allowedModels.join(", ")
                      )}
                    </td>
                    <td class="small">
                      {t("k.quota")}: {k.quotaTokens === null ? t("unlimited") : fmtNum(k.quotaTokens)}
                      <br />
                      RPM {k.rpm ?? "—"} · TPM {k.tpm === null ? "—" : fmtNum(k.tpm)}
                    </td>
                    <td>
                      {fmtNum(k.usedTokens)}
                      {k.quotaTokens !== null ? (
                        <>
                          <div class="meter">
                            <span style={{ width: `${pct}%` }} class={pct >= 100 ? "full" : ""} />
                          </div>
                          <span class="muted small">
                            {t("k.remaining")} {fmtNum(k.remainingTokens)}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td class="small">{k.expiresAt ? fmtTime(k.expiresAt) : "—"}</td>
                    <td class="nowrap">
                      {props.canWrite && !revoked ? (
                        <>
                          <button type="button" onClick={() => setEditing(k)}>
                            {t("edit")}
                          </button>{" "}
                          <button
                            type="button"
                            onClick={async () => {
                              if (!confirm(t("k.confirmReset", { name: k.name }))) return;
                              try {
                                await api(`/keys/${k.id}/reset-usage`, { method: "POST", revision: k.revision });
                                notify(t("saved"));
                                list.reload();
                              } catch (err) {
                                failed(err);
                              }
                            }}
                          >
                            {t("k.resetUsage")}
                          </button>{" "}
                          <button
                            type="button"
                            onClick={async () => {
                              if (!confirm(t("k.confirmRotate", { name: k.name }))) return;
                              try {
                                const r = await api<{ key: string; name?: string }>(`/keys/${k.id}/rotate`, {
                                  method: "POST",
                                });
                                setPlaintext({
                                  key: r.data.key,
                                  title: t("k.rotated", { name: r.data.name ?? k.name }),
                                });
                                list.reload();
                              } catch (err) {
                                failed(err);
                              }
                            }}
                          >
                            {t("k.rotate")}
                          </button>{" "}
                          <button
                            type="button"
                            class="danger"
                            onClick={async () => {
                              if (!confirm(t("k.confirmRevoke", { name: k.name }))) return;
                              try {
                                await api(`/keys/${k.id}/revoke`, { method: "POST" });
                                notify(t("saved"));
                                list.reload();
                              } catch (err) {
                                failed(err);
                              }
                            }}
                          >
                            {t("k.revoke")}
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
      )}
      {creating ? (
        <KeyForm
          onClose={() => setCreating(false)}
          onCreated={(plain) => {
            setCreating(false);
            setPlaintext({ key: plain, title: t("k.create") });
            list.reload();
          }}
        />
      ) : null}
      {editing ? (
        <KeyForm
          existing={editing}
          onClose={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
      {plaintext ? (
        <Modal title={plaintext.title} onClose={() => setPlaintext(null)}>
          <p>{t("k.plaintextOnce")}</p>
          <p class="secret">
            <code>{plaintext.key}</code> <CopyButton text={plaintext.key} />
          </p>
          <div class="actions">
            <button type="button" class="primary" onClick={() => setPlaintext(null)}>
              {t("close")}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function KeyForm(props: { existing?: ClientKey; onClose: () => void; onCreated?: (plaintext: string) => void }) {
  const ex = props.existing;
  const models = useModelNames();
  const [name, setName] = useState(ex?.name ?? "");
  const [scope, setScope] = useState(ex?.scopes[0] ?? "inference");
  // null = every model; [] = none (review 2026-11-02 U2: [] used to be saved back as null, widening the key).
  const [restricted, setRestricted] = useState(ex !== undefined && ex.allowedModels !== null);
  const [allowed, setAllowed] = useState<string[]>(ex?.allowedModels ?? []);
  const [quota, setQuota] = useState(
    ex?.quotaTokens === null || ex?.quotaTokens === undefined ? "" : String(ex.quotaTokens),
  );
  const [rpm, setRpm] = useState(ex?.rpm === null || ex?.rpm === undefined ? "" : String(ex.rpm));
  const [tpm, setTpm] = useState(ex?.tpm === null || ex?.tpm === undefined ? "" : String(ex.tpm));
  const [expires, setExpires] = useState(toLocalInput(ex?.expiresAt ?? null));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const Wrap = ex ? Drawer : Modal;
  const dirty =
    name !== (ex?.name ?? "") ||
    restricted !== (ex !== undefined && ex.allowedModels !== null) ||
    JSON.stringify(allowed) !== JSON.stringify(ex?.allowedModels ?? []) ||
    quota !== (ex?.quotaTokens == null ? "" : String(ex.quotaTokens)) ||
    rpm !== (ex?.rpm == null ? "" : String(ex.rpm)) ||
    tpm !== (ex?.tpm == null ? "" : String(ex.tpm)) ||
    expires !== toLocalInput(ex?.expiresAt ?? null);

  return (
    <Wrap title={ex ? ex.name : t("k.create")} onClose={props.onClose} dirty={dirty}>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const body = {
            name,
            allowedModels: restricted ? allowed : null,
            quotaTokens: numOrNull(quota),
            rpm: numOrNull(rpm),
            tpm: numOrNull(tpm),
            expiresAt: expires ? new Date(expires).toISOString() : null,
          };
          try {
            if (ex) {
              await api(`/keys/${ex.id}`, { method: "PATCH", revision: ex.revision, body });
              notify(t("saved"));
              props.onClose();
            } else {
              const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
              const r = await api<{ key: string }>("/keys", { method: "POST", body: { ...clean, scopes: [scope] } });
              props.onCreated?.(r.data.key);
            }
          } catch (err) {
            setErrors(failed(err));
            if (err instanceof ApiError && err.status === 409) props.onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("name")} error={errors["name"]}>
          <input required value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </Field>
        {!ex ? (
          <Field label={t("k.scopes")} error={errors["scopes"]}>
            <select value={scope} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value)}>
              {["inference", "read_only", "admin"].map((sc) => (
                <option key={sc} value={sc}>
                  {scopeLabel(sc)} ({sc})
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {/* A fieldset, not a <label>: a click on its title must not toggle the first radio / checkbox. */}
        <fieldset class={`field${errors["allowedModels"] ? " invalid" : ""}`}>
          <legend class="label">{t("k.allowedModels")}</legend>
          <div class="stack">
            <div class="checks" role="radiogroup">
              <label class="check">
                <input
                  type="radio"
                  name="allowed-mode"
                  value="all"
                  checked={!restricted}
                  onChange={() => setRestricted(false)}
                />{" "}
                {t("k.allModels")}
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="allowed-mode"
                  value="some"
                  checked={restricted}
                  onChange={() => setRestricted(true)}
                />{" "}
                {t("k.someModels")}
              </label>
            </div>
            <div class="checks">
              {/* Published models plus any model the key already allows (kept even if no longer published). */}
              {[...new Set([...(models.data ?? []), ...allowed])].map((m) => (
                <label key={m} class="check">
                  <input
                    type="checkbox"
                    checked={restricted && allowed.includes(m)}
                    onChange={(e) => {
                      const on = (e.currentTarget as HTMLInputElement).checked;
                      // Checking a model while "all models" is selected switches to the restricted list.
                      const base = restricted ? allowed : [];
                      setRestricted(true);
                      setAllowed(on ? [...base.filter((x) => x !== m), m] : base.filter((x) => x !== m));
                    }}
                  />{" "}
                  {m}
                </label>
              ))}
            </div>
            {restricted && allowed.length === 0 ? (
              <p class="field-error" role="alert">
                {t("k.noModelsWarn")}
              </p>
            ) : null}
          </div>
          {errors["allowedModels"] ? (
            <span class="field-error" role="alert">
              {errors["allowedModels"]}
            </span>
          ) : null}
        </fieldset>
        <div class="grid2">
          <Field label={t("k.quota")} error={errors["quotaTokens"]} hint={t("unlimited")}>
            <input
              type="number"
              min="0"
              value={quota}
              onInput={(e) => setQuota((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("k.expires")} error={errors["expiresAt"]}>
            <input
              type="datetime-local"
              value={expires}
              onInput={(e) => setExpires((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("k.rpm")} error={errors["rpm"]}>
            <input
              type="number"
              min="1"
              value={rpm}
              onInput={(e) => setRpm((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("k.tpm")} error={errors["tpm"]}>
            <input
              type="number"
              min="1"
              value={tpm}
              onInput={(e) => setTpm((e.currentTarget as HTMLInputElement).value)}
            />
          </Field>
        </div>
        <div class="actions">
          <button type="button" onClick={props.onClose}>
            {t("cancel")}
          </button>
          <button type="submit" class="primary" disabled={busy}>
            {ex ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </Wrap>
  );
}
