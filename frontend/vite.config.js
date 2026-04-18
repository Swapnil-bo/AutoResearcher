import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// AutoResearcher frontend — Vite config.
// Dev server proxies /api → FastAPI on :8000, with SSE left unbuffered so
// report_token events arrive live instead of in one flushed blob.
export default defineConfig(({ mode }) => {
  const isProd = mode === "production";

  return {
    plugins: [react()],

    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@components": fileURLToPath(new URL("./src/components", import.meta.url)),
        "@hooks": fileURLToPath(new URL("./src/hooks", import.meta.url)),
      },
    },

    server: {
      port: 5173,
      strictPort: true,
      host: "localhost",
      open: false,
      cors: true,
      proxy: {
        "/api": {
          target: "http://localhost:8000",
          changeOrigin: true,
          ws: false,
          // SSE: keep the socket open indefinitely and never buffer the body.
          // The backend streams report_token events during synthesis; any
          // buffering here kills the progressive-reveal UX.
          proxyTimeout: 0,
          timeout: 0,
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes, req) => {
              const accept = req.headers["accept"] || "";
              if (accept.includes("text/event-stream")) {
                // Disable any intermediary compression/buffering on SSE.
                proxyRes.headers["cache-control"] = "no-cache, no-transform";
                proxyRes.headers["x-accel-buffering"] = "no";
                delete proxyRes.headers["content-length"];
              }
            });
            proxy.on("error", (err, _req, res) => {
              // Don't let a transient backend hiccup crash the dev server.
              if (res && !res.headersSent && typeof res.writeHead === "function") {
                res.writeHead(502, { "content-type": "application/json" });
              }
              if (res && typeof res.end === "function") {
                res.end(
                  JSON.stringify({
                    error: "backend_unreachable",
                    detail: err.message,
                  })
                );
              }
            });
          },
        },
      },
    },

    preview: {
      port: 4173,
      strictPort: true,
      host: "localhost",
    },

    build: {
      target: "es2020",
      outDir: "dist",
      assetsDir: "assets",
      sourcemap: !isProd,
      cssCodeSplit: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // Split heavy deps into their own chunks so the shell loads fast
          // and the report viewer's markdown stack only pays its weight
          // once the user actually asks for a report.
          manualChunks: {
            react: ["react", "react-dom"],
            motion: ["framer-motion"],
            markdown: ["react-markdown"],
          },
        },
      },
    },

    esbuild: {
      // Strip dev-only noise from production bundles.
      drop: isProd ? ["console", "debugger"] : [],
      legalComments: "none",
    },

    css: {
      devSourcemap: true,
    },

    optimizeDeps: {
      include: ["react", "react-dom", "framer-motion", "react-markdown"],
    },

    clearScreen: false,
  };
});
