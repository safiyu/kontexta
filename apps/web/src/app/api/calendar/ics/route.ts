import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { listEvents, listEntities, eventsToIcs } from "kxta-core";
import type { CalendarEntity } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

function ymd(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 8);
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to query params are required" }, { status: 400 });
  }

  const entityIdParam = searchParams.get("entity_id");
  let entity_id: number | undefined;
  if (entityIdParam !== null) {
    const n = Number(entityIdParam);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: `Invalid entity_id: ${entityIdParam}` }, { status: 400 });
    }
    entity_id = n;
  }

  try {
    const events = listEvents({ from, to, entity_id });
    const entitiesById = new Map<number, CalendarEntity>(listEntities({}).map((e) => [e.id, e]));
    const ics = eventsToIcs(events, entitiesById, { calendar_name: "Kontexta Calendar" });

    return new NextResponse(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="kontexta-calendar-${ymd(from)}-${ymd(to)}.ics"`,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Failed to export calendar" }, { status: 400 });
  }
}
