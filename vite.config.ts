import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
        // Split Monaco into its own chunk to avoid bloating the main bundle
        manualChunks: {
          monaco: ["@monaco-editor/react", "monaco-editor"],
        },
      },
    },
  },

  worker: {
    format: "es",
  },
});
