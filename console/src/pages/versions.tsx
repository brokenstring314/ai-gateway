/** 版本与审计: config versions, diff between versions, rollback; audit log. */
import { useState } from "preact/hooks";
import type { PageProps } from "../app";
import { api, get } from "../api";
import { fmtTime, t } from "../i18n";
import { ErrorBox, Loading, Modal, failed, savedToast, useLoad } from "../ui";

interface VersionInfo {
  version: number;
  createdAt: string;
  actor: string | null;
  summary: string;
}

interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: unknown;
}

export interface DiffLine {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

/** Flatten JSON to path → JSON-encoded leaf. Arrays of objects with id/name are keyed by it. */
export function flatten(value: unknown, prefix = "", out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix || "$", "[]");
    value.forEach((v, i) => {
      const id =
        v && typeof v === "object" && !Array.isArray(v)
          ? ((v as Record<string, unknown>)["name"] ?? (v as Record<string, unknown>)["id"])
          : undefined;
      flatten(v, `${prefix}[${typeof id === "string" ? id : i}]`, out);
    });
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.set(prefix || "$", "{}");
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix || "$", JSON.stringify(value));
  }
  return out;
}

export function diffSnapshots(a: unknown, b: unknown): DiffLine[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const out: DiffLine[] = [];
  for (const [p, v] of fa) {
    if (!fb.has(p)) out.push({ path: p, kind: "removed", before: v });
    else if (fb.get(p) !== v) out.push({ path: p, kind: "changed", before: v, after: fb.get(p) ?? "" });
  }
  for (const [p, v] of fb) if (!fa.has(p)) out.push({ path: p, kind: "added", after: v });
  // Timestamps and revisions change on every write; they are noise in a diff.
  return out
    .filter((d) => !/(^|\.)(updated_at|updatedAt|created_at|createdAt|revision)$/.test(d.path))
    .sort((x, y) => x.path.localeCompare(y.path));
}

export function VersionsPage(props: PageProps) {
  const [limit, setLimit] = useState(30);
  const versions = useLoad(() => get<{ head: number; data: VersionInfo[] }>("/config/versions", { limit }), [limit]);
  const audit = useLoad(() => get<{ data: AuditEntry[] }>("/audit", { limit: 100 }));
  const [diff, setDiff] = useState<{ title: string; lines: DiffLine[] } | null>(null);

  const showDiff = async (from: number, to: number) => {
    try {
      const [a, b] = await Promise.all([
        get<{ snapshot: unknown }>(`/config/versions/${from}`),
        get<{ snapshot: unknown }>(`/config/versions/${to}`),
      ]);
      setDiff({ title: `#${from} → #${to}`, lines: diffSnapshots(a.snapshot, b.snapshot) });
    } catch (err) {
      failed(err);
    }
  };
  const head = versions.data?.head ?? 0;

  return (
    <div class="stack">
      <section class="card">
        <h2>{t("v.versions")}</h2>
        <ErrorBox error={versions.error} />
        {versions.loading && !versions.data ? (
          <Loading />
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("v.version")}</th>
                <th>{t("v.time")}</th>
                <th>{t("v.actor")}</th>
                <th>{t("v.summary")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(versions.data?.data ?? []).map((v) => (
                <tr key={v.version}>
                  <td>
                    #{v.version}
                    {v.version === head ? <span class="badge ok">HEAD</span> : null}
                  </td>
                  <td class="small nowrap">{fmtTime(v.createdAt)}</td>
                  <td class="small">{v.actor ?? "—"}</td>
                  <td class="small">{v.summary}</td>
                  <td class="nowrap">
                    {v.version > 1 ? (
                      <button type="button" onClick={() => void showDiff(v.version - 1, v.version)}>
                        {t("v.diffPrev")}
                      </button>
                    ) : null}{" "}
                    {v.version !== head ? (
                      <button type="button" onClick={() => void showDiff(v.version, head)}>
                        {t("v.diff")}
                      </button>
                    ) : null}{" "}
                    {props.canWrite && v.version !== head ? (
                      <button
                        type="button"
                        class="danger"
                        onClick={async () => {
                          if (!confirm(t("v.confirmRollback", { v: v.version }))) return;
                          try {
                            savedToast(
                              await api(`/config/versions/${v.version}/rollback`, { method: "POST", revision: head }),
                            );
                            versions.reload();
                            audit.reload();
                          } catch (err) {
                            failed(err);
                            versions.reload();
                          }
                        }}
                      >
                        {t("v.rollback")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(versions.data?.data.length ?? 0) >= limit ? (
          <button type="button" onClick={() => setLimit(limit + 30)}>
            {t("v.more")}
          </button>
        ) : null}
      </section>

      <section class="card">
        <h2>{t("v.audit")}</h2>
        <ErrorBox error={audit.error} />
        <table>
          <thead>
            <tr>
              <th>{t("v.time")}</th>
              <th>{t("v.actor")}</th>
              <th>{t("v.action")}</th>
              <th>{t("v.resource")}</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data?.data ?? []).map((a) => (
              <tr key={a.id}>
                <td class="small nowrap">{fmtTime(a.at)}</td>
                <td class="small">{a.actor}</td>
                <td>{a.action}</td>
                <td class="small">
                  {a.resourceType}
                  {a.resourceId ? ` ${a.resourceId}` : ""}
                </td>
                <td class="small mono">{a.detail ? JSON.stringify(a.detail) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {diff ? (
        <Modal title={diff.title} onClose={() => setDiff(null)}>
          {diff.lines.length === 0 ? (
            <p class="muted">{t("v.noDiff")}</p>
          ) : (
            <div class="diff mono">
              {diff.lines.map((d) => (
                <div key={`${d.kind}-${d.path}`} class={`diff-${d.kind}`}>
                  <span class="path">{d.path}</span>{" "}
                  {d.kind === "changed" ? (
                    <>
                      <del>{d.before}</del> → <ins>{d.after}</ins>
                    </>
                  ) : d.kind === "added" ? (
                    <ins>+ {d.after}</ins>
                  ) : (
                    <del>− {d.before}</del>
                  )}
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
