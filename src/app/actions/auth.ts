"use server";

import { redirect } from "next/navigation";
import { login as doLogin, logout as doLogout } from "@/lib/auth";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get("login") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");
  if (!identifier || !password) return { error: "Введите телефон и пароль" };

  const session = await doLogin(identifier, password);
  if (!session) return { error: "Неверный телефон или пароль" };

  redirect(next.startsWith("/") ? next : "/warehouse");
}

export async function logoutAction(): Promise<void> {
  await doLogout();
  redirect("/login");
}
