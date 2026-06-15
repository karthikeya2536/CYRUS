// Shared CORS helper.
// ALLOWED_ORIGIN is a comma-separated allowlist. The request Origin is echoed
// back ONLY when it is present in the allowlist. When the origin is not allowed
// (or no origin header is sent) NO Access-Control-Allow-Origin header is emitted.
// There is intentionally no "*" default.

function parseAllowlist(): string[] {
  return (Deno.env.get("ALLOWED_ORIGIN") || "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function buildCorsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };

  const origin = req.headers.get("Origin");
  if (origin && parseAllowlist().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}
