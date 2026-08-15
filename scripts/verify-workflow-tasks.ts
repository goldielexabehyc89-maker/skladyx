// Проверка Этапа 5/Пакет 2 (очередь задач). Движок тестируется напрямую (tsx + prisma),
// endWorkShiftAction — через HTTP (node:http). Только dev-БД; тест-данные удаляются в finally.
// Запуск: VERIFY_BASE=http://localhost:3021 npx tsx --tsconfig scripts/tsconfig.verify.json scripts/verify-workflow-tasks.ts
/* eslint-disable no-console */
import http from "node:http";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  createWorkflowTask,
  rebalanceQueuedTasks,
  startWorkflowTask,
  completeWorkflowTask,
  cancelWorkflowTask,
  requestTaskHandoff,
  acceptTaskHandoff,
  rejectTaskHandoff,
} from "@/lib/workflow-tasks";

const BASE = new URL(process.env.VERIFY_BASE || "http://localhost:3000");
const PASS = "p2-verify-pass-01";
const prisma = new PrismaClient();
let failures = 0;
const ok = (n: string, c: boolean, e = "") => (c ? console.log(`  ✓ ${n}`) : (failures++, console.error(`  ✗ ${n} ${e}`)));

let companyId = "", demoId = "", W1 = "", W2 = "", DW = "";
const UIDS: string[] = [];
let seq = 0;
const dk = (s: string) => `p2:${s}`;

async function mkUser(id: string, cid: string, phone: string, role: Role, wh: string): Promise<string> {
  await prisma.user.deleteMany({ where: { id } });
  const u = await prisma.user.create({
    data: {
      id, companyId: cid, phone, name: id, role, isActive: true, allWarehouses: false,
      passwordHash: await bcrypt.hash(PASS, 10),
      userRoles: { create: { role } },
      warehouseLinks: { create: { warehouseId: wh } },
    },
  });
  UIDS.push(id);
  return u.id;
}
async function mkShift(userId: string, cid: string, wh: string, role: Role, startedAt?: Date) {
  return prisma.workShift.create({ data: { companyId: cid, userId, warehouseId: wh, role, ...(startedAt ? { startedAt } : {}) } });
}
async function task(wh: string, role: Role, opts: { type?: string; priority?: "NORMAL" | "URGENT"; loadUnits?: number; dependsOn?: string[]; key?: string } = {}) {
  const type = opts.type ?? (role === "LOADER" ? "PLACE_GROUP" : role === "PICKER" ? "PICK_ORDER" : role === "CONTROLLER" ? "CONTROL_ORDER" : "RECEIVE_GROUP");
  const { task, created } = await createWorkflowTask({
    companyId, warehouseId: wh, type, requiredRole: role, priority: opts.priority ?? "NORMAL",
    title: `T${++seq}`, dedupeKey: opts.key ?? dk(`t${seq}`), loadUnits: opts.loadUnits ?? 1, dependsOn: opts.dependsOn,
  });
  return { task, created };
}
const assignee = async (id: string) => (await prisma.workflowTask.findUnique({ where: { id } }))?.assignedUserId ?? null;
const statusOf = async (id: string) => (await prisma.workflowTask.findUnique({ where: { id } }))?.status ?? null;
const TASK_EVENT_TYPES = [
  "task_created", "task_assigned", "task_started", "task_completed", "task_cancelled",
  "task_returned", "task_unblocked", "task_needs_attention", "task_skipped",
  "task_handoff_requested", "task_handoff_accepted", "task_handoff_rejected",
];
async function resetTasks() {
  await prisma.taskHandoff.deleteMany({ where: { task: { companyId: { in: [companyId, demoId].filter(Boolean) } } } });
  await prisma.taskDependency.deleteMany({ where: { task: { companyId: { in: [companyId, demoId].filter(Boolean) } } } });
  await prisma.workflowTask.deleteMany({ where: { companyId: { in: [companyId, demoId].filter(Boolean) } } });
}
async function resetTaskEvents() {
  await prisma.event.deleteMany({ where: { companyId: { in: [companyId, demoId].filter(Boolean) }, type: { in: TASK_EVENT_TYPES } } });
}

