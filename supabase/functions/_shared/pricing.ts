export interface TokenPricing {
  inputPer1k: number;
  outputPer1k: number;
}

export const PROVIDER_PRICING: Record<string, TokenPricing> = {
  'gemini-3.1-flash-lite': { inputPer1k: 0.00001875, outputPer1k: 0.000075 },
  'gpt-oss-120b': { inputPer1k: 0.00015, outputPer1k: 0.00015 },
  'gemma-3-27b': { inputPer1k: 0.000075, outputPer1k: 0.00015 },
  'nvidia-nim': { inputPer1k: 0.00015, outputPer1k: 0.00015 },
  'groq-llama-3.1-8b': { inputPer1k: 0.00005, outputPer1k: 0.00008 }
};

export const EMBEDDING_PRICING = {
  'text-embedding-004': { inputPer1kChars: 0.000025 }
};

export function estimateCost(provider: string, inputTokens: number, outputTokens: number, model?: string): number {
  try {
    const pricing = PROVIDER_PRICING[provider];
    if (!pricing) return 0;
    return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
  } catch (e) {
    return 0;
  }
}
