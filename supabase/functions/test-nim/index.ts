import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
  const text = await res.text();
  return new Response(text, { headers: { "Content-Type": "application/json" } });
});
