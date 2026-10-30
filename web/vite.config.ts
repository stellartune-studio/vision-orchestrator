import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VO_WEB_PORT ?? 5173),
    proxy: {
      // VO_API_ORIGIN lets a second Vite instance front a scratch
      // server (verification on throwaway data). Defaults unchanged.
      "/api": process.env.VO_API_ORIGIN ?? "http://localhost:8787",
    },
  },
});
