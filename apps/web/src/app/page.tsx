import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkAuth } from "@/lib/auth";
import { getSetting } from "kxta-core";
import HomePageClient from "./home-client";
import { ensureDbInitialized } from "@/lib/db-init";

export const dynamic = "force-dynamic";

export default async function Page() {
  ensureDbInitialized();

  // If no master password is configured yet, send to /login for setup.
  let passwordHash: string | null = null;
  try {
    passwordHash = getSetting("auth_password_hash");
  } catch {
    // Settings table not ready — redirect to login which will handle setup.
    redirect("/login");
  }

  if (!passwordHash) {
    redirect("/login");
  }

  // Password is configured — now enforce authentication.
  const reqHeaders = await headers();
  const reqCookies = await cookies();
  
  const req = {
    headers: reqHeaders,
    cookies: reqCookies
  };

  if (!checkAuth(req)) {
    redirect("/login");
  }

  return <HomePageClient />;
}
