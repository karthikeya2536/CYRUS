// Centralized input validators for edge functions.

export const SUPPORTED_PROVIDERS = ["google", "slack", "notion"] as const;
export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

export function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

// Maximum accepted length for a free-text retrieval query.
export const MAX_QUERY_LENGTH = 2000;

export function isValidQuery(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_QUERY_LENGTH;
}

// Strict redirect_uri validation against a comma-separated allowlist.
// localhost / 127.0.0.1 (any port) are permitted for local development, matching
// existing behavior.
export function isAllowedRedirectUri(redirectUri: unknown, allowlistEnv: string | undefined): boolean {
  if (typeof redirectUri !== "string" || redirectUri.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  const isLocalhost =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");

  const allowedList = (allowlistEnv || "")
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri.length > 0);

  if (isLocalhost) {
    return (
      allowedList.length === 0 ||
      allowedList.some(
        (a) => a.startsWith("http://localhost") || a.startsWith("http://127.0.0.1"),
      ) ||
      allowedList.includes(redirectUri)
    );
  }

  if (allowedList.length === 0) return false;
  return allowedList.includes(redirectUri);
}
