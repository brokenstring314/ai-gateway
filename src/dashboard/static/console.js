// AI Gateway admin console. Vanilla JS, no build step, no external assets.
// Every value from the API is written as a text node or attribute, never parsed as HTML.
"use strict";

(() => {
  const KEY = "aigw.adminKey";
  const LOGIN = "/admin/dashboard/login";
  const page = document.body.dataset.page || "";
  const getKey = () => sessionStorage.getItem(KEY) || "";
  const $ = (id) => document.getElementById(id);

  /** Create an element; children may be strings (text nodes) or nodes. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function setStatus(msg, isError) {
    const s = $("status");
    if (!s) return;
    s.textContent = msg || "";
    s.className = isError ? "status error" : "status";
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, opts) {
    const o = opts || {};
    const headers = { Authorization: `Bearer ${o.key || getKey()}` };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method: o.method || "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      credentials: "omit",
      cache: "no-store",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
      if (res.status === 401 && !o.key) {
        sessionStorage.removeItem(KEY);
        location.assign(LOGIN);
      }
      throw new ApiError(res.status, String(msg));
    }
    return data;
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
  const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString() : "—");
  const fmtPct = (r) => (typeof r === "number" ? `${(r * 100).toFixed(1)}%` : "—");
  const fmtMs = (n) => (typeof n === "number" ? `${n} ms` : "—");

  function table(headers, rows, empty) {
    if (rows.length === 0) return el("p", { class: "muted" }, empty || "Nothing to show.");
    return el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
        el(
          "tbody",
          {},
          rows.map((r) => el("tr", {}, r.map((cell) => el("td", {}, cell)))),
        ),
      ),
    );
  }

  const badge = (text, tone) => el("span", { class: `badge ${tone || ""}` }, text);
  const stateTone = (s) => {
    const v = String(s).toLowerCase();
    if (v === "ok" || v === "closed" || v === "ready" || v === "true" || v === "active") return "good";
    if (v === "half_open" || v === "draining" || v === "pending" || v === "connecting") return "warn";
    return "bad";
  };
  const card = (label, value, sub) =>
    el("div", { class: "card" }, el("span", { class: "label" }, label), el("strong", {}, value), sub ? el("small", {}, sub) : null);

  let me = { scopes: [] };
  const isAdmin = () => me.scopes.includes("admin");

  // ── Overview ────────────────────────────────────────────────────────────
  async function overview(app) {
    const [readyRes, status, stats] = await Promise.all([
      fetch("/readyz", { cache: "no-store", credentials: "omit" })
        .then((r) => r.json())
        .catch(() => null),
      api("/admin/status"),
      api("/admin/logs/stats"),
    ]);
    const req = status.requests || {};
    const lat = req.latencyMs || {};
    const logErrRate = stats.totalEntries > 0 ? stats.errorEntries / stats.totalEntries : 0;
    const breakers = Object.entries(status.circuitBreakers || {});
    const mcp = Object.entries(status.mcpServers || {});
    app.replaceChildren(
      el(
        "section",
        { class: "cards" },
        card(
          "Readiness (/readyz)",
          readyRes ? badge(String(readyRes.status), stateTone(readyRes.status)) : badge("unreachable", "bad"),
          readyRes ? `stores ${readyRes.stores ? "ok" : "failing"} · providers ${readyRes.providers ? "ok" : "none"}` : "",
        ),
        card(
          "Upstream available",
          badge(status.upstreamAvailable ? "yes" : "no", status.upstreamAvailable ? "good" : "bad"),
          `${fmtNum(status.providers)} provider(s) registered`,
        ),
        card("Logged requests", fmtNum(stats.totalEntries), `${fmtNum(stats.errorEntries)} errors · ${fmtPct(logErrRate)}`),
        card("Tokens (logged)", fmtNum(stats.totalTokens), ""),
        card(
          "Upstream-served (this process)",
          fmtNum(req.total),
          `5xx ${fmtNum(req.serverErrors)} · 4xx ${fmtNum(req.clientErrors)} · error rate ${fmtPct(req.errorRate)}`,
        ),
        card("Latency (this process)", fmtMs(lat.p50), `p95 ${fmtMs(lat.p95)} · mean ${fmtMs(lat.mean)}`),
      ),
      el("h2", {}, "Circuit breakers"),
      table(
        ["Target", "State"],
        breakers.map(([name, state]) => [name, badge(String(state), stateTone(state))]),
        "No circuit breakers configured.",
      ),
      el("h2", {}, "MCP servers"),
      table(
        ["Server", "State"],
        mcp.map(([name, state]) => [name, badge(String(state), stateTone(state))]),
        "No MCP servers configured.",
      ),
      el("h2", {}, "Requests by surface / target / model (logged)"),
      el(
        "div",
        { class: "cols" },
        table(["Surface", "Count"], Object.entries(stats.byStage || {}).map(([k, v]) => [k, fmtNum(v)]), "No requests yet."),
        table(["Target", "Count"], Object.entries(stats.byProvider || {}).map(([k, v]) => [k, fmtNum(v)]), "—"),
        table(["Model", "Count"], Object.entries(stats.byModel || {}).map(([k, v]) => [k, fmtNum(v)]), "—"),
      ),
      el(
        "p",
        { class: "muted" },
        `Gateway ${status.version || ""} · updated ${new Date().toLocaleTimeString()} · refreshes every 15 s. ` +
          "Latency percentiles are histogram-bucket bounds.",
      ),
    );
  }

  // ── API keys ────────────────────────────────────────────────────────────
  const SCOPES = ["inference", "read_only", "admin"];

  function secretBox(title, key) {
    const input = el("input", { type: "text", readonly: true, value: key, class: "secret", "aria-label": "New key" });
    const copy = el(
      "button",
      {
        type: "button",
        on: {
          click: () => {
            input.select();
            if (navigator.clipboard) navigator.clipboard.writeText(key).catch(() => {});
            copy.textContent = "Copied";
          },
        },
      },
      "Copy",
    );
    return el(
      "div",
      { class: "notice", role: "alert" },
      el("strong", {}, title),
      el("p", {}, "Shown once. Store it now; it cannot be retrieved again."),
      el("div", { class: "row" }, input, copy),
    );
  }

  async function keys(app) {
    const data = await api("/admin/keys");
    const list = data.keys || [];
    const reveal = el("div", {});
    const admin = isAdmin();

    async function act(kind, k) {
      const verb = kind === "revoke" ? "Revoke" : "Rotate";
      if (!confirm(`${verb} key "${k.name}" (${k.keyDisplay})?`)) return;
      try {
        const r = await api(`/admin/keys/${encodeURIComponent(k.id)}/${kind}`, { method: "POST" });
        await keys(app);
        if (kind === "rotate" && r && r.key) $("key-reveal").replaceChildren(secretBox(`Rotated key for "${k.name}"`, r.key));
        setStatus(`${verb}d "${k.name}".`);
      } catch (e) {
        setStatus(`${verb} failed: ${e.message}`, true);
      }
    }

    const rows = list.map((k) => {
      const expired = k.expiresAt && new Date(k.expiresAt) < new Date();
      const state = k.revokedAt ? "revoked" : expired ? "expired" : k.active ? "active" : "inactive";
      const cells = [
        el("span", {}, k.name, el("br"), el("code", {}, k.keyDisplay)),
        (k.scopes || []).join(", "),
        badge(state, stateTone(state)),
        fmtTime(k.createdAt),
        fmtTime(k.expiresAt),
        `${fmtNum(k.usageCount)} · ${fmtTime(k.lastUsedAt)}`,
      ];
      if (admin) {
        const live = !k.revokedAt;
        cells.push(
          el(
            "span",
            { class: "actions" },
            live ? el("button", { type: "button", on: { click: () => act("rotate", k) } }, "Rotate") : null,
            live ? el("button", { type: "button", class: "danger", on: { click: () => act("revoke", k) } }, "Revoke") : null,
          ),
        );
      }
      return cells;
    });

    const headers = ["Name / key", "Scopes", "Status", "Created", "Expires", "Uses · last used"];
    if (admin) headers.push("");

    const parts = [];
    if (admin) {
      const name = el("input", { id: "key-name", name: "name", required: true, maxlength: "200" });
      const boxes = SCOPES.map((s) =>
        el("label", { class: "check" }, el("input", { type: "checkbox", name: "scope", value: s, checked: s === "inference" }), s),
      );
      const expires = el("input", { id: "key-expires", name: "expires", type: "date" });
      const form = el(
        "form",
        {
          class: "inline-form",
          on: {
            submit: async (ev) => {
              ev.preventDefault();
              const scopes = [...form.querySelectorAll("input[name=scope]:checked")].map((i) => i.value);
              const body = { name: name.value.trim(), scopes };
              if (expires.value) body.expiresAt = new Date(`${expires.value}T23:59:59`).toISOString();
              try {
                const created = await api("/admin/keys", { method: "POST", body });
                form.reset();
                await keys(app);
                $("key-reveal").replaceChildren(secretBox(`New key "${created.name}"`, created.key));
                setStatus(`Created "${created.name}".`);
              } catch (e) {
                setStatus(`Create failed: ${e.message}`, true);
              }
            },
          },
        },
        el("label", { for: "key-name" }, "Name"),
        name,
        el("fieldset", {}, el("legend", {}, "Scopes"), boxes),
        el("label", { for: "key-expires" }, "Expires (optional)"),
        expires,
        el("button", { type: "submit" }, "Create key"),
      );
      parts.push(el("h2", {}, "Create a key"), form);
    } else {
      parts.push(el("p", { class: "muted" }, "Read-only access: keys are listed, not changed."));
    }
    reveal.id = "key-reveal";
    const prior = $("key-reveal");
    if (prior) reveal.replaceChildren(...prior.childNodes);
    app.replaceChildren(reveal, ...parts, el("h2", {}, `Keys (${fmtNum(data.total)})`), table(headers, rows, "No keys."));
  }

  // ── Request logs ────────────────────────────────────────────────────────
  const PAGE_SIZE = 50;
  const logState = { offset: 0, filters: {} };

  async function logs(app) {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(logState.offset) });
    for (const [k, v] of Object.entries(logState.filters)) if (v && k !== "sinceLocal") q.set(k, v);
    const [data, stats] = await Promise.all([api(`/admin/logs?${q}`), api("/admin/logs/stats")]);
    const f = logState.filters;
    const options = (obj, current) => [
      el("option", { value: "" }, "any"),
      ...Object.keys(obj || {}).map((k) => el("option", { value: k, selected: k === current }, k)),
    ];
    const surface = el("select", { name: "stage", id: "f-stage" }, options(stats.byStage, f.stage));
    const target = el("select", { name: "provider", id: "f-provider" }, options(stats.byProvider, f.provider));
    const model = el("select", { name: "model", id: "f-model" }, options(stats.byModel, f.model));
    const status = el(
      "select",
      { name: "status", id: "f-status" },
      ["", "ok", "error"].map((v) => el("option", { value: v, selected: v === (f.status || "") }, v || "any")),
    );
    const since = el("input", { type: "datetime-local", id: "f-since", value: f.sinceLocal || "" });
    const form = el(
      "form",
      {
        class: "filters",
        on: {
          submit: (ev) => {
            ev.preventDefault();
            logState.offset = 0;
            logState.filters = {
              stage: surface.value,
              provider: target.value,
              model: model.value,
              status: status.value,
              since: since.value ? new Date(since.value).toISOString() : "",
              sinceLocal: since.value,
            };
            run();
          },
        },
      },
      el("label", { for: "f-stage" }, "Surface"),
      surface,
      el("label", { for: "f-provider" }, "Target"),
      target,
      el("label", { for: "f-model" }, "Model"),
      model,
      el("label", { for: "f-status" }, "Status"),
      status,
      el("label", { for: "f-since" }, "Since"),
      since,
      el("button", { type: "submit" }, "Apply"),
    );
    const entries = data.entries || [];
    const total = data.total || 0;
    const rows = entries.map((e) => [
      fmtTime(e.createdAt),
      el("code", {}, e.traceId || ""),
      e.stage,
      e.provider,
      e.model,
      fmtNum(e.totalTokens),
      e.errorMessage ? el("span", { class: "error" }, e.errorMessage) : badge("ok", "good"),
    ]);
    const from = total === 0 ? 0 : logState.offset + 1;
    const to = logState.offset + entries.length;
    const prev = el(
      "button",
      {
        type: "button",
        disabled: logState.offset === 0,
        on: {
          click: () => {
            logState.offset = Math.max(0, logState.offset - PAGE_SIZE);
            run();
          },
        },
      },
      "← Newer",
    );
    const next = el(
      "button",
      {
        type: "button",
        disabled: to >= total,
        on: {
          click: () => {
            logState.offset += PAGE_SIZE;
            run();
          },
        },
      },
      "Older →",
    );
    app.replaceChildren(
      form,
      table(["Time", "Trace", "Surface", "Target", "Model", "Tokens", "Result"], rows, "No matching requests."),
      el("div", { class: "pager" }, prev, el("span", {}, `${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(total)}`), next),
    );
  }

  // ── Config ──────────────────────────────────────────────────────────────
  async function config(app) {
    const data = await api("/admin/config");
    app.replaceChildren(
      el("p", { class: "muted" }, "Read-only, secrets scrubbed. Edit the config file and restart to change it."),
      el("pre", { class: "config" }, JSON.stringify(data.config, null, 2)),
    );
  }

  // ── Login ───────────────────────────────────────────────────────────────
  function login() {
    const form = $("login-form");
    const err = $("login-error");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const key = $("admin-key").value.trim();
      err.hidden = true;
      try {
        await api("/admin/status", { key });
        sessionStorage.setItem(KEY, key);
        location.assign("/admin/dashboard");
      } catch (e) {
        err.textContent =
          e.status === 403
            ? "This key has no admin or read_only scope."
            : e.status === 401
              ? "Invalid key."
              : `Sign-in failed: ${e.message}`;
        err.hidden = false;
      }
    });
  }

  const PAGES = { overview, keys, logs, config };
  let timer = null;

  async function run() {
    const app = $("app");
    const fn = PAGES[page];
    if (!app || !fn) return;
    try {
      await fn(app);
      if (page !== "keys") setStatus("");
    } catch (e) {
      setStatus(e.status === 403 ? "Your key cannot read this page." : `Failed to load: ${e.message}`, true);
    }
  }

  async function start() {
    if (page === "login") return login();
    if (!getKey()) return location.assign(LOGIN);
    $("logout").addEventListener("click", () => {
      sessionStorage.removeItem(KEY);
      location.assign(LOGIN);
    });
    try {
      me = await api("/admin/status");
    } catch (e) {
      setStatus(`Failed to load: ${e.message}`, true);
      return;
    }
    $("whoami").textContent = (me.scopes || []).join(", ");
    await run();
    if (page === "overview") timer = setInterval(run, 15000);
  }

  window.addEventListener("pagehide", () => timer && clearInterval(timer));
  document.addEventListener("DOMContentLoaded", start);
})();
