/** Console shell: session check, sign-in, navigation, language switch. */
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, get, probeSession, type SessionInfo, setCsrfToken, setUnauthorizedHandler } from "./api";
import { fmtDuration, type Lang, type MsgKey, setLang, t, useLang } from "./i18n";
import { ChannelsPage } from "./pages/channels";
import { KeysPage } from "./pages/keys";
import { LogsPage } from "./pages/logs";
import { ModelsPage } from "./pages/models";
import { OverviewPage } from "./pages/overview";
import { PlaygroundPage } from "./pages/playground";
import { SettingsPage } from "./pages/settings";
import { UsagePage } from "./pages/usage";
import { VersionsPage } from "./pages/versions";
import { Field, Toasts, errText, notify } from "./ui";

export const BASE = "/admin/dashboard";

export interface PageProps {
  session: SessionInfo;
  canWrite: boolean;
}

export const PAGES: ReadonlyArray<{ id: string; label: MsgKey; component: ComponentType<PageProps> }> = [
  { id: "", label: "nav.overview", component: OverviewPage },
  { id: "channels", label: "nav.channels", component: ChannelsPage },
  { id: "models", label: "nav.models", component: ModelsPage },
  { id: "keys", label: "nav.keys", component: KeysPage },
  { id: "usage", label: "nav.usage", component: UsagePage },
  { id: "logs", label: "nav.logs", component: LogsPage },
  { id: "playground", label: "nav.playground", component: PlaygroundPage },
  { id: "settings", label: "nav.settings", component: SettingsPage },
  { id: "versions", label: "nav.versions", component: VersionsPage },
];

function currentPage(): string {
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "";
  return p.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
}

export function navigate(page: string): void {
  history.pushState(null, "", page ? `${BASE}/${page}` : BASE);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  useLang();
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [page, setPage] = useState(currentPage());

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession((s) => {
        if (s) notify(t("session.expired"), "error");
        return null;
      });
    });
    probeSession().then(
      (s) => {
        if (s?.csrfToken) setCsrfToken(s.csrfToken);
        setSession(s);
      },
      () => setSession(null),
    );
    const onPop = () => setPage(currentPage());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  if (session === undefined) return <p class="boot muted">{t("loading")}</p>;
  if (session === null) return <Login onDone={setSession} />;

  const canWrite = session.scopes.includes("admin");
  const entry = PAGES.find((p) => p.id === page) ?? PAGES[0]!;
  const Page = entry.component;
  return (
    <div class="shell">
      <header class="top">
        <strong class="brand">{t("appName")}</strong>
        <nav>
          {PAGES.map((p) => (
            <a
              key={p.id}
              href={p.id ? `${BASE}/${p.id}` : BASE}
              class={p.id === entry.id ? "active" : ""}
              aria-current={p.id === entry.id ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(p.id);
              }}
            >
              {t(p.label)}
            </a>
          ))}
        </nav>
        <Who actor={session.actor} keyName={session.keyName} canWrite={canWrite} />
        <LangSwitch />
        <button
          type="button"
          class="ghost"
          onClick={async () => {
            try {
              await api("/session/logout", { method: "POST" });
            } catch {
              // signed out anyway
            }
            setCsrfToken("");
            setSession(null);
          }}
        >
          {t("logout")}
        </button>
      </header>
      <main>
        <h1>{t(entry.label)}</h1>
        <Page key={entry.id} session={session} canWrite={canWrite} />
      </main>
      <Toasts />
    </div>
  );
}

/** Signed-in actor; a store key shows its name instead of "key:<uuid>" (U8). */
function Who(props: { actor: string; keyName?: string | undefined; canWrite: boolean }) {
  const [keyName, setKeyName] = useState(props.keyName ?? "");
  useEffect(() => {
    const id = props.actor.startsWith("key:") ? props.actor.slice(4) : "";
    if (!id || props.keyName) return;
    get<{ keys?: Array<{ id: string; name: string }>; data?: Array<{ id: string; name: string }> }>("/keys").then(
      (r) => {
        const hit = (r.keys ?? r.data ?? []).find((k) => k.id === id);
        if (hit) setKeyName(hit.name);
      },
      () => {},
    );
  }, [props.actor, props.keyName]);
  return (
    <span class="who" title={props.actor}>
      {keyName ? `${t("who.key")}: ${keyName}` : props.actor}
      {props.canWrite ? "" : ` · ${t("readOnly")}`}
    </span>
  );
}

export function LangSwitch() {
  const l = useLang();
  return (
    <select
      class="lang"
      aria-label="Language / 语言"
      value={l}
      onChange={(e) => setLang((e.currentTarget as HTMLSelectElement).value as Lang)}
    >
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  );
}

export function Login(props: { onDone: (s: SessionInfo) => void }) {
  useLang();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main class="login">
      <div class="login-top">
        <h1>{t("appName")}</h1>
        <LangSwitch />
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await api<SessionInfo>("/session/login", { method: "POST", body: { key } });
            setKey("");
            if (r.data.csrfToken) setCsrfToken(r.data.csrfToken);
            props.onDone({ ...r.data, via: "session" });
          } catch (err) {
            if (err instanceof ApiError && err.status === 429 && err.code !== "login_rate_limited") {
              setError(t("login.locked", { s: fmtDuration(err.retryAfter ?? 60) }));
            } else if (err instanceof ApiError && err.status === 403) {
              setError(t("login.scope"));
            } else if (err instanceof ApiError && err.status === 401) {
              setError(t("login.invalid"));
            } else {
              setError(errText(err));
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{t("login.title")}</h2>
        <Field label={t("login.key")} error={error || undefined}>
          <input
            name="key"
            type="password"
            autocomplete="off"
            spellcheck={false}
            required
            value={key}
            onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <button type="submit" class="primary" disabled={busy || key === ""}>
          {t("login.submit")}
        </button>
        <p class="hint">{t("login.hint")}</p>
      </form>
      <Toasts />
    </main>
  );
}
