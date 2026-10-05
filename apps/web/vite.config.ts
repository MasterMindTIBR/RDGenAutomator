import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { devtools } from "@tanstack/devtools-vite";

export default defineConfig(({ command }) => ({
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"],
  },
  plugins: [
    command === "serve" && devtools(),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
    }),
    viteReact(),
    tailwindcss(),
    tsconfigPaths(),
    // nitro builds the deployable server bundle; the dev server runs on Vite directly.
    command === "build" && nitro({
      preset: "node-server",
      routeRules: {
        // HTML must always be revalidated so browsers never pin a stale hashed bundle; assets stay immutable by content hash.
        "/**": { headers: { "cache-control": "no-cache" } },
        "/assets/**": { headers: { "cache-control": "public, max-age=31536000, immutable" } },
      },
    }),
  ],
}));
