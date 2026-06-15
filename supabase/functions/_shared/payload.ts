// Reject oversized request bodies before reading them.
// Returns true when the declared Content-Length exceeds the cap.
export const MAX_BODY_BYTES = 1_048_576; // 1MB

export function isPayloadTooLarge(req: Request, maxBytes = MAX_BODY_BYTES): boolean {
  const len = req.headers.get("content-length");
  if (!len) return false;
  const parsed = Number(len);
  if (!Number.isFinite(parsed)) return false;
  return parsed > maxBytes;
}
