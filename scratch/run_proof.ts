import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = 'https://qdtyxwmejvyxqgtpibqn.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkdHl4d21lanZ5eHFndHBpYnFuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDYzODEyMiwiZXhwIjoyMDk2MjE0MTIyfQ.SwrclD4yQRVJJe9DhxI9TJgIQRLnFnBq2MnINuYZYes';

const supabase = createClient(supabaseUrl, supabaseKey);

async function runAudit() {
  console.log("=== 1. Migration Verification ===");
  // I need to use RPC or query the supabase_migrations.schema_migrations table.
  // The service role might not have direct access to supabase_migrations schema via PostgREST.
  // Let's try anyway.
  try {
    const { data: migrations, error: migErr } = await supabase
      .schema('supabase_migrations')
      .from('schema_migrations')
      .select('version, name')
      .order('version', { ascending: false })
      .limit(10);
    console.log(migErr ? "Error: " + migErr.message : migrations);
  } catch(e) { console.log(e); }

  console.log("\n=== 2. Calendar Event Bounds ===");
  // We can't do MIN/MAX natively easily with simple select without RPC. Let's fetch order by asc and desc.
  const { data: minData } = await supabase.from('calendar_events').select('start_time').order('start_time', { ascending: true }).limit(1);
  const { data: maxData } = await supabase.from('calendar_events').select('start_time').order('start_time', { ascending: false }).limit(1);
  const { count } = await supabase.from('calendar_events').select('*', { count: 'exact', head: true });
  console.log("MIN(start_time):", minData?.[0]?.start_time);
  console.log("MAX(start_time):", maxData?.[0]?.start_time);
  console.log("COUNT(*):", count);

  console.log("\n=== 4. Briefing Generation Verification ===");
  // Trigger a fresh briefing generation manually via Edge Function!
  // Wait, the edge function generate-briefing can be called via curl.
  // I'll leave that to curl.
}
runAudit();
