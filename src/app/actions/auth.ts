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

// Пакет 10 (fix): logout НЕ делает server-redirect на /login. Причина: при server-action redirect
// клиент получает встроенный RSC-рендер /login, который в отдельных случаях резолвит организацию по
// неверному host и показывает «Организация не найдена». Здесь только очищаем cookie; переход на /login
// выполняет клиент ПОЛНОЙ навигацией (window.location) — свежий серверный рендер по актуальному Host.
export async function logoutAction(): Promise<void> {
  await doLogout();
}
