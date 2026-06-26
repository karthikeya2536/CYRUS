import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing env vars");
  Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDates() {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('start_time, title')
    .order('start_time', { ascending: false })
    .limit(5);
    
  console.log('Max Dates in DB:', data);
}
checkDates();
