import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { navRole } from "@/lib/roles";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли.
export default async function HomePage() {
  const session = await requireUser();
  const role = navRole(session);
  // ADMIN не направляем принудительно на смену; рабочего — на экран смены; OBSERVER — на остатки.
  if (role === "ADMIN" || role === "STOREKEEPER") redirect("/warehouse/active");
  if (role === "OBSERVER") redirect("/warehouse/stock");
  if (role === "EMPLOYEE") redirect("/warehouse/my");
  redirect("/warehouse/shift"); // RECEIVER/LOADER/PICKER/CONTROLLER
}