// ── HTTP (endWorkShiftAction) ──
function req(method: string, path: string, opts: { cookie?: string; body?: Buffer; contentType?: string } = {}): Promise<{ status: number; body: string; cookie: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = { Host: BASE.host };
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (opts.body) { headers["Content-Type"] = opts.contentType!; headers["Content-Length"] = opts.body.length; }
    const r = http.request({ hostname: BASE.hostname, port: BASE.port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let cookie = ""; for (const c of res.headers["set-cookie"] ?? []) { const [p] = c.split(";"); if (p.startsWith("skx_session=")) cookie = p; } resolve({ status: res.statusCode ?? 0, body: d, cookie }); });
    });
    r.on("error", () => resolve({ status: 0, body: "", cookie: "" }));
    if (opts.body) r.write(opts.body); r.end();
  });
}
function actionInputs(html: string, marker: string) {
  const form = html.match(/<form[\s\S]*?<\/form>/g)?.find((f) => f.includes(marker)) ?? "";
  const f: [string, string][] = [];
  for (const t of form.match(/<input[^>]*>/g) ?? []) {
    const n = /name="([^"]*)"/.exec(t)?.[1]; if (!n || !n.startsWith("$ACTION")) continue;
    const v = (/value="([^"]*)"/.exec(t)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    f.push([n, v]);
  }
  return f;
}
function mp(fields: [string, string][]) { const b = "----p2b"; let s = ""; for (const [k, v] of fields) s += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`; s += `--${b}--\r\n`; return { body: Buffer.from(s), contentType: `multipart/form-data; boundary=${b}` }; }
async function login(phone: string): Promise<string> {
  const page = await req("GET", "/login");
  const fields = actionInputs(page.body, 'name="login"'); fields.push(["login", phone], ["password", PASS]);
  const m = mp(fields);
  return (await req("POST", "/login", { body: m.body, contentType: m.contentType })).cookie;
}
async function endShiftHttp(cookie: string): Promise<number> {
  const page = await req("GET", "/warehouse/shift", { cookie });
  const fields = actionInputs(page.body, "Завершить"); // изолируем форму завершения (на странице ещё logout)
  const form = page.body.match(/<form[\s\S]*?<\/form>/g)?.find((f) => f.includes("Завершить")) ?? "";
  const acts: [string, string][] = [];
  for (const t of form.match(/<input[^>]*>/g) ?? []) { const n = /name="([^"]*)"/.exec(t)?.[1]; if (n?.startsWith("$ACTION")) acts.push([n, (/value="([^"]*)"/.exec(t)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")]); }
  void fields;
  const m = mp(acts);
  return (await req("POST", "/warehouse/shift", { cookie, body: m.body, contentType: m.contentType })).status;
}

async function provision() {
  const c = await prisma.company.findFirstOrThrow({ where: { slug: "rostagro" } });
  companyId = c.id;
  W1 = (await prisma.warehouse.create({ data: { companyId, name: "P2 W1", isActive: true } })).id;
  W2 = (await prisma.warehouse.create({ data: { companyId, name: "P2 W2", isActive: true } })).id;
  const demo = await prisma.company.upsert({ where: { slug: "demo" }, update: {}, create: { name: "Demo", slug: "demo", settings: {} } });
  demoId = demo.id;
  DW = (await prisma.warehouse.create({ data: { companyId: demoId, name: "P2 DW", isActive: true } })).id;
  await resetTaskEvents(); // старые task-события прошлых прогонов не должны давать ложных срабатываний в блоке 14
}
async function cleanup() {
  await resetTasks();
  await resetTaskEvents();
  await prisma.workShift.deleteMany({ where: { companyId: { in: [companyId, demoId].filter(Boolean) }, warehouseId: { in: [W1, W2, DW].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: UIDS } } });
  if (demoId) { await prisma.user.deleteMany({ where: { companyId: demoId } }); await prisma.warehouse.deleteMany({ where: { companyId: demoId } }); await prisma.company.deleteMany({ where: { id: demoId } }); }
  await prisma.warehouse.deleteMany({ where: { id: { in: [W1, W2].filter(Boolean) } } });
}

async function main() {
  console.log(`P2 verify — ${BASE.href}`);
  await provision();

  console.log("1) идемпотентность dedupeKey");
  const a1 = await task(W1, "LOADER", { key: dk("idem") });
  const a2 = await task(W1, "LOADER", { key: dk("idem") });
  ok("повторное создание не дублирует", a1.created && !a2.created && a1.task.id === a2.task.id);

  console.log("2) LOADER: назначение по числу активных задач (наименьшее), tie → ранняя смена");
  await resetTasks();
  const lA = await mkUser("p2_lA", companyId, "+79997001001", "LOADER", W1);
  await new Promise((r) => setTimeout(r, 10));
  const lB = await mkUser("p2_lB", companyId, "+79997001002", "LOADER", W1);
  await mkShift(lA, companyId, W1, "LOADER", new Date(Date.now() - 60000)); // раньше
  await mkShift(lB, companyId, W1, "LOADER", new Date());
  const t1 = (await task(W1, "LOADER")).task; // → lA (0,0 tie → ранняя)
  const t2 = (await task(W1, "LOADER")).task; // A:1,B:0 → lB
  const t3 = (await task(W1, "LOADER")).task; // A:1,B:1 tie → lA (ранняя)
  ok("t1 → lA", (await assignee(t1.id)) === lA, `got ${await assignee(t1.id)}`);
  ok("t2 → lB (балансировка)", (await assignee(t2.id)) === lB, `got ${await assignee(t2.id)}`);
  ok("t3 → lA (tie: ранняя смена)", (await assignee(t3.id)) === lA, `got ${await assignee(t3.id)}`);

  console.log("3) PICKER: назначение по сумме loadUnits");
  await resetTasks();
  const pA = await mkUser("p2_pA", companyId, "+79997001003", "PICKER", W1);
  await new Promise((r) => setTimeout(r, 10));
  const pB = await mkUser("p2_pB", companyId, "+79997001004", "PICKER", W1);
  await mkShift(pA, companyId, W1, "PICKER", new Date(Date.now() - 60000));
  await mkShift(pB, companyId, W1, "PICKER", new Date());
  const p1 = (await task(W1, "PICKER", { loadUnits: 5 })).task; // → pA (0)
  const p2 = (await task(W1, "PICKER", { loadUnits: 2 })).task; // A:5,B:0 → pB
  const p3 = (await task(W1, "PICKER", { loadUnits: 1 })).task; // A:5,B:2 → pB
  ok("p1 → pA", (await assignee(p1.id)) === pA);
  ok("p2 → pB (сумма loadUnits)", (await assignee(p2.id)) === pB);
  ok("p3 → pB (5 vs 2 → меньший)", (await assignee(p3.id)) === pB, `got ${await assignee(p3.id)}`);

  console.log("4) tenant/warehouse/role isolation");
  await resetTasks();
  const wrongWh = (await task(W2, "LOADER")).task; // нет смены LOADER на W2 → QUEUED
  ok("нет смены на складе → QUEUED", (await statusOf(wrongWh.id)) === "QUEUED");
  const wrongRole = (await task(W1, "PICKER")).task; // на W1 есть PICKER-смены (pA/pB) — назначится; проверим что LOADER-задача не идёт пикеру
  const loaderTask = (await task(W1, "LOADER")).task;
  ok("LOADER-задача не назначена PICKER-смене", [pA, pB].indexOf((await assignee(loaderTask.id)) ?? "") === -1);
  void wrongRole;
  // demo-изоляция: demo-смена не получает rostagro-задачи
  const dU = await mkUser("p2_dU", demoId, "+79997009001", "LOADER", DW);
  await mkShift(dU, demoId, DW, "LOADER");
  await rebalanceQueuedTasks(companyId);
  ok("demo-смена не получила rostagro-задачу", (await prisma.workflowTask.count({ where: { assignedUserId: dU } })) === 0);

  console.log("5) конкурентное создание (один dedupeKey) и двойной старт");
  await resetTasks();
  const rboth = await Promise.all([task(W1, "LOADER", { key: dk("conc") }), task(W1, "LOADER", { key: dk("conc") })]);
  ok("конкурентное создание → одна задача", rboth.filter((r) => r.created).length === 1 && rboth[0].task.id === rboth[1].task.id);
  const startTask = rboth[0].task; // назначен lA или lB
  const owner = (await assignee(startTask.id))!;
  const st = await Promise.all([startWorkflowTask(owner, companyId, startTask.id), startWorkflowTask(owner, companyId, startTask.id)]);
  ok("двойной старт → ровно один IN_PROGRESS", (await statusOf(startTask.id)) === "IN_PROGRESS" && st.filter((r) => !r.error).length === 1, JSON.stringify(st));

  console.log("6) urgent раньше normal; пропуск urgent только с причиной; не прерывает IN_PROGRESS");
  await resetTasks();
  // один LOADER (lA) со сменой; уберём lB-смену чтобы всё шло lA
  await prisma.workShift.updateMany({ where: { userId: lB, endedAt: null }, data: { endedAt: new Date() } });
  const norm = (await task(W1, "LOADER", { priority: "NORMAL" })).task;
  const urg = (await task(W1, "LOADER", { priority: "URGENT" })).task;
  ok("оба назначены lA", (await assignee(norm.id)) === lA && (await assignee(urg.id)) === lA);
  const skipNoReason = await startWorkflowTask(lA, companyId, norm.id);
  ok("старт normal при доступной urgent без причины — отказ", !!skipNoReason.error);
  const skipReason = await startWorkflowTask(lA, companyId, norm.id, "жду место");
  ok("старт normal с причиной пропуска — ок", !skipReason.error && (await statusOf(norm.id)) === "IN_PROGRESS");
  const skipEvent = await prisma.event.count({ where: { companyId, type: "task_skipped" } });
  ok("причина пропуска записана в logEvent", skipEvent >= 1);
  const startWhileBusy = await startWorkflowTask(lA, companyId, urg.id);
  ok("urgent не прерывает IN_PROGRESS (вторую взять нельзя)", !!startWhileBusy.error && (await statusOf(urg.id)) === "ASSIGNED");

  console.log("7) зависимости BLOCKED → QUEUED");
  await resetTasks();
  const dep = (await task(W1, "LOADER")).task;
  const blocked = (await task(W1, "LOADER", { dependsOn: [dep.id] })).task;
  ok("задача с незавершённой зависимостью → BLOCKED", (await statusOf(blocked.id)) === "BLOCKED");
  await completeWorkflowTask(dep.id);
  ok("после выполнения зависимости → QUEUED/ASSIGNED", ["QUEUED", "ASSIGNED"].includes((await statusOf(blocked.id))!));

  console.log("8) передача задачи: запрос + принятие / отклонение");
  await resetTasks();
  await mkShift(lB, companyId, W1, "LOADER"); // вернём lB на смену
  const ht = (await task(W1, "LOADER")).task;
  const htOwner = (await assignee(ht.id))!;
  const other = htOwner === lA ? lB : lA;
  await startWorkflowTask(htOwner, companyId, ht.id);
  const reqOnly = await requestTaskHandoff(companyId, ht.id, htOwner, other);
  ok("запрос передачи → HANDOFF_PENDING (одно подтверждение)", !reqOnly.error && (await statusOf(ht.id)) === "HANDOFF_PENDING");
  const handoff = await prisma.taskHandoff.findFirstOrThrow({ where: { taskId: ht.id, status: "PENDING" } });
  const acc = await acceptTaskHandoff(companyId, handoff.id, other);
  ok("принятие → IN_PROGRESS у нового исполнителя", !acc.error && (await assignee(ht.id)) === other && (await statusOf(ht.id)) === "IN_PROGRESS");
  // reject-путь
  const ht2 = (await task(W1, "LOADER")).task;
  // назначится наименее загруженному; убедимся, что владелец существует
  const o2 = (await assignee(ht2.id))!;
  const other2 = o2 === lA ? lB : lA;
  // other2 сейчас, возможно, занят (принял ht). Освободим: завершим ht.
  await completeWorkflowTask(ht.id);
  await startWorkflowTask(o2, companyId, ht2.id);
  const rq2 = await requestTaskHandoff(companyId, ht2.id, o2, other2);
  ok("повторный запрос передачи ок", !rq2.error);
  const h2 = await prisma.taskHandoff.findFirstOrThrow({ where: { taskId: ht2.id, status: "PENDING" } });
  const rej = await rejectTaskHandoff(companyId, h2.id, other2);
  ok("отклонение → задача снова IN_PROGRESS у исходного", !rej.error && (await assignee(ht2.id)) === o2 && (await statusOf(ht2.id)) === "IN_PROGRESS");

  console.log("8b) передача: негативы и инварианты (P3C-FIX-1)");
  await resetTasks();
  await prisma.workShift.updateMany({ where: { userId: { in: [lA, lB, pA, pB] }, endedAt: null }, data: { endedAt: new Date() } });
  await mkShift(lA, companyId, W1, "LOADER", new Date(Date.now() - 60000));
  await mkShift(lB, companyId, W1, "LOADER", new Date());
  await mkShift(pA, companyId, W1, "PICKER"); // коллега ДРУГОЙ роли на том же складе
  const hA = (await task(W1, "LOADER", { key: dk("ho-a") })).task;
  if ((await assignee(hA.id)) !== lA)
    await prisma.workflowTask.update({ where: { id: hA.id }, data: { assignedUserId: lA, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: lA, endedAt: null } })).id } });
  await startWorkflowTask(lA, companyId, hA.id);
  const hAStarted = (await prisma.workflowTask.findUniqueOrThrow({ where: { id: hA.id } })).startedAt;
  // wrong-role: передать коллеге ДРУГОЙ роли (PICKER pA) — отказ, задача не тронута
  const wrRole = await requestTaskHandoff(companyId, hA.id, lA, pA);
  ok("передача коллеге другой роли отклонена", !!wrRole.error && (await statusOf(hA.id)) === "IN_PROGRESS");
  // wrong-warehouse: получатель на другом складе (W2) — отказ
  const lW2 = await mkUser("p2_lW2", companyId, "+79997009099", "LOADER", W2);
  await mkShift(lW2, companyId, W2, "LOADER");
  const wrWh = await requestTaskHandoff(companyId, hA.id, lA, lW2);
  ok("передача на чужой склад отклонена", !!wrWh.error && (await statusOf(hA.id)) === "IN_PROGRESS");
  // busy: получатель lB занят своей IN_PROGRESS — отказ
  const hB = (await task(W1, "LOADER", { key: dk("ho-b") })).task;
  if ((await assignee(hB.id)) !== lB)
    await prisma.workflowTask.update({ where: { id: hB.id }, data: { assignedUserId: lB, assignedShiftId: (await prisma.workShift.findFirstOrThrow({ where: { userId: lB, endedAt: null } })).id } });
  await startWorkflowTask(lB, companyId, hB.id);
  const busyRej = await requestTaskHandoff(companyId, hA.id, lA, lB);
  ok("передача занятому получателю отклонена", !!busyRej.error && (await statusOf(hA.id)) === "IN_PROGRESS");
  await completeWorkflowTask(hB.id); // освободим lB
  // корректная передача lA→lB
  const okReq = await requestTaskHandoff(companyId, hA.id, lA, lB);
  ok("корректная передача → HANDOFF_PENDING", !okReq.error && (await statusOf(hA.id)) === "HANDOFF_PENDING");
  // duplicate: повторный запрос по той же задаче не создаёт вторую передачу
  const dupReq = await requestTaskHandoff(companyId, hA.id, lA, lB);
  ok("повторный запрос отклонён — ровно одна PENDING-передача", !!dupReq.error && (await prisma.taskHandoff.count({ where: { taskId: hA.id, status: "PENDING" } })) === 1);
  // accept: startedAt сохранён, ровно один активный исполнитель
  const hOff = await prisma.taskHandoff.findFirstOrThrow({ where: { taskId: hA.id, status: "PENDING" } });
  const accOk = await acceptTaskHandoff(companyId, hOff.id, lB);
  const hAfter = await prisma.workflowTask.findUniqueOrThrow({ where: { id: hA.id } });
  ok("принятие: IN_PROGRESS у получателя, startedAt НЕ изменён", !accOk.error && hAfter.status === "IN_PROGRESS" && hAfter.assignedUserId === lB && String(hAfter.startedAt) === String(hAStarted), `started ${hAStarted?.toISOString()} -> ${hAfter.startedAt?.toISOString()}`);
  ok("после передачи ровно один активный исполнитель задачи", (await prisma.workflowTask.count({ where: { id: hA.id, assignedUserId: lB, status: "IN_PROGRESS" } })) === 1);

  console.log("9) push не создаётся движком");
  ok("нет push-подписок у тест-пользователей", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);

  console.log("10) endWorkShiftAction (HTTP): IN_PROGRESS блокирует; ASSIGNED возвращается в очередь");
  await resetTasks();
  // одна LOADER-смена lA (lB завершим), задачи: одна начатая + одна назначенная
  await prisma.workShift.updateMany({ where: { userId: lB, endedAt: null }, data: { endedAt: new Date() } });
  const inProg = (await task(W1, "LOADER")).task;
  await startWorkflowTask(lA, companyId, inProg.id);
  const assignedNotStarted = (await task(W1, "LOADER")).task;
  ok("вторая задача ASSIGNED lA", (await statusOf(assignedNotStarted.id)) === "ASSIGNED" && (await assignee(assignedNotStarted.id)) === lA);
  const ck = await login("+79997001001");
  const endBlocked = await endShiftHttp(ck);
  const stillOpen = await prisma.workShift.count({ where: { userId: lA, endedAt: null } });
  ok("endShift заблокирован при IN_PROGRESS (смена открыта)", stillOpen === 1, `status=${endBlocked}`);
  // завершим задачу → endShift пройдёт, ASSIGNED вернётся в QUEUED
  await completeWorkflowTask(inProg.id);
  await endShiftHttp(ck);
  ok("после завершения задачи смена закрыта", (await prisma.workShift.count({ where: { userId: lA, endedAt: null } })) === 0);
  ok("ASSIGNED-задача возвращена в QUEUED", (await statusOf(assignedNotStarted.id)) === "QUEUED" && (await assignee(assignedNotStarted.id)) === null);

  console.log("11) защита передачи: request → cancel → accept/reject отклонены, задача остаётся CANCELLED");
  await resetTasks();
  await prisma.workShift.updateMany({ where: { userId: { in: [lA, lB] }, endedAt: null }, data: { endedAt: new Date() } });
  await mkShift(lA, companyId, W1, "LOADER");
  await mkShift(lB, companyId, W1, "LOADER");
  const ct = (await task(W1, "LOADER")).task;
  const cOwner = (await assignee(ct.id))!;
  const cOther = cOwner === lA ? lB : lA;
  await startWorkflowTask(cOwner, companyId, ct.id);
  const cReq = await requestTaskHandoff(companyId, ct.id, cOwner, cOther);
  ok("передача запрошена → HANDOFF_PENDING", !cReq.error && (await statusOf(ct.id)) === "HANDOFF_PENDING");
  const cHo = await prisma.taskHandoff.findFirstOrThrow({ where: { taskId: ct.id, status: "PENDING" } });
  await cancelWorkflowTask(ct.id);
  ok("cancel отменил задачу", (await statusOf(ct.id)) === "CANCELLED");
  const cHoAfter = await prisma.taskHandoff.findUniqueOrThrow({ where: { id: cHo.id } });
  ok("cancel перевёл передачу в CANCELLED с respondedAt", cHoAfter.status === "CANCELLED" && !!cHoAfter.respondedAt);
  const accStale = await acceptTaskHandoff(companyId, cHo.id, cOther);
  ok("accept устаревшей передачи отклонён, задача осталась CANCELLED", !!accStale.error && (await statusOf(ct.id)) === "CANCELLED", JSON.stringify(accStale));
  const rejStale = await rejectTaskHandoff(companyId, cHo.id, cOther);
  ok("reject устаревшей передачи отклонён, задача осталась CANCELLED", !!rejStale.error && (await statusOf(ct.id)) === "CANCELLED", JSON.stringify(rejStale));

  console.log("12) tenant-изоляция зависимостей (чужая/несуществующая задача)");
  await resetTasks();
  const demoDep = await createWorkflowTask({
    companyId: demoId, warehouseId: DW, type: "PLACE_GROUP", requiredRole: "LOADER",
    title: "demo dep", dedupeKey: dk("demo-dep"),
  });
  let crossErr = "";
  try {
    await createWorkflowTask({
      companyId, warehouseId: W1, type: "PLACE_GROUP", requiredRole: "LOADER",
      title: "cross", dedupeKey: dk("cross"), dependsOn: [demoDep.task.id],
    });
  } catch (e) { crossErr = (e as Error).message; }
  ok("зависимость от задачи другой организации отклонена", !!crossErr, crossErr);
  ok("cross-задача не создана", (await prisma.workflowTask.count({ where: { companyId, dedupeKey: dk("cross") } })) === 0);
  ok("TaskDependency на чужую задачу не создана", (await prisma.taskDependency.count({ where: { dependsOnTaskId: demoDep.task.id } })) === 0);
  let missErr = "";
  try {
    await createWorkflowTask({
      companyId, warehouseId: W1, type: "PLACE_GROUP", requiredRole: "LOADER",
      title: "miss", dedupeKey: dk("miss"), dependsOn: ["nonexistent_task_id_xyz"],
    });
  } catch (e) { missErr = (e as Error).message; }
  ok("зависимость от несуществующей задачи отклонена, задача не создана", !!missErr && (await prisma.workflowTask.count({ where: { companyId, dedupeKey: dk("miss") } })) === 0);

  console.log("13) ADMIN с рабочей сменой LOADER: задача назначается и может быть начата");
  await resetTasks();
  await prisma.workShift.updateMany({ where: { companyId, warehouseId: W1, role: "LOADER", endedAt: null }, data: { endedAt: new Date() } });
  const adm = await mkUser("p2_admLoader", companyId, "+79997001099", "ADMIN", W1);
  await prisma.userRole.create({ data: { userId: adm, role: "LOADER" } });
  await mkShift(adm, companyId, W1, "LOADER");
  const admTask = (await task(W1, "LOADER")).task;
  ok("задача назначена смене ADMIN+LOADER", (await assignee(admTask.id)) === adm, `got ${await assignee(admTask.id)}`);
  const admStart = await startWorkflowTask(adm, companyId, admTask.id);
  ok("ADMIN может начать назначенную задачу", !admStart.error && (await statusOf(admTask.id)) === "IN_PROGRESS", JSON.stringify(admStart));

  console.log("14) аудит-события задействованы (task_skipped с actorId, task_returned, task_unblocked)");
  const skipEv = await prisma.event.findFirst({ where: { companyId, type: "task_skipped" }, orderBy: { createdAt: "desc" } });
  ok("task_skipped записан с actorId сотрудника", !!skipEv && !!skipEv.actorId, `actorId=${skipEv?.actorId ?? "—"}`);
  ok("task_returned записан (возврат при завершении смены)", (await prisma.event.count({ where: { companyId, type: "task_returned" } })) >= 1);
  ok("task_unblocked записан (разблокировка зависимости)", (await prisma.event.count({ where: { companyId, type: "task_unblocked" } })) >= 1);
  ok("push движком не создаётся (аудит только Event+realtime)", (await prisma.pushSubscription.count({ where: { userId: { in: UIDS } } })) === 0);

  // ── P3A: многопользовательское распределение (TASK-001/002, SHIFT-002) ──
  const closeW1 = () => prisma.workShift.updateMany({ where: { companyId, warehouseId: W1, endedAt: null }, data: { endedAt: new Date() } });

  console.log("15) CONTROLLER: два контролёра на смене, нагрузка = сумма loadUnits, tie → ранняя смена");
  await resetTasks(); await closeW1();
  const cA = await mkUser("p3_cA", companyId, "+79997001010", "CONTROLLER", W1);
  await new Promise((r) => setTimeout(r, 10));
  const cB = await mkUser("p3_cB", companyId, "+79997001011", "CONTROLLER", W1);
  await mkShift(cA, companyId, W1, "CONTROLLER", new Date(Date.now() - 60000));
  await mkShift(cB, companyId, W1, "CONTROLLER", new Date());
  const c1 = (await task(W1, "CONTROLLER", { loadUnits: 5 })).task; // оба 0 → tie → ранняя (cA)
  const c2 = (await task(W1, "CONTROLLER", { loadUnits: 2 })).task; // A:5,B:0 → cB
  const c3 = (await task(W1, "CONTROLLER", { loadUnits: 1 })).task; // A:5,B:2 → cB
  ok("c1 → cA (tie: ранняя смена)", (await assignee(c1.id)) === cA, `got ${await assignee(c1.id)}`);
  ok("c2 → cB (нагрузка Σ loadUnits)", (await assignee(c2.id)) === cB, `got ${await assignee(c2.id)}`);
  ok("c3 → cB (5 vs 2 → меньший)", (await assignee(c3.id)) === cB, `got ${await assignee(c3.id)}`);

  console.log("16) равные load + равный startedAt → tiebreaker userId ASC");
  await resetTasks(); await closeW1();
  const sameStart = new Date(Date.now() - 30000);
  const uA = await mkUser("p3_uA", companyId, "+79997001012", "LOADER", W1); // "p3_uA" < "p3_uB"
  const uB = await mkUser("p3_uB", companyId, "+79997001013", "LOADER", W1);
  await mkShift(uA, companyId, W1, "LOADER", sameStart);
  await mkShift(uB, companyId, W1, "LOADER", sameStart); // тот же startedAt
  const tieTask = (await task(W1, "LOADER")).task;
  ok("равные нагрузка и старт смены → меньший userId (uA)", (await assignee(tieTask.id)) === uA, `got ${await assignee(tieTask.id)}`);

  console.log("17) сотрудник с IN_PROGRESS НЕ исключается из кандидатов, но его нагрузка учитывается");
  await resetTasks(); await closeW1();
  const pHeavy = await mkUser("p3_heavy", companyId, "+79997001014", "PICKER", W1);
  await mkShift(pHeavy, companyId, W1, "PICKER", new Date(Date.now() - 60000));
  const heavyTask = (await task(W1, "PICKER", { loadUnits: 10 })).task; // единственный кандидат → pHeavy (load=10)
  ok("тяжёлая задача (loadUnits=10) назначена pHeavy", (await assignee(heavyTask.id)) === pHeavy);
  const pBusy = await mkUser("p3_pbusy", companyId, "+79997001015", "PICKER", W1);
  await mkShift(pBusy, companyId, W1, "PICKER", new Date());
  const lightStart = (await task(W1, "PICKER", { loadUnits: 1 })).task; // pHeavy:10 vs pBusy:0 → pBusy
  await startWorkflowTask(pBusy, companyId, lightStart.id); // pBusy IN_PROGRESS, load=1
  const nextT = (await task(W1, "PICKER", { loadUnits: 1 })).task; // pHeavy:10 vs pBusy:1 → pBusy (наименьшая)
  ok("IN_PROGRESS не исключён: наименее загруженный (pBusy) снова выбран", (await assignee(nextT.id)) === pBusy, `got ${await assignee(nextT.id)}`);

  console.log("18) завершение смены возвращает ASSIGNED и переназначает ВТОРОМУ сотруднику");
  await resetTasks(); await closeW1();
  const rA = await mkUser("p3_rA", companyId, "+79997001016", "LOADER", W1);
  await mkShift(rA, companyId, W1, "LOADER");
  const retTask = (await task(W1, "LOADER")).task; // единственный кандидат → rA, ASSIGNED (не начата)
  ok("задача ASSIGNED у rA", (await statusOf(retTask.id)) === "ASSIGNED" && (await assignee(retTask.id)) === rA);
  const rB = await mkUser("p3_rB", companyId, "+79997001017", "LOADER", W1); // второй выходит на смену
  await mkShift(rB, companyId, W1, "LOADER");
  const ckA = await login("+79997001016");
  await endShiftHttp(ckA); // rA завершает смену → неначатая ASSIGNED возвращается в QUEUED
  await rebalanceQueuedTasks(companyId, { warehouseId: W1 }); // идемпотентно, если endShift уже переназначил
  const rAsg = await assignee(retTask.id), rSt = await statusOf(retTask.id);
  ok("задача снята с завершившего смену rA", rAsg !== rA, `asg=${rAsg}`);
  ok("возвращённая ASSIGNED переназначена второму сотруднику rB", rAsg === rB && rSt === "ASSIGNED", `asg=${rAsg} st=${rSt}`);

  console.log("19) параллельные тики планировщика: одно назначение, одно событие task_assigned");
  await resetTasks(); await closeW1(); await resetTaskEvents();
  const eU = await mkUser("p3_eU", companyId, "+79997001018", "LOADER", W1);
  await mkShift(eU, companyId, W1, "LOADER");
  const parTask = (await task(W1, "LOADER", { key: dk("par") })).task;
  await prisma.workflowTask.update({ where: { id: parTask.id }, data: { status: "QUEUED", assignedUserId: null, assignedShiftId: null, assignedAt: null } });
  await resetTaskEvents(); // считаем только события параллельных тиков
  await Promise.all([
    rebalanceQueuedTasks(companyId, { warehouseId: W1 }),
    rebalanceQueuedTasks(companyId, { warehouseId: W1 }),
  ]);
  ok("параллельные тики: задача назначена ровно один раз (eU)", (await statusOf(parTask.id)) === "ASSIGNED" && (await assignee(parTask.id)) === eU);
  ok("параллельные тики: ровно одно событие task_assigned", (await prisma.event.count({ where: { companyId, type: "task_assigned" } })) === 1, `events=${await prisma.event.count({ where: { companyId, type: "task_assigned" } })}`);

  console.log("20) RECEIVER: две активные смены сосуществуют; RECEIVE_GROUP распределяется; повтор идемпотентен");
  await resetTasks(); await closeW1();
  const recA = await mkUser("p3_recA", companyId, "+79997001019", "RECEIVER", W1);
  await new Promise((r) => setTimeout(r, 10));
  const recB = await mkUser("p3_recB", companyId, "+79997001020", "RECEIVER", W1);
  await mkShift(recA, companyId, W1, "RECEIVER", new Date(Date.now() - 60000));
  await mkShift(recB, companyId, W1, "RECEIVER", new Date());
  ok("два приёмщика имеют активные смены одновременно", (await prisma.workShift.count({ where: { companyId, warehouseId: W1, role: "RECEIVER", endedAt: null } })) === 2);
  const rt1 = (await task(W1, "RECEIVER", { type: "RECEIVE_GROUP" })).task; // → recA
  const rt2 = (await task(W1, "RECEIVER", { type: "RECEIVE_GROUP" })).task; // A:1,B:0 → recB
  ok("две RECEIVE_GROUP распределены по одному на приёмщика (нет дублей)", (await assignee(rt1.id)) === recA && (await assignee(rt2.id)) === recB, `${await assignee(rt1.id)}/${await assignee(rt2.id)}`);
  const rd1 = await task(W1, "RECEIVER", { type: "RECEIVE_GROUP", key: dk("rec-idem") });
  const rd2 = await task(W1, "RECEIVER", { type: "RECEIVE_GROUP", key: dk("rec-idem") });
  ok("повтор приёмки (dedupeKey) не создаёт вторую задачу", rd1.created && !rd2.created && rd1.task.id === rd2.task.id);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ P2 ПРОЙДЕНЫ ✓" : `\nПРОВАЛЕНО: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  });
