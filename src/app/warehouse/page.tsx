import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { navRole, legacyWarehouseUiEnabled, workflowTasksEnabled } from "@/lib/roles";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли.
export default async function HomePage() {
  const session = await requireUser();
  const role = navRole(session);
  const legacyUi = legacyWarehouseUiEnabled();
  // Пакет 9B: при выключенном старом интерфейсе лендинги на legacy-экраны (Активные/Мои ТМЦ)
  // ведём в новый интерфейс — очередь задач (или остатки, если очередь выключена).
  const newHome = workflowTasksEnabled() ? "/warehouse/tasks" : "/warehouse/stock";
  // ADMIN не направляем принудительно на смену; рабочего — на экран смены; OBSERVER — на остатки.
  if (role === "ADMIN" || role === "STOREKEEPER") redirect(legacyUi ? "/warehouse/active" : newHome);
  if (role === "OBSERVER") redirect("/warehouse/stock");
  if (role === "EMPLOYEE") redirect(legacyUi ? "/warehouse/my" : newHome);
  redirect("/warehouse/shift"); // RECEIVER/LOADER/PICKER/CONTROLLER
}
