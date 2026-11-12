// Общие функции для API. Файлы с "_" в начале Vercel не превращает в эндпоинты.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const KEY_CMDS = "vm:cmds";     // очередь заданий для сервера
export const KEY_STATUS = "vm:status"; // что сервер сообщил о себе и своей папке
export const KEY_OWNER = "vm:owner";   // пароль владельца сайта (соль:хэш)
export const KEY_TOKEN = "vm:token";   // токен, с которым подключается сервер

// ---------- Redis (Upstash REST) ----------
// Интеграция Upstash в Vercel создаёт KV_REST_API_URL / KV_REST_API_TOKEN.
// При подключении Vercel может добавить к именам свой префикс (например STORAGE_KV_REST_API_URL),
// поэтому ищем любую пару ..._REST_API_URL + ..._REST_API_TOKEN.
function redisConfig() {
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    for (const key of Object.keys(env)) {
      if (!/(_REST_API_URL|_REDIS_REST_URL)$/.test(key)) continue;
      const tokenKey = key.replace(/_URL$/, "_TOKEN");
      if (env[key] && env[tokenKey]) { url = env[key]; token = env[tokenKey]; break; }
    }
  }
  if (!url || !token) {
    const seen = Object.keys(env).filter((k) => /KV|REDIS|UPSTASH/i.test(k));
    throw new Error(
      "Не подключена база Redis: Vercel → Storage → Upstash for Redis → Connect Project, затем Redeploy." +
      (seen.length ? " Найдены переменные: " + seen.join(", ") : " Переменных базы в проекте нет.")
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

// Токен Vercel Blob: обычно BLOB_READ_WRITE_TOKEN, но тоже может быть с префиксом
export function blobToken() {
  const env = process.env;
  if (env.BLOB_READ_WRITE_TOKEN) return env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(env).find((k) => k.endsWith("_READ_WRITE_TOKEN") && String(env[k]).startsWith("vercel_blob_rw_"));
  if (key) return env[key];
  throw new Error("Не подключено хранилище Blob: Vercel → Storage → Blob → Connect Project, затем Redeploy.");
}

export async function redis(...command) {
  const { url, token } = redisConfig();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
  });
  const data = await r.json();
  if (data.error) throw new Error("Redis: " + data.error);
  return data.result;
}

export async function redisPipeline(commands) {
  const { url, token } = redisConfig();
  const r = await fetch(url + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error("Redis: " + (data.error || "ошибка"));
  for (const d of data) if (d.error) throw new Error("Redis: " + d.error);
  return data.map((d) => d.result);
}

// ---------- пароль владельца ----------

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(pw, salt, 32).toString("hex");
}

export async function isClaimed() {
  if (process.env.APP_PASSWORD) return true;
  return Boolean(await redis("GET", KEY_OWNER));
}

export async function ownerOk(given) {
  if (!given) return false;
  if (process.env.APP_PASSWORD) return safeEqual(given, process.env.APP_PASSWORD);
  const stored = await redis("GET", KEY_OWNER);
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const h = scryptSync(String(given), salt, 32);
  return timingSafeEqual(h, Buffer.from(hash, "hex"));
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

export async function requireOwner(req, res) {
  if (await ownerOk(bearer(req))) return true;
  res.status(401).json({ error: "Неверный пароль" });
  return false;
}

// ---------- токен сервера ----------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих 0/O, 1/I
export function newToken() {
  const bytes = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.match(/.{5}/g).join("-"); // вида ABCDE-FGHJK-LMNPQ-RSTUV
}

export async function ensureToken() {
  let t = await redis("GET", KEY_TOKEN);
  if (!t) {
    await redis("SET", KEY_TOKEN, newToken(), "NX");
    t = await redis("GET", KEY_TOKEN);
  }
  return t;
}

// Чтобы не ходить в Redis на каждый запрос сервера, держим токен в памяти 30 с
let tokenCache = { value: null, at: 0 };
export function forgetToken() { tokenCache = { value: null, at: 0 }; }

export async function requireAgent(req, res) {
  const given = bearer(req).toUpperCase();
  if (!tokenCache.value || Date.now() - tokenCache.at > 30000) {
    tokenCache = { value: await redis("GET", KEY_TOKEN), at: Date.now() };
  }
  if (tokenCache.value && given && safeEqual(given, tokenCache.value)) return true;
  res.status(401).json({ error: "Неверный токен" });
  return false;
}

// ---------- мелочи ----------

export function parseJson(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function cleanName(name) {
  return String(name || "").split(/[\\/]/).pop().trim().slice(0, 200);
}

export function methodGuard(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader("Allow", allowed.join(", "));
    res.status(405).json({ error: "Метод не поддерживается" });
    return false;
  }
  return true;
}

export function fail(res, e) {
  console.error(e);
  res.status(500).json({ error: e.message || String(e) });
}
