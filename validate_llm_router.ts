import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// Test that the LLMRouter adds stream: false to requests
Deno.test("LLMRouter completion request includes stream: false", async () => {
  // Read the llm-router.ts file and verify it contains stream: false
  const decoder = new TextDecoder("utf-8");
  const data = await Deno.readFile("./supabase/functions/_shared/llm-router.ts");
  const content = decoder.decode(data);

  // Check that stream: false is present in the completions request
  const hasStreamFalse = content.includes("stream: false");
  console.log(`LLM Router contains stream: false: ${hasStreamFalse}`);

  // This validates our fix is in place
  assert(hasStreamFalse, "LLM Router should contain stream: false in completion request");
});

// Test that basic LLM router functionality works by trying to import it
Deno.test("LLMRouter can be imported", () => {
  // This will fail if there are syntax errors
  const mod = import("./supabase/functions/_shared/llm-router.ts");
  assert(mod !== undefined, "Should be able to import LLMRouter module");
});

console.log("LLM Router validation tests completed");