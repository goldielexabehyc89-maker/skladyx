import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { warehouseHomePath } from "@/lib/roles";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли (общий резолвер,
// см. warehouseHomePath). Навигация ссылается прямо на этот экран, не на редирект-маршрут /warehouse.
export default async function HomePage() {
  const session = await requireUser();
  redirect(warehouseHomePath(session));
}
