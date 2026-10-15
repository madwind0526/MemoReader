import { defineConfig } from "vite";

// Builds the service worker as one self-contained classic script at dist/sw.js. It runs after the
// main build (see the "build" script), so it must not clear dist or copy public/ again.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: "src/sw.ts",
      formats: ["iife"],
      name: "MemoReaderServiceWorker",
      fileName: () => "sw.js",
    },
    minify: true,
  },
});
