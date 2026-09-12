import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import manifest from "@/lib/mcp-tools.json";
import { TOOL_CATEGORIES, CATEGORY_ORDER } from "@/lib/mcp-tool-categories";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  // Sort alphabetically by name so the docs page shows tools in a predictable order within each category — declaration order in the MCP source is arbitrary.
  const tools = manifest.tools
    .map((t: any) => ({ ...t, category: TOOL_CATEGORIES[t.name] ?? "Discovery" }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return NextResponse.json({
    generatedAt: manifest.generatedAt,
    categoryOrder: CATEGORY_ORDER,
    tools,
  });
}
