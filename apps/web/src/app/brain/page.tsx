import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkAuth } from "@/lib/auth";
import { getSetting } from "kxta-core";
import { BrainClient } from "./brain-client";
import { ensureDbInitialized } from "@/lib/db-init";

export const dynamic = "force-dynamic";

export default async function BrainPage() {
  ensureDbInitialized();

  let passwordHash: string | null = null;
  try {
    passwordHash = getSetting("auth_password_hash");
  } catch {
    redirect("/login");
  }
  if (!passwordHash) redirect("/login");

  const req = { headers: await headers(), cookies: await cookies() };
  if (!checkAuth(req)) redirect("/login");

  return <BrainClient />;
}
