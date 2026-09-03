import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import path from "path";
import { fileURLToPath } from "url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

// Load shared workspace env from repo root so Connector and Agentic Layer use one file.
loadEnvConfig(path.resolve(configDir, ".."));
loadEnvConfig(configDir);

const agenticLayerUrl = (process.env.AGENTIC_LAYER_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: ['razorpay', 'pdfkit'],
  async redirects() {
    return [
      {
        source: '/dashboard/profile',
        destination: '/profile',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    // Browser traffic may only reach Agentic WebSockets. HTTP APIs stay
    // server-side via AGENTIC_LAYER_URL + X-API-Key.
    return [
      {
        source: '/agentic/ws/:path*',
        destination: `${agenticLayerUrl}/ws/:path*`,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "github.com",
      },
    ],
  },
  turbopack: {
    // Explicitly set the workspace root to this directory so Turbopack does not
    // walk up to the DeplAI/ parent (which contains .venv, Agentic Layer, etc.)
    // and watch thousands of unrelated files, causing system resource exhaustion.
    root: configDir,
    // Alias tailwindcss to the local node_modules so the PostCSS pipeline
    // resolves it from here rather than the parent DeplAI/ directory (which
    // has a stale package-lock.json but no node_modules).
    resolveAlias: {
      tailwindcss: path.resolve(configDir, "node_modules/tailwindcss"),
    },
  },
};

export default nextConfig;
