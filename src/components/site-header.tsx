"use client";

import Link from "next/link";
import { Zap } from "lucide-react";

import { UserMenu } from "@/components/user-menu";

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 pt-5 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500 sm:px-8">
      <Link href="/" className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-[4px] border border-zinc-800 bg-zinc-900">
          <Zap className="h-3.5 w-3.5 text-zinc-300" />
        </span>
        <span className="text-zinc-300">DropLink</span>
      </Link>
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
    </header>
  );
}