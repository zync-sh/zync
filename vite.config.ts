import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const normalizePath = (value: string) => value.replace(/\\/g, "/");
const hasNodeModulePackage = (id: string, pkg: string) => {
  const normalized = normalizePath(id);
  return normalized.includes(`/node_modules/${pkg}/`) || normalized.endsWith(`/node_modules/${pkg}`);
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Monaco Editor: Exclude monaco worker scripts from Vite's module resolution.
  // Context Engine: Prevent Vite from pre-bundling 2,444 JSON files on startup.
  optimizeDeps: {
    exclude: ["@enjoys/context-engine"],
    include: ["@monaco-editor/react"],
  },

  build: {
    rollupOptions: {
      output: {
        // Keep large editor/runtime dependencies in dedicated chunks.
        // This reduces hot chunk warnings and improves incremental cache reuse.
        manualChunks(id) {
          if (!normalizePath(id).includes("/node_modules/")) return;

          if (hasNodeModulePackage(id, "monaco-editor") || hasNodeModulePackage(id, "@monaco-editor/react")) {
            return "monaco";
          }
          if (
            hasNodeModulePackage(id, "@codemirror")
            || hasNodeModulePackage(id, "@lezer")
            || hasNodeModulePackage(id, "codemirror")
          ) {
            return "codemirror";
          }
          if (hasNodeModulePackage(id, "@xterm") || hasNodeModulePackage(id, "xterm")) {
            return "xterm";
          }
          if (
            hasNodeModulePackage(id, "react")
            || hasNodeModulePackage(id, "react-dom")
            || hasNodeModulePackage(id, "react-is")
            || hasNodeModulePackage(id, "scheduler")
          ) {
            return "react-vendor";
          }
          return "vendor";
        },
      },
    },
  },

  worker: {
    format: "es",
  },
});
