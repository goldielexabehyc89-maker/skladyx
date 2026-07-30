import { redirect } from "next/navigation";
import { currentSession } from "@/lib/tenant-auth";

export default async function RootPage() {
  // S3: свежая проверка — при host mismatch/блокировке ведём на /login
  const session = await currentSession();
  redirect(session ? "/warehouse" : "/login");
}
