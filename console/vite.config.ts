import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Built into console/dist, then embedded into the server by scripts/embed-console.ts.
export default defineConfig({
  root: import.meta.dirname,
  base: "/admin/dashboard/",
  plugins: [preact({ devtoolsInProd: false, prefreshEnabled: false })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No data: URIs and no inline script, so the strict CSP holds.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    // `bun run console:dev`: the gateway on :3000 answers /admin/* API calls.
    proxy: { "^/admin/(?!dashboard)": "http://127.0.0.1:3000" },
  },
});
