import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import manifest from "./.project-status/manifest.json" with { type: "json" };
import { createPublicProjection } from "./packages/core/index.mjs";

// Bundle only the allowlisted public projection so a local/static preview is
// truthful even when no status API is attached. Private evidence locators and
// internal identities never enter the client bundle.
const bundledStatus = createPublicProjection(manifest, { now: manifest.audit.evidenceAsOf });

export default defineConfig({
  define: {
    __PROJECT_STATUS_FALLBACK__: JSON.stringify(bundledStatus),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
