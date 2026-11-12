// Первый запуск сайта: владелец придумывает пароль.
//   GET  — настроен ли уже сайт
//   POST {password} — задать пароль (только если ещё не задан)
import { KEY_OWNER, hashPassword, isClaimed, redis, methodGuard, fail } from "./_lib.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, ["GET", "POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") return res.status(200).json({ claimed: await isClaimed() });

    const pw = String(req.body?.password || "");
    if (pw.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    if (process.env.APP_PASSWORD) return res.status(409).json({ error: "Пароль уже задан в настройках Vercel" });
    const ok = await redis("SET", KEY_OWNER, hashPassword(pw), "NX");
    if (ok !== "OK") return res.status(409).json({ error: "Пароль уже задан" });
    res.status(200).json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
}
