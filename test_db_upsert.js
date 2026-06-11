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

async function testInsert() {
  try {
    const { data: users, error: userErr } = await supabaseAdmin.auth.admin.listUsers();
    if (userErr) {
      console.error('Failed to list users:', userErr);
      return;
    }
    
    if (!users.users.length) {
      console.log('No users found in db.');
      return;
    }
    
    const userId = users.users[0].id;
    console.log(`Using user ID: ${userId}`);

    const { data, error: accountError } = await supabaseAdmin
      .from("connected_accounts")
      .upsert(
        {
          user_id: userId,
          provider: "google"
        },
        { onConflict: "user_id,provider" }
      );
      
    if (accountError) {
      console.error('Account upsert error:', accountError);
    } else {
      console.log('Account upsert success!');
    }

    const { data: secretData, error: secretError } = await supabaseAdmin
      .from("integration_secrets")
      .upsert(
        {
          user_id: userId,
          provider: "google",
          access_token: "dummy_access_token",
          refresh_token: "dummy_refresh_token"
        },
        { onConflict: "user_id,provider" }
      );

    if (secretError) {
      console.error('Secret upsert error:', secretError);
    } else {
      console.log('Secret upsert success!');
    }
    
  } catch (err) {
    console.error('Exception:', err);
  }
}

testInsert();
