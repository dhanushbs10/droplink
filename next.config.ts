import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Build the connect-src allowlist from the origins this app actually talks to.
 * A blanket `https:` scheme-source lets a successful injection exfiltrate room
 * codes, share tokens and session data to any host on the internet.
 */
function connectSources(): string {
  const origins = new Set<string>(["'self'", "blob:"]);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) origins.add(supabaseUrl);
  const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL;
  if (signalingUrl) {
    // Socket.IO may be reached over http(s) or ws(s).
    origins.add(signalingUrl);
    origins.add(signalingUrl.replace(/^http/, "ws"));
  }
  if (!isProduction) {
    origins.add("http:");
    origins.add("ws:");
  } else {
    origins.add("wss:");
  }
  return `connect-src ${Array.from(origins).join(" ")}`;
}

const scriptSources = isProduction
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      scriptSources,
      connectSources(),
      "worker-src 'self' blob:",
    ].join("; "),
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "Upgrade-Insecure-Requests", value: "1" },
      ]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
