import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { navRole } from "@/lib/roles";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли.
export default async function HomePage() {
  const session = await requireUser();
  // По переходной навигационной роли: только сотрудник → «Мои ТМЦ», иначе рабочий экран персонала.
  redirect(navRole(session) === "EMPLOYEE" ? "/warehouse/my" : "/warehouse/active");
}
