// Fixed-window rate limiter backed by the rate_limits Postgres table.
// Identity (user_id) MUST be derived from the validated JWT by the caller,
// never from the client body. Uses the service-role client so it can write to
// the rate_limits table (RLS enabled, no user policies).
//
// Window is fixed: floor(now / windowMs). The (user_id, fn, window_start) row
// is incremented atomically via INSERT ... ON CONFLICT. Over-limit is reported
// when the post-increment count exceeds `limit`. Fails open on DB error so a
// transient failure never blocks legitimate traffic.

// Structural type satisfied by a Supabase service-role client. The supabase-js
// rpc() builder is a PromiseLike resolving to { data, error }.
type AdminClient = {
  // deno-lint-ignore no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
};

export interface RateLimitResult {
  limited: boolean;
  count: number;
}

export async function checkRateLimit(
  admin: AdminClient,
  userId: string,
  fn: string,
  limit: number,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

  const { data, error } = await admin.rpc("increment_rate_limit", {
    p_user_id: userId,
    p_fn: fn,
    p_window_start: windowStart,
  });

  if (error) {
    // Fail open: do not block on infrastructure errors.
    return { limited: false, count: 0 };
  }

  const count = typeof data === "number" ? data : Number(data) || 0;
  return { limited: count > limit, count };
}
