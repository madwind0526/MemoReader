import { finalizeCategory } from "../shared/taxonomy.mjs";
import { needsRender } from "./render-page.mjs";
import { buildOrganizePrompts, fallbackTitle, mediaKindOf, parseOrganizeResult, publishedFromUrl } from "../shared/item.mjs";

/**
 * Serial organizing queue: fetch the linked page, ask the LLM for title/summary/category/tags, and
 * write the result back. The original text is never touched. Failures keep a readable fallback
 * title and a retryable "failed" status instead of losing the item.
 */
export function createOrganizer({ store, settings, fetchPage, renderPage = null, createLlm, log = console }) {
  const queue = [];
  let running = null;
  let waiters = [];
  let finished = 0;
  const drainListeners = new Set();

  // Messages raised by an unusable LLM setup (see backend/llm.mjs), as opposed to a bad answer.
  const SETUP_ERROR = /LLM 제공업체|LLM 연결 주소|API 키를 설정|명령을 찾을 수 없|정리 방식을 모두 시도/;

  function llmUsable() {
    try {
      createLlm(settings.get().llm);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Downloads the page; when that yields too little (a JavaScript-only page, a login shell, a blocked
   * request) and browser reading is on, loads it in a headless browser and keeps whichever read more.
   * Returns null when nothing could be read at all.
   */
  async function readPage(url, organizeOptions) {
    let fetched = null;
    let failure = "";
    try {
      fetched = await fetchPage(url);
    } catch (error) {
      failure = error.message;
      log.warn?.(`[organize] page fetch failed for ${url.slice(0, 80)}: ${failure}`);
    }
    // A page that is gone (404/410) will not appear in a browser either.
    const gone = /HTTP (404|410)(?!d)/.test(failure);
    if (renderPage && organizeOptions.render !== false && !gone && needsRender(fetched)) {
      const tryBrowser = async (options, label) => {
        try {
          const rendered = await renderPage(url, options);
          if (!rendered) return; // nothing to try (no saved login for this site)
          const better = !fetched || (rendered.text?.length ?? 0) > (fetched.text?.length ?? 0) + 100;
          if (better) {
            log.info?.(`[organize] read ${url.slice(0, 80)} with the ${label} (${fetched?.text?.length ?? 0} -> ${rendered.text.length} chars)`);
            fetched = { ...rendered, siteName: rendered.siteName || fetched?.siteName || "", image: rendered.image || fetched?.image || "" };
          }
        } catch (error) {
          log.warn?.(`[organize] ${label} read failed for ${url.slice(0, 80)}: ${error.message}`);
        }
      };
      await tryBrowser({ login: organizeOptions.useLogin === true }, "browser");
      // Still too little (a login wall): with logins not used by default, try once more with the saved login
      // of this site, but only when one is saved. Pages of other sites are not touched.
      if (organizeOptions.useLogin !== true && needsRender(fetched)) await tryBrowser({ login: true, loginOnly: true }, "browser (saved login)");
    }
    return fetched;
  }

  async function process(id) {
    const meta = store.get(id);
    if (!meta) return;
    await store.update(id, { status: "processing", error: "" });

    const content = (await store.readContent(id)) ?? { input: "", page: "" };
    const patch = {};
    let pageText = content.page;
    let page = null;

    // A link straight to a picture or video file has no page to read; the file itself is the preview.
    const mediaKind = mediaKindOf(meta.url);
    if (mediaKind === "image") patch.image = meta.url;
    if (mediaKind === "video") patch.video = meta.url;

    // A page stored earlier that is only a stub (a footer, a script notice) is read again, now with the browser.
    const stub = Boolean(pageText) && needsRender({ text: pageText });
    if (meta.url && (!pageText || stub) && !mediaKind) {
      const fetched = await readPage(meta.url, settings.get().organize);
      if (fetched && (!pageText || fetched.text.length > pageText.length)) {
        page = fetched;
        pageText = fetched.text;
        patch.siteName = fetched.siteName;
        patch.image = fetched.image || meta.image;
        patch.video = fetched.video || meta.video;
        patch.images = fetched.images;
      } else if (pageText) {
        page = { title: "", description: "", text: pageText };
      }
    } else if (pageText) {
      page = { title: "", description: "", text: pageText };
    }

    // Original publish time: exact address > page metadata > forwarded-message date (kept in meta) > the model's reading.
    const known = publishedFromUrl(meta.url) || page?.publishedAt || meta.publishedAt;
    if (known) patch.publishedAt = known;

    const config = settings.get();
    // Sub-folders (SNS/페북) are chosen from the link, so the model only needs the top-level names.
    const categories = [...new Set(store.stats().categories.map((entry) => entry.name.split("/")[0]))].slice(0, 40);
    try {
      const llm = createLlm(config.llm);
      const { system, user } = buildOrganizePrompts({
        input: content.input,
        url: meta.url,
        page: page ? { ...page, text: pageText } : null,
        categories,
        options: config.organize,
      });
      // `accept` lets a fallback chain move on to the next provider when an answer is not usable.
      const answer = await llm.complete(system, user, { accept: (text) => parseOrganizeResult(text, config.organize) });
      const result = parseOrganizeResult(answer, config.organize);
      if (llm.lastUsed && llm.lastUsed !== config.llm.provider) log.info?.(`[organize] ${id} organized by fallback ${llm.lastUsed}`);
      await store.update(
        id,
        {
          ...patch,
          title: result.title || meta.title || fallbackTitle({ pageTitle: page?.title, input: content.input, url: meta.url }),
          summary: result.summary,
          category: finalizeCategory(result.category, meta.url),
          tags: result.tags,
          ...(known ? {} : { publishedAt: result.publishedAt }),
          status: "done",
          error: "",
        },
        { page: pageText },
      );
    } catch (error) {
      log.warn?.(`[organize] ${id} failed: ${error.message}`);
      await store.update(
        id,
        {
          ...patch,
          title: meta.title || fallbackTitle({ pageTitle: page?.title, input: content.input, url: meta.url }),
          category: meta.category || "미분류",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        { page: pageText },
      );
    }
  }

  function pump() {
    if (running || !queue.length) return;
    const id = queue.shift();
    running = process(id)
      .then(() => {
        if (store.get(id)?.status === "done") finished += 1;
      })
      .catch((error) => log.error?.(`[organize] unexpected error for ${id}: ${error.stack ?? error}`))
      .finally(() => {
        running = null;
        if (queue.length) pump();
        else {
          const count = finished;
          finished = 0;
          const done = waiters;
          waiters = [];
          for (const resolve of done) resolve();
          if (count > 0) for (const listener of drainListeners) listener({ organized: count });
        }
      });
  }

  return {
    enqueue(id) {
      if (!queue.includes(id)) queue.push(id);
      pump();
    },
    /**
     * Re-queues what was waiting or interrupted when the server last stopped, plus items that only
     * failed because the LLM was not set up yet (once it is usable). Other failures stay failed so a
     * permanently bad item is not retried on every start.
     */
    resume() {
      for (const id of store.pendingIds()) this.enqueue(id);
      if (!llmUsable()) return;
      for (const item of store.list({ status: "failed", limit: 5000 }).items) {
        if (SETUP_ERROR.test(item.error)) this.enqueue(item.id);
      }
    },
    /** Called each time the queue empties after organizing at least one item successfully. */
    onDrained(listener) {
      drainListeners.add(listener);
      return () => drainListeners.delete(listener);
    },
    status: () => ({ queued: queue.length, running: Boolean(running) }),
    idle: () => (running || queue.length ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
  };
}
