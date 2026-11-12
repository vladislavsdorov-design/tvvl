// Выдаёт браузеру разрешение загрузить файл напрямую в Vercel Blob
// (так можно грузить большие видео — в обход лимита 4.5 МБ на запрос).
import { handleUpload } from "@vercel/blob/client";
import { ownerOk, methodGuard, blobToken } from "./_lib.js";

const VIDEO_TYPES = [
  "video/*", "application/octet-stream", "video/x-matroska", "video/quicktime",
];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;
  try {
    const result = await handleUpload({
      token: blobToken(),
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!(await ownerOk(clientPayload))) throw new Error("Неверный пароль");
        if (!pathname.startsWith("inbox/")) throw new Error("Неверный путь");
        return {
          allowedContentTypes: VIDEO_TYPES,
          maximumSizeInBytes: 5 * 1024 * 1024 * 1024, // 5 ГБ
          addRandomSuffix: true, // ссылку невозможно угадать
        };
      },
    });
    res.status(200).json(result);
  } catch (e) {
    const status = /пароль/i.test(e.message) ? 401 : 400;
    if (status === 400) console.error(e);
    res.status(status).json({ error: e.message });
  }
}
