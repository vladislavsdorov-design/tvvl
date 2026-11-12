// API для сервера на компьютере (agent.py). Вход по токену с сайта.
// Всё через POST {action: ...}:
//   poll    — ждать новое задание до 20 с (ответ приходит сразу, как только оно появилось)
//   status  — сообщить, какие видео лежат в папке
//   done    — видео скачано, можно удалить его из Vercel Blob
//   requeue — не получилось выполнить, вернуть задание в очередь
import { del } from "@vercel/blob";
import { KEY_CMDS, KEY_STATUS, requireAgent, redis, parseJson, methodGuard, fail, blobToken } from "./_lib.js";

const WAIT_SECONDS = 20;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  const body = req.body || {};
  try {
    if (!(await requireAgent(req, res))) return;

    switch (body.action) {
      case "poll": {
        let items = [];
        let wait = 0;
        try {
          // BLPOP держит запрос, пока в очереди не появится задание
          const r = await redis("BLPOP", KEY_CMDS, WAIT_SECONDS);
          if (r) {
            items = [r[1], ...((await redis("LPOP", KEY_CMDS, 19)) || [])];
          }
        } catch (e) {
          // Если база не умеет ждать — просто берём что есть, а сервер подождёт сам
          console.error("BLPOP:", e.message);
          items = (await redis("LPOP", KEY_CMDS, 20)) || [];
          wait = 3;
        }
        return res.status(200).json({ commands: items.map((c) => parseJson(c)).filter(Boolean), wait });
      }
      case "status": {
        const status = {
          stage: body.stage === "folder" ? "folder" : "ready",
          folder: body.folder ? String(body.folder) : null,
          files: Array.isArray(body.files) ? body.files.slice(0, 5000) : [],
          disk_free: Number(body.disk_free) || 0,
          disk_total: Number(body.disk_total) || 0,
          busy: body.busy || null,
          player: body.player && typeof body.player === "object" ? {
            open: Boolean(body.player.open),
            name: body.player.name ? String(body.player.name).slice(0, 200) : null,
            paused: Boolean(body.player.paused),
          } : null,
          host: String(body.host || "").slice(0, 100),
          seen: Date.now(),
        };
        await redis("SET", KEY_STATUS, JSON.stringify(status));
        return res.status(200).json({ ok: true });
      }
      case "done": {
        if (body.url) {
          try { await del(body.url, { token: blobToken() }); } catch (e) { console.error("Blob del:", e.message); }
        }
        return res.status(200).json({ ok: true });
      }
      case "requeue": {
        const cmd = body.cmd;
        if (!cmd || typeof cmd !== "object") return res.status(400).json({ error: "Нет задания" });
        await redis("RPUSH", KEY_CMDS, JSON.stringify(cmd));
        return res.status(200).json({ ok: true });
      }
      default:
        return res.status(400).json({ error: "Неизвестное действие" });
    }
  } catch (e) {
    fail(res, e);
  }
}
