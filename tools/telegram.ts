import { TELEGRAM_BOT_TOKEN } from "../config";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export async function telegramSend(params: Record<string, any>): Promise<string> {
  const chatId: string = params.chat_id;
  const text: string = params.text;

  if (!chatId || !text) return "missing chat_id or text param";

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });

    if (!res.ok) {
      const err = await res.json() as any;
      return `telegram error: ${err.description || res.statusText}`;
    }

    return `sent to telegram chat ${chatId}`;
  } catch (e: any) {
    return `telegram error: ${e.message}`;
  }
}

export async function setupTelegramWebhook(webhookUrl: string): Promise<string> {
  try {
    const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });

    if (!res.ok) {
      const err = await res.json() as any;
      return `failed to set webhook: ${err.description}`;
    }

    return "webhook registered";
  } catch (e: any) {
    return `webhook setup error: ${e.message}`;
  }
}

export async function handleTelegramUpdate(update: any): Promise<{ chatId: string; text: string } | null> {
  if (!update.message) return null;

  const { chat, text } = update.message;
  if (!chat?.id || !text) return null;

  return { chatId: String(chat.id), text };
}

let pollingOffset = 0;

export function startTelegramPolling(onUpdate: (update: any) => void | Promise<void>) {
  async function poll() {
    try {
      const res = await fetch(
        `${TELEGRAM_API}/getUpdates?offset=${pollingOffset}&timeout=30`
      );
      const data = await res.json() as any;

      if (data.ok && data.result.length) {
        for (const update of data.result) {
          pollingOffset = update.update_id + 1;
          await onUpdate(update);
        }
      }
    } catch (e: any) {
      console.error("telegram polling error:", e.message);
    }
    setImmediate(poll);
  }

  poll();
  console.log("telegram long-polling started");
}
