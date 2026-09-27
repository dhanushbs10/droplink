import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  const rawNext = searchParams.get("next") ?? "/";
  // Only same-site absolute paths are allowed; protocol-relative or absolute
  // URLs would turn this into an open redirect.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//")
    ? rawNext
    : "/";

  // Surface OAuth failures instead of silently bouncing to the home page.
  if (error) {
    const message = errorDescription
      ? `${error}: ${errorDescription}`
      : error;
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(message)}`);
  }

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (!exchangeError) {
      // Always redirect to a host we control. Previously this trusted the
      // X-Forwarded-Host header, which let an attacker send a freshly
      // authenticated user to an arbitrary origin.
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}${next}`);
}
