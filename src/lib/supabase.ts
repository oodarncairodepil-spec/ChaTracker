import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-key";

if (supabaseUrl === "https://placeholder.supabase.co") {
    console.warn("Supabase credentials missing. Using placeholder for build.");
    if (process.env.NODE_ENV === 'production') {
        console.error("CRITICAL ERROR: NEXT_PUBLIC_SUPABASE_URL is missing in Vercel Environment Variables! The bot cannot connect to the database.");
    }
}

// Note: In API routes/server components, prefer using SERVICE_ROLE_KEY for admin tasks
export const supabase = createClient(supabaseUrl, supabaseKey);
