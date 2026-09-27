"use client";

import { useEffect, useState } from "react";
import { KeyRound, X, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSupabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type AuthMode = "signin" | "signup";

const INPUT_CLASS =
  "h-10 w-full rounded-[4px] border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600/60";

function AuthError({ message }: { message: string }) {
  return (
    <p className="w-full rounded-[4px] border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
      {message}
    </p>
  );
}

function AuthNotice({ message }: { message: string }) {
  return (
    <p className="w-full rounded-[4px] border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
      {message}
    </p>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export function AuthDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return <AuthDialogContent onClose={onClose} />;
}

function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const clean = local.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return clean.length > 0 ? clean : "user";
}

function AuthDialogContent({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setConfirmPassword("");
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const supabase = getSupabase();
    if (!supabase) {
      setError("Accounts are not configured for this deployment.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    if (mode === "signup" && password.length < 6) {
      setError("Use at least 6 characters for your password.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error: authError } = await supabase.auth.signInWithPassword(
          { email: email.trim(), password }
        );
        if (authError) throw authError;
        reset();
        onClose();
      } else {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { username: usernameFromEmail(email.trim()) },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (authError) throw authError;
        if (data.session) {
          reset();
          onClose();
        } else {
          reset();
          setNotice(
            "Check your inbox to confirm your account. Once confirmed, sign in with your email and password."
          );
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong"
      );
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setEmail("");
    setPassword("");
    setConfirmPassword("");
  };

  const sendMagicLink = async () => {
    setError(null);
    setNotice(null);
    const supabase = getSupabase();
    if (!supabase) {
      setError("Accounts are not configured for this deployment.");
      return;
    }
    const target = email.trim();
    if (!target) {
      setError("Enter your email to use a magic link.");
      return;
    }
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: target,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setNotice(
      "A sign in link has been sent to your email. Use it to open a session."
    );
  };

  const signInWithProvider = async (provider: "github" | "google") => {
    setError(null);
    setNotice(null);
    setOauthLoading(true);
    try {
      const supabase = getSupabase();
      if (!supabase) {
        setError("Accounts are not configured for this deployment.");
        return;
      }
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (oauthError) setError(oauthError.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start sign in");
    } finally {
      setOauthLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="DropLink account"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-5 backdrop-blur-sm"
    >
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative flex w-full max-w-sm flex-col rounded-[6px] border border-zinc-800 bg-zinc-950 p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-zinc-800 bg-zinc-900">
              <Zap className="h-4 w-4 text-zinc-300" />
            </span>
            <div className="flex flex-col">
              <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-200">
                DropLink
              </span>
              <span className="mt-0.5 text-xs text-zinc-600">
                Secure peer-to-peer transfer
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account dialog"
            className="flex h-8 w-8 items-center justify-center rounded-[4px] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-5 text-sm text-zinc-400">
          Sign in to save buddies and reconnect to them in one click, without
          generating a new room code.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-1 rounded-[4px] border border-zinc-800 p-1">
          {(
            [
              { id: "signin", label: "Sign In" },
              { id: "signup", label: "Sign Up" },
            ] as { id: AuthMode; label: string }[]
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => switchMode(entry.id)}
              className={cn(
                "flex h-9 items-center justify-center rounded-[4px] font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
                mode === entry.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-5 flex w-full flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <label
              htmlFor="auth-email"
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500"
            >
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className={INPUT_CLASS}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="auth-password"
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500"
            >
              {mode === "signup" ? "Create password" : "Password"}
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              className={INPUT_CLASS}
            />
          </div>

          {mode === "signup" && (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="auth-confirm"
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500"
              >
                Confirm password
              </label>
              <input
                id="auth-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Repeat your password"
                className={INPUT_CLASS}
              />
            </div>
          )}

          {error && <AuthError message={error} />}
          {notice && <AuthNotice message={notice} />}

          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full rounded-[4px]"
            disabled={
              loading ||
              oauthLoading ||
              !email ||
              (mode === "signup" && !confirmPassword)
            }
          >
            {loading
              ? "One moment..."
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>

        {mode === "signin" && (
          <button
            type="button"
            onClick={() => void sendMagicLink()}
            className="mt-1 flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Use a magic link instead
          </button>
        )}

        <div className="mt-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-zinc-800" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            or continue with
          </span>
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void signInWithProvider("github")}
            disabled={loading || oauthLoading}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-950 font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GithubMark className="h-4 w-4" />
            Sign in with GitHub
          </button>
          <button
            type="button"
            onClick={() => void signInWithProvider("google")}
            disabled={loading || oauthLoading}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-950 font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GoogleMark className="h-4 w-4" />
            Sign in with Google
          </button>
        </div>

        <div className="mt-6 border-t border-zinc-800 pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            End-to-end encrypted. No server in the data path.
          </p>
        </div>
      </div>
    </div>
  );
}