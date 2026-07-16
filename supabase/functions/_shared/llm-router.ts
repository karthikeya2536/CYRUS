// This file has been replaced with a simplified interface to OmniRoute.
// All provider-specific logic has been removed.
// The LLMRouter now acts as a thin wrapper over OmniRoute.

import { estimateCost } from "./pricing.ts";
import { getCurrentTrace } from "./trace.ts";

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Interface for LLM requests
export interface LLMRequest {
  systemPrompt?: string;
  userPrompt: string;
  expectedFormat?: 'json' | 'text';
  capability?: string; // e.g., "reasoning", "fine_reasoning", "summarization", "extraction"
}

export interface LLMResponse {
  content: string;
  provider: string; // Will be set to "omniroute"
  model: string;    // The model used by OmniRoute (if available)
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costEstimate: number;
  estimated?: boolean;
}

export class LLMRouter {
  // Simple wrapper around OmniRoute API
  private static async callOmniRoute(endpoint: string, payload: any): Promise<any> {
    const baseUrl = Deno.env.get('OMNIROUTE_BASE_URL') ?? '';
    const apiKey = Deno.env.get('OMNIROUTE_API_KEY') ?? '';
    if (!baseUrl || !apiKey) {
      throw new Error('OmniRoute configuration missing');
    }

    const controller = new AbortController();
    const timeoutMs = parseInt(Deno.env.get('OMNIROUTE_TIMEOUT') ?? '10000');
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMsg = `HTTP_${response.status}`;
        if (response.status === 429) {
          errorMsg = 'RATE_LIMIT';
        } else if (response.status >= 500) {
          errorMsg = 'SERVER_ERROR';
        }
        throw new Error(errorMsg);
      }

      return await response.json();
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }
      throw err;
    }
  }

  /**
   * Executes a prompt using OmniRoute with automatic failover handled by OmniRoute.
   * @param request The prompt and formatting requirements
   */
  public static async execute(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    // Determine capability - default to "reasoning" if not specified
    const capability = request.capability ?? 'reasoning';

    // Construct the prompt
    const fullPrompt = `${request.systemPrompt ? request.systemPrompt + '\n\n' : ''}${request.userPrompt}${request.expectedFormat === 'json' ? '\n\n[OUTPUT MUST BE VALID JSON ONLY]' : ''}`;

    // Call OmniRoute completion endpoint
    const response = await this.callOmniRoute('/v1/completions', {
      model: Deno.env.get('OMNIROUTE_DEFAULT_MODEL') || '',
      prompt: fullPrompt,
      max_tokens: 2048, // TODO: make configurable
      temperature: 0.7,
      // Add stream: false to ensure JSON response (not SSE streaming)
      stream: false,
      // Pass capability as a parameter for OmniRoute to use in routing
      capability,
      response_format: request.expectedFormat === 'json' ? { type: 'json_object' } : { type: 'text' }
    });

    const latencyMs = Date.now() - startTime;

    // Extract response data (structure depends on OmniRoute implementation)
    const content = response.choices?.[0]?.text ?? response.choices?.[0]?.message?.content ?? '';
    const model = response.model ?? 'unknown';
    const usage = response.usage || {};

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let estimated = false;

    try {
      if (usage.prompt_tokens !== undefined) {
        inputTokens = usage.prompt_tokens;
        outputTokens = usage.completion_tokens || 0;
        totalTokens = usage.total_tokens || (inputTokens + outputTokens);
      } else {
        // Fallback to estimation
        inputTokens = Math.ceil(fullPrompt.length / 4);
        outputTokens = Math.ceil(content.length / 4);
        totalTokens = inputTokens + outputTokens;
        estimated = true;
      }
    } catch (err) {
      console.warn('Token extraction failed, estimating from length', err);
      const content = response.choices?.[0]?.message?.content ?? '';
      inputTokens = Math.ceil(fullPrompt.length / 4);
      outputTokens = Math.ceil(content.length / 4);
      totalTokens = inputTokens + outputTokens;
      estimated = true;
    }

    const costEstimate = estimateCost('omniroute', inputTokens, outputTokens, model);

    return {
      content,
      provider: 'omniroute',
      model,
      latencyMs,
      inputTokens,
      outputTokens,
      totalTokens,
      costEstimate,
      estimated
    };
  }

  /**
   * Generates an embedding for the given text using OmniRoute.
   * @param text The text to embed
   */
  public static async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.callOmniRoute('/v1/embeddings', {
        model: Deno.env.get('OMNIROUTE_EMBEDDING_MODEL') || '',
        input: [text],
        encoding_format: 'float',
        dimensions: 768 // Ensure we get 768 dimensions for compatibility
      });

      const embedding = response.data?.[0]?.embedding;
      if (Array.isArray(embedding) && embedding.length === 768) {
        return embedding;
      } else {
        throw new Error('Invalid embedding response from OmniRoute');
      }
    } catch (e) {
      console.error('OmniRoute embedding failed:', e);
      throw new Error('All embedding providers failed via OmniRoute');
    }
  }
}

// Helper function to create Supabase client (kept for compatibility)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// Note: The original LLMRouter had provider health tracking and other logic.
// All of that has been removed and delegated to OmniRoute.
// The pricing.ts file is kept for now but may be updated to use OmniRoute pricing.