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

async function testEdgeFunction() {
  const url = process.env.VITE_SUPABASE_URL 
    ? `${process.env.VITE_SUPABASE_URL}/functions/v1/google-oauth-exchange`
    : 'https://qdtyxwmejvyxqgtpibqn.supabase.co/functions/v1/google-oauth-exchange';
    
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!anonKey) {
    console.error('Error: VITE_SUPABASE_ANON_KEY is not set in environment or .env file');
    process.exit(1);
  }

  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`
      },
      body: JSON.stringify({ code: 'test_code' })
    });
    
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text}`);
  } catch (e) {
    console.error('Error:', e);
  }
}

testEdgeFunction();
