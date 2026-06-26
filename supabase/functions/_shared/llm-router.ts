import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { estimateCost } from "./pricing.ts";
import { getCurrentTrace } from "./trace.ts";

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export const PROVIDERS = [
  'gemini-3.1-flash-lite',
  'gpt-oss-120b',
  'gemma-3-27b',
  'nvidia-nim',
  'groq-llama-3.1-8b',
  'rule-engine' // local fallback
];

interface LLMRequest {
  systemPrompt?: string;
  userPrompt: string;
  expectedFormat?: 'json' | 'text';
}

interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costEstimate: number;
  estimated?: boolean;
}

export class LLMRouter {
  private static async getProviderHealth(provider: string) {
    const { data } = await supabaseAdmin
      .from('provider_health')
      .select('*')
      .eq('provider_name', provider)
      .maybeSingle();

    if (!data) {
      // Initialize if not exists
      await supabaseAdmin.from('provider_health').insert([{ provider_name: provider }]);
      return { failure_count: 0, cooldown_until: null };
    }
    return data;
  }

  private static async updateProviderHealth(provider: string, status: 'success' | 'failure' | 'timeout' | 'rate_limit', stats?: { tokens: number, cost: number, latencyMs: number, errorMsg?: string }) {
    const health = await this.getProviderHealth(provider);
    const updates: any = {};
    const now = new Date().toISOString();

    if (status === 'success') {
      updates.success_count = (health.success_count || 0) + 1;
      updates.failure_count = 0; // reset
      updates.last_success = now;
      updates.cooldown_until = null;
    } else {
      updates.last_failure = now;
      if (status === 'failure') updates.failure_count = (health.failure_count || 0) + 1;
      if (status === 'timeout') updates.timeout_count = (health.timeout_count || 0) + 1;
      if (status === 'rate_limit') updates.rate_limit_count = (health.rate_limit_count || 0) + 1;

      // Circuit breaker: 3 consecutive failures (failure or timeout)
      const currentFailures = (health.failure_count || 0) + (status !== 'rate_limit' ? 1 : 0);
      if (currentFailures >= 3) {
        updates.cooldown_until = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min cooldown
      }
      // Rate limit cooldown (e.g. 60 seconds)
      if (status === 'rate_limit') {
        updates.cooldown_until = new Date(Date.now() + 60 * 1000).toISOString(); // 1 min cooldown
      }
      if (stats?.errorMsg) updates.last_error = stats.errorMsg;
    }

    if (stats) {
      updates.total_tokens = (health.total_tokens || 0) + stats.tokens;
      updates.total_cost = (health.total_cost || 0) + stats.cost;
      if (stats.latencyMs > 0) {
        updates.avg_latency_ms = stats.latencyMs; 
      }
    }

    await supabaseAdmin.from('provider_health').update(updates).eq('provider_name', provider);
  }

