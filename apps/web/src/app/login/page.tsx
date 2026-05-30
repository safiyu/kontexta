import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSetting } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { LoginClient } from "@/app/login/login-client";

export default async function LoginPage() {
  ensureDbInitialized();

  let passwordHash: string | null = null;
  try {
    passwordHash = getSetting("auth_password_hash");
  } catch {
    // Settings table not ready — show setup page.
  }

  // If password is set and user is already authenticated (and not explicitly locked), skip login.
  if (passwordHash) {
    const reqHeaders = await headers();
    const reqCookies = await cookies();
    const req = { headers: reqHeaders, cookies: reqCookies };
    // Only skip login if they are authenticated AND have NOT explicitly locked.
    const isExplicitlyLocked = !!reqCookies.get("kontexta_locked")?.value;
    if (!isExplicitlyLocked && checkAuth(req)) {
      redirect("/");
    }
  }

  const isSetupRequired = !passwordHash;
  return <LoginClient isSetupRequired={isSetupRequired} />;
}
