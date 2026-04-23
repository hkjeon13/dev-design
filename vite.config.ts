import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    "process.env.BABEL_TYPES_8_BREAKING": "false",
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  server: {
    host: host || "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
