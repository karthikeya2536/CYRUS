import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = 'https://qdtyxwmejvyxqgtpibqn.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkdHl4d21lanZ5eHFndHBpYnFuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDYzODEyMiwiZXhwIjoyMDk2MjE0MTIyfQ.SwrclD4yQRVJJe9DhxI9TJgIQRLnFnBq2MnINuYZYes';

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: secrets } = await supabase.from('integration_secrets').select('user_id').limit(1);
  if (!secrets || secrets.length === 0) { console.log("No users found"); return; }
  const userId = secrets[0].user_id;
  console.log("Found user:", userId);

  console.log("Triggering calendar sync...");
  const res = await fetch(`${supabaseUrl}/functions/v1/calendar-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': 'your_super_long_random_worker_secret_here'
    },
    body: JSON.stringify({ user_id: userId })
  });
  console.log("Sync Response:", await res.text());

  // Wait for 2 seconds
  await new Promise(r => setTimeout(r, 2000));

  const { data: minData } = await supabase.from('calendar_events').select('start_time').order('start_time', { ascending: true }).limit(1);
  const { data: maxData } = await supabase.from('calendar_events').select('start_time').order('start_time', { ascending: false }).limit(1);
  const { count } = await supabase.from('calendar_events').select('*', { count: 'exact', head: true });
  console.log("MIN(start_time):", minData?.[0]?.start_time);
  console.log("MAX(start_time):", maxData?.[0]?.start_time);
  console.log("COUNT(*):", count);
}
run();