  private static async callDirectApi(provider: string, prompt: string): Promise<{content: string, model: string, inputTokens: number, outputTokens: number, totalTokens: number}> {
    let url = "";
    let apiKey = "";
    let model = provider;

    if (provider === 'gemini-3.1-flash-lite') {
      url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = Deno.env.get("GEMINI_API_KEY") || "";
      model = "gemini-3.1-flash-lite"; // Fallback to standard 1.5 flash for OpenAI compat
    } else if (provider === 'gpt-oss-120b') {
      url = "https://api.cerebras.ai/v1/chat/completions";
      apiKey = Deno.env.get("CEREBRAS_API_KEY") || "";
      model = "gpt-oss-120b"; // Cerebras model
    } else if (provider === 'gemma-3-27b') {
      url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = Deno.env.get("GEMINI_API_KEY") || "";
      model = "gemma-3-27b"; // Replace with "gemma-3-27b-it" if applicable when available
    } else if (provider === 'nvidia-nim') {
      url = "https://integrate.api.nvidia.com/v1/chat/completions";
      apiKey = Deno.env.get("NVIDIA_API_KEY") || "";
      model = "nvidia/nemotron-3-super-120b-a12b";
    } else if (provider === 'groq-llama-3.1-8b') {
      url = "https://api.groq.com/openai/v1/chat/completions";
      apiKey = Deno.env.get("GROQ_API_KEY") || "";
      model = "llama-3.1-8b-instant";
    }

    if (!apiKey) {
      throw new Error('MISSING_API_KEY');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        throw new Error('RATE_LIMIT');
      }

      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`);
      }

      const data = await response.json();
      
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let estimated = false;
      
      try {
        if (data.usage?.prompt_tokens !== undefined) {
          inputTokens = data.usage.prompt_tokens;
          outputTokens = data.usage.completion_tokens || 0;
          totalTokens = data.usage.total_tokens || (inputTokens + outputTokens);
        } else if (data.usage?.total_tokens !== undefined) {
          totalTokens = data.usage.total_tokens;
        } else if (data.usage_metadata?.prompt_token_count !== undefined) { // Gemini
          inputTokens = data.usage_metadata.prompt_token_count;
          outputTokens = data.usage_metadata.candidates_token_count || 0;
          totalTokens = data.usage_metadata.total_token_count || (inputTokens + outputTokens);
        } else {
          // Fallback to text length estimation
          const content = data.choices?.[0]?.message?.content || "";
          inputTokens = Math.ceil(prompt.length / 4);
          outputTokens = Math.ceil(content.length / 4);
          totalTokens = inputTokens + outputTokens;
          estimated = true;
        }
      } catch (err) {
        console.warn('Token extraction failed, estimating from length', err);
        const content = data.choices?.[0]?.message?.content || "";
        inputTokens = Math.ceil(prompt.length / 4);
        outputTokens = Math.ceil(content.length / 4);
        totalTokens = inputTokens + outputTokens;
        estimated = true;
      }

      return {
        content: data.choices?.[0]?.message?.content || "",
        model: data.model || model,
        inputTokens,
        outputTokens,
        totalTokens,
        estimated
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }
      throw err;
    }
  }

  // Returns the highest priority provider that is not on cooldown and is not excluded
  private static async getAvailableProvider(excludedProviders: string[] = []): Promise<string | null> {
    for (const provider of PROVIDERS) {
      if (excludedProviders.includes(provider)) continue;
      if (provider === 'rule-engine') return provider; // always available fallback

      const health = await this.getProviderHealth(provider);
      if (health.cooldown_until && new Date(health.cooldown_until) > new Date()) {
        continue; // On cooldown
      }
      return provider;
    }
    return 'rule-engine';
  }

  private static recordCostEvent(event: any) {
    try {
      const traceCtx = getCurrentTrace();
      const p = supabaseAdmin.from('cost_events').insert({
        trace_id: traceCtx?.trace_id,
        span_id: traceCtx?.span_id,
        ...event
      });
      const rt = (globalThis as any).EdgeRuntime;
      if (rt && typeof rt.waitUntil === "function") {
        rt.waitUntil(Promise.resolve(p).catch(() => {}));
      } else {
        Promise.resolve(p).catch(() => {});
      }
    } catch (e) {
      console.warn("recordCostEvent failed", e);
    }
  }

  /**
   * Executes a prompt using the best available LLM with automatic failover.
   * @param request The prompt and formatting requirements
   * @param excludedProviders Providers to skip (e.g. if we need a different verifier)
   * @param isRetry Internal use only
   */
  public static async execute(request: LLMRequest, excludedProviders: string[] = []): Promise<LLMResponse> {
    const fullPrompt = `${request.systemPrompt ? request.systemPrompt + '\n\n' : ''}${request.userPrompt}${request.expectedFormat === 'json' ? '\n\n[OUTPUT MUST BE VALID JSON ONLY]' : ''}`;
    
    let currentProvider = await this.getAvailableProvider(excludedProviders);
    
    while (currentProvider && currentProvider !== 'rule-engine') {
      const startTime = Date.now();
      try {
        const result = await this.callDirectApi(currentProvider, fullPrompt);
        const latencyMs = Date.now() - startTime;
        const costEstimate = estimateCost(currentProvider, result.inputTokens, result.outputTokens, result.model);

        await this.updateProviderHealth(currentProvider, 'success', {
          tokens: result.totalTokens,
          cost: costEstimate,
          latencyMs
        });
        
        this.recordCostEvent({
          provider: currentProvider,
          model: result.model,
          operation: 'chat',
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.totalTokens,
          cost_estimate: costEstimate,
          latency_ms: latencyMs,
          status: 'success',
          attributes: result.estimated ? { estimated_tokens: true, confidence: "low" } : {}
        });

        return {
          content: result.content,
          provider: currentProvider,
          model: result.model,
          latencyMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
          costEstimate
        };
      } catch (err: any) {
        const errorType = err.message;
        
        const latencyMs = Date.now() - startTime;

        if (errorType === 'TIMEOUT') {
          await this.updateProviderHealth(currentProvider, 'timeout', { tokens: 0, cost: 0, latencyMs, errorMsg: errorType });
        } else if (errorType === 'RATE_LIMIT') {
          await this.updateProviderHealth(currentProvider, 'rate_limit', { tokens: 0, cost: 0, latencyMs, errorMsg: errorType });
        } else {
          await this.updateProviderHealth(currentProvider, 'failure', { tokens: 0, cost: 0, latencyMs, errorMsg: errorType });
        }

        this.recordCostEvent({
          provider: currentProvider,
          model: currentProvider,
          operation: 'chat',
          latency_ms: latencyMs,
          status: 'error',
          error_message: errorType
        });

        // Exclude the failed provider and try the next one (no caller-array mutation)
        excludedProviders = [...excludedProviders, currentProvider];
        currentProvider = await this.getAvailableProvider(excludedProviders);
      }
    }

    // If we reach here, all LLMs failed or timed out. Fall back to Rule Engine.
    return {
      content: "RULE_ENGINE_FALLBACK",
      provider: 'rule-engine',
      model: 'rule-engine',
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costEstimate: 0
    };
  }

  /**
   * Generates an embedding for the given text.
   * Primary: Gemini text-embedding-004
   * Fallback: NVIDIA NIM (snowflake/arctic-embed-m)
   *
   * NOTE: Do NOT hard-require 768 dimensions; providers may return different dimensions.
   */
    public static async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Primary: Gemini
      // FIX 1: Use text-embedding-004 and explicitly request 768 dimensions
      const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";
      const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
      if (!geminiKey) throw new Error("Missing GEMINI_API_KEY");

      const res = await fetch(`${geminiUrl}?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text }] }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data?.embedding?.values;
        if (embedding && embedding.length === 768) return embedding;
      } else {
        console.error("Gemini embedding error response:", await res.text());
      }
    } catch (e) {
      console.error("Gemini embedding failed:", e);
    }

    // Fallback: NVIDIA NIM
    try {
      const nimUrl = "https://integrate.api.nvidia.com/v1/embeddings";
      const nimKey = Deno.env.get("NVIDIA_API_KEY") || "";
      if (!nimKey) throw new Error("Missing NVIDIA_API_KEY");

      const res = await fetch(nimUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${nimKey}`
        },
        body: JSON.stringify({
          input: [text],
          model: "nvidia/llama-nemotron-embed-1b-v2", // FIX 2: Use an active 768-compatible model
          encoding_format: "float",
          dimensions: 768, // Explicitly request 768 dimensions for database compatibility
          input_type: "passage" // FIX 3: Required for asymmetric models
        })
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data?.data?.[0]?.embedding;
        if (embedding && embedding.length === 768) return embedding;
      } else {
        console.error("NVIDIA NIM embedding error response:", await res.text());
      }
    } catch (e) {
      console.error("NVIDIA NIM embedding failed:", e);
    }

    throw new Error("All embedding providers failed");
  }
}