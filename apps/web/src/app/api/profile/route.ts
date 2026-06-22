import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { profileRelPath, getMissingSections, repairProfile, assembleProfile, getDataDir } from "kxta-core";

export async function GET() {
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
      // Sections form: { name, role, vision, roadmap, preferences, notes }
      content = assembleProfile(body.sections);
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
