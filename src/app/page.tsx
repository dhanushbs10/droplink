"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, ArrowUpRight, Zap } from "lucide-react";
import type { User } from "@supabase/supabase-js";

import { BackgroundOne } from "@/components/backgrounds/BackgroundOne";
import { Button } from "@/components/ui/button";
import { Cursor } from "@/components/landing/cursor";
import { Grain } from "@/components/landing/grain";
import { Reveal } from "@/components/landing/reveal";
import { UserMenu } from "@/components/user-menu";
import {
  fetchRecentBuddies,
  formatRelative,
  type Buddy,
} from "@/lib/supabase/buddies";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";

const CLAIMS = [
  {
    title: "A code, not an account",
    body: "Send opens a room and shows an 8-character code. The receiver types it in and you are paired. No signup, no profile, nothing to remember.",
  },
  {
    title: "Direct pair, no middleman",
    body: "Your browser talks straight to theirs over WebRTC. The relay carries room control only. The file itself never touches a server.",
  },
  {
    title: "Full speed on your network",
    body: "Same-network peers route at local LAN speed. Off-network peers take the fastest reachable path. Everything is encrypted in transit.",
  },
];

export default function Home() {
  const wipeRef = useRef<HTMLHeadingElement | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [buddiesLoaded, setBuddiesLoaded] = useState(false);
  // When accounts are not configured there is nothing to load, so the panel is
  // never in a loading state. Derived during render rather than set in an effect.
  const accountsConfigured = isSupabaseConfigured();
  const buddiesPending = accountsConfigured && !buddiesLoaded;

  useEffect(() => {
    let active = true;
    const supabase = getSupabase();
    if (!supabase) {
      // No account backend: nothing to load. Derive the "loaded" state during
      // render instead of setting it from inside the effect.
      return;
    }
    let refreshInFlight = false;
    let refreshQueued = false;
    const refresh = async () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try {
        const result = await fetchRecentBuddies();
        if (!active) return;
        setUser(result.user);
        setBuddies(result.buddies);
        setBuddiesLoaded(true);
      } finally {
        refreshInFlight = false;
        if (refreshQueued && active) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    void refresh();
    const { data: subscription } = supabase.auth.onAuthStateChange(() => {
      void refresh();
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const handleWipe = (event: MouseEvent<HTMLHeadingElement>) => {
    const el = wipeRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(
      100,
      Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)
    );
    el.classList.remove("is-returning");
    el.style.setProperty("--wx", `${x}%`);
  };

  const handleWipeLeave = () => {
    const el = wipeRef.current;
    if (!el) return;
    el.classList.add("is-returning");
    el.style.setProperty("--wx", "0%");
  };

  return (
    <div className="relative flex flex-1 flex-col">
      <BackgroundOne />
      <Grain />
      <Cursor />

      <section className="relative flex min-h-svh flex-1 flex-col px-5 pt-5 sm:px-8">
        <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
          <span className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-[4px] border border-zinc-800 bg-zinc-900">
              <Zap className="h-3.5 w-3.5 text-zinc-300" />
            </span>
            <span className="text-zinc-300">DropLink</span>
          </span>
          <div className="flex items-center gap-6">
            <nav className="flex items-center gap-6">
              <Link
                href="/send"
                className="transition-colors hover:text-zinc-200"
              >
                Send
              </Link>
              <Link
                href="/receive"
                className="transition-colors hover:text-zinc-200"
              >
                Receive
              </Link>
            </nav>
            <span className="hidden h-3 w-px bg-zinc-800 sm:inline-block" />
            <UserMenu />
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center sm:py-16">
<Reveal variant="clip" delay={80}>
            <h1
              ref={wipeRef}
              aria-label="DropLink"
              onMouseMove={handleWipe}
              onMouseLeave={handleWipeLeave}
              className="relative inline-block text-[clamp(4.5rem,20vw,16rem)] font-semibold leading-[0.85] tracking-[-0.045em]"
            >
              <span aria-hidden className="block text-zinc-100">
                DROP
              </span>
              <span aria-hidden className="wipe-word-outline block">
                LINK
              </span>
              <span
                aria-hidden
                className="wipe-text absolute inset-0 left-0 top-0"
              >
                <span className="wipe-word-cutout block">DROP</span>
                <span className="block text-zinc-100">LINK</span>
              </span>
            </h1>
          </Reveal>

          <Reveal variant="rise" delay={160} className="mt-10 max-w-md">
            <p className="text-base text-zinc-400 sm:text-lg">
              From one device straight to another, over WebRTC. No account,
              no server in the data path, no size cap.
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row">
              <Button
                asChild
                size="lg"
                className="min-w-[12rem] rounded-[4px]"
              >
                <Link href="/send">
                  Begin a transfer
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="min-w-[12rem] rounded-[4px]"
              >
                <Link href="/receive">Join with a room code</Link>
              </Button>
            </div>
          </Reveal>

          {user && (
            <div className="w-full max-w-md pt-14 text-left">
              <div className="flex items-baseline justify-between">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                  Recent connections
                </h2>
                {buddies.length > 0 && (
                  <span className="font-mono text-xs text-zinc-600">
                    {buddies.length}
                  </span>
                )}
              </div>
              {buddiesPending ? (
                <p className="mt-4 text-sm text-zinc-600">Loading...</p>
              ) : buddies.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-500">
                  No connections yet. Your buddies appear here once you finish
                  a transfer.
                </p>
              ) : (
                <div className="mt-4 overflow-hidden rounded-[4px] border border-zinc-800">
                  <div className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                    <span className="flex-1">Buddy</span>
                    <span>Connected</span>
                    <span className="w-4" />
                  </div>
                  <ul className="flex flex-col">
                    {buddies.map((buddy) => (
                      <li
                        key={buddy.buddyId}
                        className="border-t border-zinc-800 first:border-t-0"
                      >
                        <Link
                          href="/send"
                          className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-zinc-900/60"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-zinc-800 bg-zinc-900 font-mono text-[11px] uppercase tracking-wider text-zinc-200">
                            {buddy.username.slice(0, 2)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-zinc-200">
                              {buddy.username}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                            {formatRelative(buddy.lastConnected)}
                          </span>
                          <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-300" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="relative px-4 py-20 sm:py-28">
        <div className="mx-auto w-full max-w-4xl">
          {CLAIMS.map((claim, index) => (
            <Reveal
              key={claim.title}
              variant="slide"
              delay={index * 60}
              className="group relative overflow-hidden border-t border-zinc-800 py-8 sm:py-10"
            >
              <span
                aria-hidden
                className="absolute inset-0 origin-left scale-x-0 bg-zinc-100 transition-transform duration-500 ease-out group-hover:scale-x-100"
              />
              <div className="relative flex items-baseline">
                <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 transition-colors duration-500 group-hover:text-zinc-900 sm:text-4xl">
                  {claim.title}
                </h2>
                <ArrowUpRight className="ml-auto h-5 w-5 shrink-0 text-zinc-600 transition-all duration-500 group-hover:-translate-y-1 group-hover:translate-x-1 group-hover:text-zinc-900 sm:h-6 sm:w-6" />
              </div>
              <p className="relative mt-3 max-w-xl text-sm text-zinc-500 transition-colors duration-500 group-hover:text-zinc-700 sm:mt-4 sm:text-base">
                {claim.body}
              </p>
            </Reveal>
          ))}
          <Reveal variant="rise" delay={60}>
            <div className="border-t border-zinc-800 pt-10">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
                Start from this device
              </p>
              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row">
                <Button
                  asChild
                  size="lg"
                  className="min-w-[12rem] rounded-[4px]"
                >
                  <Link href="/send">
                    Begin a transfer
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="min-w-[12rem] rounded-[4px]"
                >
                  <Link href="/receive">Join with a room code</Link>
                </Button>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
}