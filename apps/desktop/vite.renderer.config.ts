import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: { "window-runtime": path.join(packageRoot, "renderer-src/window-runtime.tsx"), companion: path.join(packageRoot, "renderer-src/apps/companion.tsx") },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: path.join(packageRoot, "renderer/generated"),
    minify: "esbuild",
    sourcemap: true,
  },
});
