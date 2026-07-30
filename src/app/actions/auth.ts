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

  const result = await doLogin(identifier, password);
  if (!result.ok) {
    // не раскрываем наличие пользователя в другой организации — общий ответ по учётке
    return { error: result.error === "no-org" ? "Организация не найдена" : "Неверный телефон или пароль" };
  }

  redirect(next.startsWith("/") ? next : "/warehouse");
}

export async function logoutAction(): Promise<void> {
  await doLogout();
  redirect("/login");
}
