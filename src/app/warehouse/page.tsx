import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { warehouseHomePath } from "@/lib/roles";
import { getActiveShift } from "@/lib/work-shift";

// Отдельной «Главной» нет: /warehouse сразу ведёт на рабочий стартовый экран роли (общий резолвер,
// см. warehouseHomePath). ROLE-003: экран определяется активной сменой.
export default async function HomePage() {
  const session = await requireUser();
  const s = scoped(session);
  const shift = await getActiveShift(session.userId, s.companyId);
  redirect(warehouseHomePath(session, shift?.role ?? null));
}
