import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { profileRelPath, getMissingSections, repairProfile, assembleProfile, parseProfileSections, getDataDir, type ProfileSections } from "kxta-core";
import { checkAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dataDir = getDataDir();
    const profilePath = join(dataDir, profileRelPath());

    if (!existsSync(profilePath)) {
      return NextResponse.json({ exists: false, content: null, missing_sections: [], sections: null });
    }

    const content = readFileSync(profilePath, "utf8");
    const missing = getMissingSections(content);
    const sections = parseProfileSections(content);

    return NextResponse.json({
      exists: true,
      content,
      missing_sections: missing,
      sections,
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

    if (body.sections && typeof body.sections === "object") {
      const s = body.sections as Partial<ProfileSections>;
      let base: ProfileSections = {
        name: "",
        role: "",
        vision: "",
        roadmap: "",
        preferences: "",
        sessionCodingStyle: "",
        teamMembersAndRoles: "",
        notes: "",
      };
      if (existsSync(profilePath)) {
        try {
          const existingContent = readFileSync(profilePath, "utf8");
          base = parseProfileSections(existingContent);
        } catch {
          // ignore corrupted or unreadable profile, base defaults to empty
        }
      }

      content = assembleProfile({
        name: typeof s.name === "string" ? s.name : base.name,
        role: typeof s.role === "string" ? s.role : base.role,
        vision: typeof s.vision === "string" ? s.vision : base.vision,
        roadmap: typeof s.roadmap === "string" ? s.roadmap : base.roadmap,
        preferences: typeof s.preferences === "string" ? s.preferences : base.preferences,
        sessionCodingStyle: typeof s.sessionCodingStyle === "string" ? s.sessionCodingStyle : base.sessionCodingStyle,
        teamMembersAndRoles: typeof s.teamMembersAndRoles === "string" ? s.teamMembersAndRoles : base.teamMembersAndRoles,
        notes: typeof s.notes === "string" ? s.notes : base.notes,
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
      sections: parseProfileSections(content),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to save profile" },
      { status: 500 }
    );
  }
}
