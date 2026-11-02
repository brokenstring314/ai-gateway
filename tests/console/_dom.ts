/**
 * Minimal DOM for console component tests (happy-dom, dev dependency only).
 * Installed per test file and removed afterwards, so other tests see no DOM.
 */
import { Window } from "happy-dom";

const KEYS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PopStateEvent",
  "SVGElement",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
] as const;

export interface Dom {
  window: Window;
  restore(): void;
  /** Requests the page made: method + path + parsed body + headers. */
  calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>;
  /** Route table for the stubbed fetch: "METHOD /admin/path" → response factory. */
  routes: Map<string, (body: unknown) => Response>;
}

export function installDom(url = "http://gw.test/admin/dashboard"): Dom {
  const window = new Window({ url });
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const k of KEYS) {
    saved.set(k, g[k]);
    const v = (window as unknown as Record<string, unknown>)[k];
    g[k] = typeof v === "function" && /^[a-z]/.test(k) ? (v as (...a: unknown[]) => unknown).bind(window) : v;
  }
  const originalFetch = globalThis.fetch;
  const dom: Dom = {
    window,
    calls: [],
    routes: new Map(),
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
      globalThis.fetch = originalFetch;
      void window.happyDOM.close();
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input), url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    dom.calls.push({
      method,
      path: u.pathname + u.search,
      body,
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    const route = dom.routes.get(`${method} ${u.pathname}`);
    if (!route) return Response.json({ error: { message: "not found", code: "not_found" } }, { status: 404 });
    return route(body);
  }) as typeof fetch;
  return dom;
}

export async function settle(ms = 20): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms / 5));
}

export function byText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.includes(text));
}

export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
}
