import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function run() {
  const supabase1 = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: authData } = await supabase1.auth.signInWithPassword({
    email: 'test_1781598540037@example.com',
    password: 'password123'
  });
  const token = authData.session.access_token;

  const authHeader = `Bearer ${token}`;

  const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  console.log("Without token param:", user?.id, userError?.message);

  const { data: { user: user2 }, error: userError2 } = await supabaseUser.auth.getUser(token.trim());
  console.log("With token param:", user2?.id, userError2?.message);
}
run();
