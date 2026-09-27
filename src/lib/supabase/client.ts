import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let supabaseClient: SupabaseClient | null = null;

/**
 * Returns true when the optional account backend is configured. Auth is a
 * progressive enhancement: the P2P transfer features must keep working when it
 * is not, so callers should gate on this instead of assuming a client exists.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function createClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Add it to .env.local before using account features."
    );
  }
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Add it to .env.local before using account features."
    );
  }
  return createBrowserClient(url, anonKey);
}

/**
 * Returns the shared client, or null when Supabase is not configured or failed
 * to initialize. Never throws, so an unconfigured backend cannot take down the
 * surrounding React tree.
 */
export function getSupabase(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  if (!isSupabaseConfigured()) return null;
  try {
    supabaseClient = createClient();
    return supabaseClient;
  } catch {
    return null;
  }
}