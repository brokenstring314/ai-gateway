/** Console shell: session check, sign-in, navigation, language switch. */
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, type SessionInfo, setCsrfToken, setUnauthorizedHandler } from "./api";
import { type Lang, type MsgKey, setLang, t, useLang } from "./i18n";
import { ChannelsPage } from "./pages/channels";
import { KeysPage } from "./pages/keys";
import { LogsPage } from "./pages/logs";
import { ModelsPage } from "./pages/models";
import { OverviewPage } from "./pages/overview";
import { PlaygroundPage } from "./pages/playground";
import { SettingsPage } from "./pages/settings";
import { UsagePage } from "./pages/usage";
import { VersionsPage } from "./pages/versions";
import { Field, Toasts, notify } from "./ui";

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
    api<SessionInfo>("/session").then(
      (r) => {
        if (r.data.csrfToken) setCsrfToken(r.data.csrfToken);
        setSession(r.data);
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
        <span class="who" title={session.actor}>
          {session.actor}
          {canWrite ? "" : ` · ${t("readOnly")}`}
        </span>
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
            if (err instanceof ApiError && err.status === 429) {
              setError(t("login.locked", { s: err.retryAfter ?? 60 }));
            } else if (err instanceof ApiError && err.status === 403) {
              setError(t("login.scope"));
            } else if (err instanceof ApiError && err.status === 401) {
              setError(t("login.invalid"));
            } else {
              setError(err instanceof Error ? err.message : String(err));
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
