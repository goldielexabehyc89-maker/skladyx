import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// Возвращает id текущей сборки (Next пишет его в .next/BUILD_ID при каждом build).
// Клиент сравнивает со своим и при расхождении тихо обновляется.
let cached: string | null = null;
function buildId(): string {
  if (cached) return cached;
  try {
    cached = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    cached = "dev";
  }
  return cached;
}

export function GET() {
  return NextResponse.json(
    { v: buildId() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
