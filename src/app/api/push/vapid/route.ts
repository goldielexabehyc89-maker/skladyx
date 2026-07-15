import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { key: process.env.VAPID_PUBLIC || null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
