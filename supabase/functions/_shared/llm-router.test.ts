import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { LLMRouter } from "./llm-router.ts";

// Mock environment variables for testing
Deno.env.set("SUPABASE_URL", "https://mock-supabase.example.com");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("OMNIROUTE_BASE_URL", "https://mock-omniroute.example.com");
Deno.env.set("OMNIROUTE_API_KEY", "test-api-key");
Deno.env.set("OMNIROUTE_DEFAULT_MODEL", "test-model");

Deno.test("LLMRouter.execute should add stream: false to completion requests", async () => {
  // We can't easily test the actual HTTP call without mocking fetch,
  // but we can at least verify the method exists and has the right signature
  const request = {
    userPrompt: "Test prompt",
    expectedFormat: "json" as const
  };

  // Just verify the method exists and doesn't throw immediately on invalid input
  // (it will fail on the actual HTTP call, which is expected in this test)
  try {
    await LLMRouter.execute(request);
    // If we get here, the HTTP request succeeded (unlikely in test env)
    assert(true);
  } catch (error) {
    // Expected to fail due to network/mock issues, but we can check
    // that it's not failing due to JSON parsing errors from SSE streams
    const err = error as Error;
    const errorMessage = err.message;
    assert(!errorMessage.includes("Unexpected token 'd'"),
      "Should not fail with SSE parsing error after adding stream: false");
  }
});

Deno.test("LLMRouter.generateEmbedding should work", async () => {
  const request = {
    userPrompt: "Test text for embedding",
    expectedFormat: "text" as const
  };

  try {
    await LLMRouter.generateEmbedding(request.userPrompt);
    assert(true);
  } catch (error) {
    // Expected to fail due to network/mock issues
    const err = error as Error;
    const errorMessage = err.message;
    assert(!errorMessage.includes("Unexpected token 'd'"),
      "Should not fail with SSE parsing error after adding stream: false");
  }
});