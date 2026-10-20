import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    // Rust generates HTML assets under target/; they must not reload live terminals.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  optimizeDeps: {
    include: ["react-markdown", "@shadcn/react/message-scroller"],
  },
  clearScreen: false,
});
