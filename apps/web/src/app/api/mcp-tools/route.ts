import { NextResponse } from "next/server";
import manifest from "@/lib/mcp-tools.json";
import { TOOL_CATEGORIES, CATEGORY_ORDER } from "@/lib/mcp-tool-categories";

export async function GET() {
  const tools = manifest.tools.map((t: any) => ({
    ...t,
    category: TOOL_CATEGORIES[t.name] ?? "Discovery",
  }));
  return NextResponse.json({
    generatedAt: manifest.generatedAt,
    categoryOrder: CATEGORY_ORDER,
    tools,
  });
}
