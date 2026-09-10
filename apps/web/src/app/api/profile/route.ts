import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { profileRelPath, getMissingSections, repairProfile, assembleProfile, getDataDir } from "kxta-core";
import { checkAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dataDir = getDataDir();
    const profilePath = join(dataDir, profileRelPath());

    if (!existsSync(profilePath)) {
      return NextResponse.json({ exists: false, content: null, missing_sections: [] });
    }

    const content = readFileSync(profilePath, "utf8");
    const missing = getMissingSections(content);

    return NextResponse.json({
      exists: true,
      content,
      missing_sections: missing,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to read profile" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dataDir = getDataDir();
    const profilePath = join(dataDir, profileRelPath());

    // Ensure the knowledge directory exists
    const knowledgeDir = join(dataDir, "knowledge");
    if (!existsSync(knowledgeDir)) {
      mkdirSync(knowledgeDir, { recursive: true });
    }

    const body = await request.json();
    let content: string;

    if (body.sections) {
      // Sections form is all-or-nothing — reject partial payloads so a targeted update never silently wipes the fields it didn't send.
      const REQUIRED_SECTIONS = ["name", "role", "vision", "roadmap", "preferences", "sessionCodingStyle", "teamMembersAndRoles", "notes"] as const;
      const s = body.sections as Partial<Record<typeof REQUIRED_SECTIONS[number], string>>;
      const missing = REQUIRED_SECTIONS.filter((k) => typeof s[k] !== "string");
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `sections is missing required fields: ${missing.join(", ")}. Send all eight, or use 'content' for a raw update.` },
          { status: 400 }
        );
      }
      content = assembleProfile({
        name: s.name!,
        role: s.role!,
        vision: s.vision!,
        roadmap: s.roadmap!,
        preferences: s.preferences!,
        sessionCodingStyle: s.sessionCodingStyle!,
        teamMembersAndRoles: s.teamMembersAndRoles!,
        notes: s.notes!,
      });
    } else if (body.content) {
      // Raw content
      content = body.content;
    } else {
      return NextResponse.json(
        { error: "Request body must contain either 'sections' or 'content'" },
        { status: 400 }
      );
    }

    // Auto-repair: insert missing required sections
    const { content: repairedContent, repaired } = repairProfile(content);
    content = repairedContent;

    // Write the file
    writeFileSync(profilePath, content, "utf8");

    return NextResponse.json({
      success: true,
      repaired,
      content,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to save profile" },
      { status: 500 }
    );
  }
}
