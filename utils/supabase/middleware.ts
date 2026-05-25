import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseKey, supabaseUrl } from "./env";

export const updateSession = async (request: NextRequest) => {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  
  const pathname = request.nextUrl.pathname;

  // if (!user && request.nextUrl.pathname.startsWith("/editor")) {
  //   const url = request.nextUrl.clone();
  //   url.pathname = "/login";
  //   url.searchParams.set("redirectedFrom", request.nextUrl.pathname);
  //   return NextResponse.redirect(url);
  // }

  if (user && pathname.endsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace("/login", "/editor");

    return NextResponse.redirect(url);
  }

  return supabaseResponse;
};
