import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли.
export default async function HomePage() {
  const session = await requireUser();
  redirect(session.role === "EMPLOYEE" ? "/warehouse/my" : "/warehouse/active");
}
