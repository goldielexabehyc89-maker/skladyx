// Пакет 11: fail-closed guard старого интерфейса. При LEGACY_WAREHOUSE_UI_ENABLED=false
// общий серверный guard assertLegacyUiEnabled() должен бросать LEGACY_DISABLED; при включённом
// (или невыставленном → по умолчанию ВКЛ) — не бросать. Так закрыт весь старый mutating-контур
// на сервере, а не только скрыт в навигации.
// Запуск: npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-legacy-guard.ts
/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertLegacyUiEnabled } from "@/lib/auth";

let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

// Контракт: в КАЖДОМ старом mutating-action guard assertLegacyUiEnabled() вызывается ДО любой
// доменной DB-мутации ($transaction/create/update/delete/upsert/applyLotMovement/moveUnit). Значит,
// при LEGACY_WAREHOUSE_UI_ENABLED=false ни одно действие не доходит до изменения БД (fail-closed).
const MUTATION = /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\.\$transaction\(|applyLotMovement\(|moveUnit\(/;
const LEGACY_ACTION_FILES = [
  "supplier-orders", "picklists", "issues", "writeoffs", "inventory", "scan", "suppliers",
].map((f) => `src/app/actions/${f}.ts`);

function checkFileContract(relPath: string, onlyActions?: string[]) {
  const src = readFileSync(join(process.cwd(), relPath), "utf8");
  // границы функций: по "export async function <name>Action("
  const re = /export async function\s+([A-Za-z0-9_]+Action)\s*\(/g;
  const marks: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) marks.push({ name: m[1], start: m.index });
  if (marks.length === 0) { ok(`${relPath}: найдены action-функции`, false); return; }
  for (let i = 0; i < marks.length; i++) {
    const { name, start } = marks[i];
    if (onlyActions && !onlyActions.includes(name)) continue;
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const body = src.slice(start, end);
    const guardIdx = body.indexOf("assertLegacyUiEnabled(");
    const mut = MUTATION.exec(body);
    const mutIdx = mut ? mut.index : Infinity;
    ok(`${relPath} · ${name}: guard есть`, guardIdx >= 0);
    ok(`${relPath} · ${name}: guard ДО первой DB-мутации`, guardIdx >= 0 && guardIdx < mutIdx, mut ? `мутация: ${mut[0]}` : "");
  }
}

function throwsLegacyDisabled(): boolean {
  try {
    assertLegacyUiEnabled();
    return false;
  } catch (e) {
    return e instanceof Error && e.message === "LEGACY_DISABLED";
  }
}

async function main() {
  // 1) выключен — guard закрыт
  process.env.LEGACY_WAREHOUSE_UI_ENABLED = "false";
  ok("LEGACY_WAREHOUSE_UI_ENABLED=false → assertLegacyUiEnabled бросает LEGACY_DISABLED", throwsLegacyDisabled());

  // 2) явно включён — guard пропускает
  process.env.LEGACY_WAREHOUSE_UI_ENABLED = "true";
  ok("LEGACY_WAREHOUSE_UI_ENABLED=true → не бросает", !throwsLegacyDisabled());

  // 3) не выставлен — по умолчанию ВКЛ (обратная совместимость), не бросает
  delete process.env.LEGACY_WAREHOUSE_UI_ENABLED;
  ok("переменная не выставлена → по умолчанию не бросает", !throwsLegacyDisabled());

  // 4) контракт всех перечисленных legacy-actions (статический анализ источника)
  console.log("контракт legacy-actions: guard до DB-мутации в каждом действии");
  for (const f of LEGACY_ACTION_FILES) checkFileContract(f);
  // regenerateBadgeAction (EMPLOYEE QR) в users.ts — тоже legacy-mutating
  checkFileContract("src/app/actions/users.ts", ["regenerateBadgeAction"]);

  console.log(failures === 0 ? "\nLEGACY GUARD OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
