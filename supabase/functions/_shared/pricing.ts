export interface TokenPricing {
  inputPer1k: number;
  outputPer1k: number;
}

// Simplified pricing for OmniRoute - replace with actual values when available
export const PROVIDER_PRICING: Record<string, TokenPricing> = {
  'omniroute': { inputPer1k: 0.0001, outputPer1k: 0.0002 } // Placeholder values
};

export const EMBEDDING_PRICING = {
  // Assuming OmniRoute embedding model pricing
  'omniroute-embed': { inputPer1kChars: 0.00002 } // Placeholder
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