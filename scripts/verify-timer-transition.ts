// TASK-008: живой переход таймера «До активации» → «Ожидает назначения» без reload и без активного
// погрузчика; чистый render (нет React/hydration/console errors); таймер не делает DB-мутаций.
// Требует запущенный сервер (next start). Запуск:
//   VERIFY_HOST=rostagro.skladyx.ru APP_PORT=3000 CHROME_BIN=... npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-timer-transition.ts
/* eslint-disable no-console */
process.env.WORKFLOW_TASKS_ENABLED = "true";

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient, type Role } from "@prisma/client";
import { createWorkflowTask } from "@/lib/workflow-tasks";
import { createSessionToken } from "@/lib/jwt";

const prisma = new PrismaClient();
const HOST = process.env.VERIFY_HOST || "rostagro.skladyx.ru";
const PORT = Number(process.env.APP_PORT || 3000);
const CDP = Number(process.env.CDP_PORT || 9477);
const CHROME = process.env.CHROME_BIN
  || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => existsSync(p))
  || "google-chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const p = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  const consoleErrors: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && p.has(m.id)) { const h = p.get(m.id)!; p.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); }
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") consoleErrors.push((m.params.args || []).map((a: { value?: unknown; description?: string }) => a.description ?? a.value ?? "").join(" "));
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "exception");
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((res, rej) => { const i = ++id; p.set(i, { res: res as (v: unknown) => void, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, opened: new Promise<void>((r) => (ws.onopen = () => r())), consoleErrors };
}

async function main() {
  const slug = process.env.SEED_COMPANY_SLUG || "rostagro";
  const company = await prisma.company.findFirstOrThrow({ where: { slug } });
  const admin = await prisma.user.findFirstOrThrow({ where: { companyId: company.id, role: "ADMIN", isActive: true }, include: { userRoles: { select: { role: true } } } });
  const adminToken = await createSessionToken({ userId: admin.id, login: admin.phone ?? admin.email ?? "", name: admin.name, role: "ADMIN", roles: admin.userRoles.map((r) => r.role), companyId: company.id });

  // Склад БЕЗ активного погрузчика — планировщик не сможет назначить, задача останется QUEUED.
  const wh = await prisma.warehouse.create({ data: { companyId: company.id, name: `TMR-${Date.now()}`, isActive: true } });

  const profile = mkdtempSync(join(tmpdir(), "tmr-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, "--no-first-run", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "about:blank"], { stdio: "ignore" });
  const cleanup = async () => {
    try { chrome.kill(); } catch { /* ignore */ }
    await prisma.workflowTask.deleteMany({ where: { warehouseId: wh.id } });
    await prisma.event.deleteMany({ where: { companyId: company.id, type: "task_assigned", body: { startsWith: "TMR live " } } });
    await prisma.warehouse.deleteMany({ where: { id: wh.id } });
    await prisma.$disconnect();
  };

  try {
    let v: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 40 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { await sleep(500); } }
    if (!v) throw new Error("Chrome CDP не поднялся");
    const br = connect(v.webSocketDebuggerUrl); await br.opened;
    const { targetId } = await br.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
    const page = connect(list.find((t) => t.id === targetId)!.webSocketDebuggerUrl); await page.opened;
    await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
    await page.send("Network.setCookie", { name: "skx_session", value: adminToken, domain: HOST, path: "/", httpOnly: true, secure: false, sameSite: "Lax" });
    const ev = async (expr: string) => { const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }) as { result: { value: unknown } }; return r.result.value; };

    // Создаём задачу с ближайшим сроком (сейчас + 6с), затем сразу открываем монитор.
    const title = `TMR live ${Date.now()}`;
    const { task } = await createWorkflowTask({ companyId: company.id, warehouseId: wh.id, type: "RETRIEVE_COOLING", requiredRole: "LOADER" as Role, priority: "URGENT", title, dedupeKey: `tmr-${Date.now()}`, subjectId: `tmr-subj-${Date.now()}`, availableAt: new Date(Date.now() + 6_000) });

    await page.send("Page.navigate", { url: `http://${HOST}:${PORT}/warehouse/tasks?view=monitor` });
    for (let i = 0; i < 60; i++) { if (await ev(`document.readyState==="complete" && document.body.innerText.includes(${JSON.stringify(title)})`)) break; await sleep(200); }

    // Находим таймер именно нашей строки: от каждого [role=timer] поднимаемся к БЛИЖАЙШЕЙ карточке-строке
    // (класс rounded-xl) и проверяем, что её текст содержит наш заголовок (а не общий контейнер списка).
    const timerFor = async () => ev(`(()=>{for(const tm of document.querySelectorAll('[role=timer]')){let el=tm.parentElement;while(el&&!(el.className&&String(el.className).includes('rounded-xl')))el=el.parentElement;if(el&&el.textContent.includes(${JSON.stringify(title)}))return tm.innerText.replace(/\\s+/g,' ').trim();}return"";})()`) as Promise<string>;

    ok("монитор открыт под ADMIN (задача видна)", (await ev(`document.body.innerText.includes(${JSON.stringify(title)})`)) === true);
    const first = await timerFor();
    ok("сначала обратный отсчёт «До активации»", first.startsWith("До активации"), first);

    // Ждём пересечения нуля БЕЗ reload (клиентский таймер сам переходит; активного погрузчика нет).
    let after = "";
    for (let i = 0; i < 20; i++) { await sleep(1000); after = await timerFor(); if (after.startsWith("Ожидает назначения")) break; }
    ok("живой переход → «Ожидает назначения» без reload", after.startsWith("Ожидает назначения"), after);
    ok("нет отрицательных значений в таймере", !after.includes("-"), after);

    // Таймер не выполнил DB-мутаций: задача осталась QUEUED без исполнителя (погрузчика нет).
    const r = await prisma.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
    ok("таймер не мутировал БД: задача QUEUED без исполнителя", r.status === "QUEUED" && r.assignedUserId === null, `${r.status}/${r.assignedUserId}`);
    ok("нет события task_assigned (назначения не было)", (await prisma.event.count({ where: { companyId: company.id, type: "task_assigned", body: title } })) === 0);

    // Никаких React/hydration/console-ошибок за время наблюдения.
    const errs = [...br.consoleErrors, ...page.consoleErrors].filter((s) => !/favicon/i.test(s));
    ok("нет React/hydration/console ошибок", errs.length === 0, errs.slice(0, 2).join(" | "));

    console.log(failures === 0 ? "\nTIMER-TRANSITION OK ✓" : `\nПРОВАЛЕНО: ${failures}`);
  } finally {
    await cleanup();
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
