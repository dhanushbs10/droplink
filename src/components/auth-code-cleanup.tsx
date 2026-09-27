"use client";

import { useEffect } from "react";
import { getSupabase } from "@/lib/supabase/client";

export function AuthCodeCleanup() {
  useEffect(() => {
    // The /auth/callback route handler performs its own exchangeCodeForSession.
    // A PKCE code is strictly single-use, so running this on that route too
    // means one of the two always fails and the failure is swallowed. Skip it
    // there and let the route handler own the exchange.
    if (window.location.pathname.startsWith("/auth/callback")) return;

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.auth
      .exchangeCodeForSession(code)
      .catch(() => {})
      .finally(() => {
        url.searchParams.delete("code");
        const next = url.pathname + url.search + url.hash;
        window.history.replaceState({}, "", next || "/");
        window.dispatchEvent(new Event("supabase:code-exchanged"));
      });
  }, []);
  return null;
}
