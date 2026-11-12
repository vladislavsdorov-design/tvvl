// API для страницы в браузере (нужен пароль владельца):
//   GET  — состояние сервера, очередь заданий, токен для подключения
//   POST {type:"download", url, name, size} — сервер скачает видео
//   POST {type:"delete", name}              — сервер удалит видео
//   POST {type:"control", action}           — пульт плеера: pause / play / next / prev / open
//   POST {type:"rotate_token"}              — выдать новый токен (старый сервер отключится)
import {
  KEY_CMDS, KEY_STATUS, KEY_TOKEN, requireOwner, redis, redisPipeline, ensureToken, newToken,
  forgetToken, parseJson, cleanName, methodGuard, fail,
} from "./_lib.js";

const CONTROL_ACTIONS = ["pause", "play", "next", "prev", "open"];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ["GET", "POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!(await requireOwner(req, res))) return;

    if (req.method === "GET") {
      const [status, cmds, token] = await redisPipeline([
        ["GET", KEY_STATUS],
        ["LRANGE", KEY_CMDS, 0, -1],
        ["GET", KEY_TOKEN],
      ]);
      return res.status(200).json({
        status: parseJson(status),
        queue: (cmds || []).map((c) => parseJson(c)).filter(Boolean),
        token: token || (await ensureToken()),
        now: Date.now(),
      });
    }

    const body = req.body || {};
    if (body.type === "rotate_token") {
      const token = newToken();
      await redisPipeline([["SET", KEY_TOKEN, token], ["DEL", KEY_STATUS]]);
      forgetToken();
      return res.status(200).json({ ok: true, token });
    }

    let cmd;
    if (body.type === "control") {
      // Пульт плеера: пауза, продолжить, следующее, предыдущее, открыть окно плеера
      if (!CONTROL_ACTIONS.includes(body.action)) return res.status(400).json({ error: "Неизвестная команда" });
      cmd = { type: "control", action: body.action, id: Math.random().toString(36).slice(2, 10), created: Date.now() };
      await redis("RPUSH", KEY_CMDS, JSON.stringify(cmd));
      return res.status(200).json({ ok: true, cmd });
    }

    const name = cleanName(body.name);
    if (!name) return res.status(400).json({ error: "Нет имени файла" });
    if (body.type === "download") {
      if (!/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(body.url || "")) {
        return res.status(400).json({ error: "Неверная ссылка на файл" });
      }
      cmd = { type: "download", url: body.url, name, size: Number(body.size) || 0 };
    } else if (body.type === "delete") {
      cmd = { type: "delete", name };
    } else {
      return res.status(400).json({ error: "Неизвестное задание" });
    }
    cmd.id = Math.random().toString(36).slice(2, 10);
    cmd.created = Date.now();
    await redis("RPUSH", KEY_CMDS, JSON.stringify(cmd));
    res.status(200).json({ ok: true, cmd });
  } catch (e) {
    fail(res, e);
  }
}
