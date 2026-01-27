import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Note: In API routes/server components, prefer using SERVICE_ROLE_KEY for admin tasks
export const supabase = createClient(supabaseUrl, supabaseKey);
