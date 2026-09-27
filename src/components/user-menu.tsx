"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, LogIn, LogOut } from "lucide-react";
import type { User } from "@supabase/supabase-js";

import { AuthDialog } from "@/components/auth-dialog";
import { Button } from "@/components/ui/button";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";

function initialsFor(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local.slice(0, 1).toUpperCase() || "?";
}

export function UserMenu() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const closeAuth = useCallback(() => setAuthOpen(false), []);

  useEffect(() => {
    let active = true;
    let generation = 0;
    // Account features are optional; bail out quietly when unconfigured so the
    // surrounding page keeps working.
    const supabase = getSupabase();
    if (!supabase) {
      return;
    }

    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (active && generation === 0) {
          setUser(data.user ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active && generation === 0) {
          setUser(null);
          setLoading(false);
        }
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      generation += 1;
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      generation += 1;
      subscription.unsubscribe();
    };
  }, []);

  const logout = async () => {
    setOpen(false);
    await getSupabase()?.auth.signOut();
  };

  // With no account backend there is no session to wait for.
  const pending = isSupabaseConfigured() && loading;

  if (pending) {
    return <span className="h-8 w-8 rounded-[4px] border border-zinc-800 bg-zinc-900/60" />;
  }

  if (!user) {
    // Accounts are optional; don't offer a Login affordance when the backend
    // is not configured for this deployment.
    if (!isSupabaseConfigured()) return null;
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAuthOpen(true)}
          className="gap-2 rounded-[4px] font-mono text-[11px] uppercase tracking-[0.2em]"
        >
          <LogIn className="h-3.5 w-3.5" />
          Login
        </Button>
        <AuthDialog open={authOpen} onClose={closeAuth} />
      </>
    );
  }

  const email = user.email ?? "";

  return (
    <>
      <div className="relative">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((value) => !value)}
          className="gap-2 rounded-[4px]"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-[2px] border border-zinc-700 bg-zinc-900 font-mono text-[9px] text-zinc-300">
            {initialsFor(email)}
          </span>
          <span className="hidden max-w-[10rem] truncate font-mono text-[11px] normal-case tracking-normal text-zinc-300 sm:block">
            {email}
          </span>
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        </Button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-[6px] border border-zinc-800 bg-zinc-950 p-2">
              <div className="border-b border-zinc-800 px-2 pb-2">
                <span className="block truncate font-mono text-xs text-zinc-300">
                  {email}
                </span>
                <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                  {user.id.slice(0, 8)}
                </span>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex w-full items-center gap-2 rounded-[4px] px-2 py-2 text-left font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Logout
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}