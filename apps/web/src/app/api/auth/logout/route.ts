import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete("kontexta_session");
  // Set a "locked" cookie so the IP bypass is suppressed until the user
  // explicitly re-authenticates via the login form.
  response.cookies.set("kontexta_locked", "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // No maxAge — this is a session cookie, cleared on browser close or login.
  });
  return response;
}
