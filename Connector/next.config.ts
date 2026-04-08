import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import path from "path";

// Load shared workspace env from repo root so Connector and Agentic Layer use one file.
loadEnvConfig(path.resolve(__dirname, ".."));

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
    ],
  },
  turbopack: {
    // Explicitly set the workspace root to this directory so Turbopack does not
    // walk up to the DeplAI/ parent (which contains .venv, Agentic Layer, etc.)
    // and watch thousands of unrelated files, causing system resource exhaustion.
    root: path.resolve(__dirname),
    // Alias tailwindcss to the local node_modules so the PostCSS pipeline
    // resolves it from here rather than the parent DeplAI/ directory (which
    // has a stale package-lock.json but no node_modules).
    resolveAlias: {
      tailwindcss: path.resolve(__dirname, "node_modules/tailwindcss"),
    },
  },
};

export default nextConfig;
