import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://qdtyxwmejvyxqgtpibqn.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  console.error("VITE_SUPABASE_ANON_KEY not found in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function run() {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: 'test_1781598540037@example.com',
    password: 'password123'
  });

  if (authError) {
    console.error("Auth Error:", authError.message);
    process.exit(1);
  }

  const token = authData.session.access_token;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-briefing`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
}

run();
