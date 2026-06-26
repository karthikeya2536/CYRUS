import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  service: string;
  operation: string;
  span_kind: string;
  started_at: string;
  duration_ms?: number;
  status: string;
  status_message?: string;
  attributes: Record<string, any>;
  user_id?: string;
  job_id?: string;
  
  setAttribute(key: string, value: any): void;
  setStatus(status: 'ok' | 'error' | 'unset', message?: string): void;
  end(): void;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

// In-memory buffer for spans during a request
let spanBuffer: any[] = [];
// Global or injected client for background flushing
let defaultSupabaseClient: any = null;

export function setDefaultSupabaseClient(client: any) {
  defaultSupabaseClient = client;
}

export function flushTraceSpans(): any[] {
  const spans = [...spanBuffer];
  spanBuffer = [];
  return spans;
}

export function getCurrentTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function withTraceContext<T>(ctx: TraceContext, fn: () => Promise<T> | T): Promise<T> | T {
  return traceStorage.run(ctx, fn);
}

export function startSpan(
  service: string, 
  operation: string, 
  opts: { 
    span_kind?: string; 
    parent_span_id?: string; 
    user_id?: string; 
    job_id?: string; 
    trace_id?: string;
  } = {}
): Span {
  const currentCtx = getCurrentTrace();
  
  const span_id = crypto.randomUUID();
  const trace_id = opts.trace_id || currentCtx?.trace_id || crypto.randomUUID();
  const parent_span_id = opts.parent_span_id || currentCtx?.span_id;
  
  const spanData = {
    span_id,
    trace_id,
    parent_span_id,
    service,
    operation,
    span_kind: opts.span_kind || 'internal',
    started_at: new Date().toISOString(),
    status: 'unset',
    attributes: {} as Record<string, any>,
    user_id: opts.user_id,
    job_id: opts.job_id
  };

  const startTime = Date.now();

  const span: Span = {
    ...spanData,
    setAttribute(key: string, value: any) {
      // Explicitly forbid sensitive keys
      const forbidden = ['prompt', 'email_body', 'context', 'memory_content'];
      if (forbidden.includes(key) || key.includes('prompt')) {
        return; 
      }
      
      let finalVal = value;
      if (typeof value === 'string' && value.length > 500) {
        finalVal = value.substring(0, 500) + '...[TRUNCATED]';
      }
      
      const previousValue = this.attributes[key];
      this.attributes[key] = finalVal;
      
      // Enforce absolute 8KB JSONB serialized size limit per span
      if (JSON.stringify(this.attributes).length > 8192) {
        // Revert change
        if (previousValue !== undefined) {
          this.attributes[key] = previousValue;
        } else {
          delete this.attributes[key];
        }
      }
    },
    setStatus(status: 'ok' | 'error' | 'unset', message?: string) {
      this.status = status;
      if (message) this.status_message = message;
    },
    end() {
      try {
        this.duration_ms = Date.now() - startTime;
        
        spanBuffer.push({
          span_id: this.span_id,
          trace_id: this.trace_id,
          parent_span_id: this.parent_span_id,
          service: this.service,
          operation: this.operation,
          span_kind: this.span_kind,
          started_at: this.started_at,
          duration_ms: this.duration_ms,
          status: this.status,
          status_message: this.status_message,
          attributes: this.attributes,
          user_id: this.user_id,
          job_id: this.job_id
        });

        // Flush reliability trigger: buffer full
        if (spanBuffer.length >= 25 && defaultSupabaseClient) {
          sendBufferedSpans(defaultSupabaseClient).catch(e => {
            console.warn('Failed background trace flush:', e);
          });
        }
      } catch (e) {
        // Observability data is lossy. Production traffic is not.
        console.warn('Failed to end span', e);
      }
    }
  };

  return span;
}

// Utility to dispatch the buffered spans to Postgres at the end of execution
export async function sendBufferedSpans(supabaseClient?: any) {
  const clientToUse = supabaseClient || defaultSupabaseClient;
  if (!clientToUse) return;

  const spans = flushTraceSpans();
  if (spans.length === 0) return;
  
  try {
    const { error } = await clientToUse.rpc('flush_trace_spans', { spans });
    if (error) {
      console.warn('Failed to flush trace spans via RPC:', error.message);
    }
  } catch (e) {
    console.warn('Exception during flush_trace_spans:', e);
  }
}

export async function runWithTrace<T>(operation: string, fn: () => Promise<T> | T): Promise<T> {
  const currentCtx = getCurrentTrace();
  const trace_id = currentCtx?.trace_id || crypto.randomUUID();
  const span = startSpan("simulate_workload", operation, { trace_id, parent_span_id: currentCtx?.span_id });
  return withTraceContext({ trace_id, span_id: span.span_id, parent_span_id: currentCtx?.span_id }, async () => {
    try {
      const result = await fn();
      span.setStatus("ok");
      return result;
    } catch (e: any) {
      span.setStatus("error", e.message || String(e));
      throw e;
    } finally {
      span.end();
    }
  });
}

export const flushSpans = sendBufferedSpans;

