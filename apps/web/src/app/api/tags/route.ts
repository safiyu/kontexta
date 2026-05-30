import { NextResponse } from "next/server";
import { listTags } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

export async function GET() {
  ensureDbInitialized();
  const tags = listTags();
  return NextResponse.json(tags);
}
