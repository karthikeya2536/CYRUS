import { createClient } from '@supabase/supabase-js';

import fs from 'fs';

// Load env variables from .env file if it exists
if (fs.existsSync('.env')) {
  const envConfig = fs.readFileSync('.env', 'utf-8');
  envConfig.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://qdtyxwmejvyxqgtpibqn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY is not set in environment or .env file');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function checkSchema() {
  const { data: accounts, error: accountErr } = await supabaseAdmin
    .from('connected_accounts')
    .select('*')
    .limit(1);
    
  console.log('connected_accounts data:', accounts, accountErr);
  
  const { data: secrets, error: secretErr } = await supabaseAdmin
    .from('integration_secrets')
    .select('*')
    .limit(1);
    
  console.log('integration_secrets data:', secrets, secretErr);
}

checkSchema();
