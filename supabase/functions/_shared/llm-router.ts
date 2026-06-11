import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

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
  latencyMs: number;
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

  private static async updateProviderHealth(provider: string, status: 'success' | 'failure' | 'timeout' | 'rate_limit') {
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
    }

    await supabaseAdmin.from('provider_health').update(updates).eq('provider_name', provider);
  }

  private static async callDirectApi(provider: string, prompt: string): Promise<string> {
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
      return data.choices?.[0]?.message?.content || "";
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
        await this.updateProviderHealth(currentProvider, 'success');
        
        return {
          content: result,
          provider: currentProvider,
          latencyMs: Date.now() - startTime
        };
      } catch (err: any) {
        const errorType = err.message;
        
        if (errorType === 'TIMEOUT') {
          await this.updateProviderHealth(currentProvider, 'timeout');
        } else if (errorType === 'RATE_LIMIT') {
          await this.updateProviderHealth(currentProvider, 'rate_limit');
        } else {
          await this.updateProviderHealth(currentProvider, 'failure');
        }

        // Exclude the failed provider and try the next one
        excludedProviders.push(currentProvider);
        currentProvider = await this.getAvailableProvider(excludedProviders);
      }
    }

    // If we reach here, all LLMs failed or timed out. Fall back to Rule Engine.
    return {
      content: "RULE_ENGINE_FALLBACK",
      provider: 'rule-engine',
      latencyMs: 0
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
    console.log("GEMINI KEY EXISTS:", !!Deno.env.get("GEMINI_API_KEY"));
    console.log("NVIDIA KEY EXISTS:", !!Deno.env.get("NVIDIA_API_KEY"));

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
        console.log("Gemini response:", JSON.stringify(data));
        const embedding = data?.embedding?.values;
        console.log("Gemini dimensions:", embedding ? embedding.length : "none");
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
        console.log("NVIDIA response:", JSON.stringify(data));
        const embedding = data?.data?.[0]?.embedding;
        console.log("NVIDIA dimensions:", embedding ? embedding.length : "none");
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