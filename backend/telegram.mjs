const API = "https://api.telegram.org";
const POLL_SECONDS = 25;

/**
 * Telegram capture channel: long-polls the Bot API, saves messages from allowed chats, and replies.
 * Settings are re-read on every loop, so enabling/disabling or changing the token needs no restart.
 */
export function createTelegramBot({ store, settings, organizer, fetchImpl = globalThis.fetch, log = console }) {
  const status = { state: "off", username: "", error: "" };
  let stopped = false;
  let offset = 0;
  let failures = 0;
  let abort = null;
  let wake = null;

  async function call(token, method, body, signal) {
    const response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
    return payload.result;
  }

  const reply = (token, chatId, text) =>
    call(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch((error) =>
      log.warn?.(`[telegram] reply failed: ${error.message}`),
    );

  async function handle(token, message, allowed) {
    const chatId = String(message.chat?.id ?? "");
    if (!chatId) return;
    const text = String(message.text ?? message.caption ?? "").trim();

    if (/^\/id(@\w+)?$/i.test(text) || !allowed.includes(chatId)) {
      if (allowed.includes(chatId)) await reply(token, chatId, `채팅 ID: ${chatId}`);
      else await reply(token, chatId, `허용되지 않은 채팅입니다.\n채팅 ID: ${chatId}\nMemoReader 설정의 '허용할 채팅 ID'에 추가해 주세요.`);
      return;
    }
    if (/^\/start(@\w+)?$/i.test(text)) {
      await reply(token, chatId, "링크나 글을 보내면 보관함에 저장하고 PC가 자동으로 정리합니다.\n/list 최근 저장 목록");
      return;
    }
    if (/^\/list(@\w+)?$/i.test(text)) {
      const { items } = store.list({ limit: 5 });
      await reply(token, chatId, items.length ? items.map((item, index) => `${index + 1}. ${item.title || item.preview || item.url}`).join("\n") : "저장된 항목이 없습니다.");
      return;
    }
    if (!text) {
      await reply(token, chatId, "텍스트나 링크만 저장할 수 있습니다. 이미지는 아직 지원하지 않습니다.");
      return;
    }

    const forwardedAt = message.forward_origin?.date ?? message.forward_date;
    const { item, duplicate, merged } = await store.create({
      input: text,
      source: "telegram",
      sourceRef: `tg:${chatId}:${message.message_id}`,
      // Telegram keeps messages sent while the PC was off; file them under the time they were sent.
      createdAt: Number.isFinite(message.date) ? new Date(message.date * 1000).toISOString() : "",
      // A forwarded post carries the time it was originally posted.
      publishedAt: Number.isFinite(forwardedAt) ? new Date(forwardedAt * 1000).toISOString() : "",
    });
    if (!duplicate) organizer.enqueue(item.id);
    const answer = !duplicate ? "저장했습니다. 곧 정리됩니다." : merged ? "이미 저장된 링크예요. 보내신 글을 원문에 덧붙였습니다." : "이미 저장된 항목입니다.";
    await reply(token, chatId, answer);
  }

  async function loop() {
    while (!stopped) {
      const config = settings.get().telegram;
      if (!config.enabled || !config.botToken) {
        status.state = "off";
        status.username = "";
        status.error = "";
        await sleep(3000);
        continue;
      }
      abort = new AbortController();
      try {
        if (!status.username) status.username = (await call(config.botToken, "getMe", {}, abort.signal)).username ?? "";
        const updates = await call(
          config.botToken,
          "getUpdates",
          { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] },
          AbortSignal.any([abort.signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)]),
        );
        status.state = "ok";
        status.error = "";
        failures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) await handle(config.botToken, update.message, config.allowedChatIds);
        }
      } catch (error) {
        if (stopped) break;
        if (error?.name === "AbortError") continue;
        // A dropped connection is routine for a long poll (a kept-alive socket the other side already closed).
        // Retry at once, and only report and slow down when it keeps happening.
        failures += 1;
        const cause = error?.cause?.code || error?.cause?.message || "";
        const message = `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`;
        if (failures >= 3) {
          status.state = "error";
          status.error = message;
          status.username = "";
          if (failures === 3 || failures % 20 === 0) log.warn?.(`[telegram] ${message} — ${failures} failures in a row`);
        }
        await sleep(failures <= 2 ? 1000 : Math.min(30_000, 5000 * (failures - 2)));
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, ms);
    });
  }

  // A settings change aborts the in-flight long poll so the new token or switch applies at once.
  settings.onChange(() => {
    status.username = "";
    offset = 0;
    abort?.abort();
    wake?.();
  });

  return {
    start() {
      loop().catch((error) => log.error?.(`[telegram] loop crashed: ${error.stack ?? error}`));
    },
    stop() {
      stopped = true;
      abort?.abort();
      wake?.();
    },
    status: () => ({ ...status }),
  };
}
