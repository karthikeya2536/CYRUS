// Structured JSON logger for edge functions.
// Never pass secrets, tokens, embeddings, or authorization headers as fields.

type Level = "debug" | "info" | "warn" | "error";

export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface LogContext {
  fn: string;
  request_id: string;
}

function emit(level: Level, ctx: LogContext, msg: string, fields?: Record<string, unknown>) {
  const entry = {
    level,
    fn: ctx.fn,
    request_id: ctx.request_id,
    msg,
    ...(fields || {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(fn: string, requestId: string) {
  const ctx: LogContext = { fn, request_id: requestId };
  return {
    requestId,
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", ctx, msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", ctx, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", ctx, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", ctx, msg, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
