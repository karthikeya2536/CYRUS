import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://qdtyxwmejvyxqgtpibqn.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Let's use anon key to count if we can? Or just run `npx supabase db query` instead of JS script.
