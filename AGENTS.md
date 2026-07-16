### LLM routing (`_shared/llm-router.ts`)
All LLM requests go through the `LLMRouter` class, which acts as a thin wrapper over OmniRoute, the centralized AI gateway. The router provides two main methods:
- `execute(request)`: processes a prompt and returns generated text. The `request` can specify a `capacity` (e.g., 'reasoning', 'summarization', 'extraction') to help OmniRoute select the appropriate model.
- `generateEmbedding(text)`: returns a 768-dimensional embedding vector using OmniRoute.

This design ensures that no edge function contains provider-specific logic or model names. All routing, fallback, and provider selection is handled by OmniRoute.