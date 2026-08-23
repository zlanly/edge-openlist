import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "/",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/dav": "http://127.0.0.1:8787",
      "/s": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
