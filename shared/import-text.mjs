// Reading files the user imports as memos: a KakaoTalk chat export, but also plain text or Markdown notes, blog
// backups (HTML pages, WordPress/Tistory XML) and JSON dumps. Shared by the import screen (browser) and tests.
//
// parseImportFile() returns { format, entries }, each entry { at: Date | null, text, title }. `at` is null when
// the file does not say when it was written; the caller then falls back to the file's own date.
import { parseKakaoExport } from "./kakao.mjs";

const SEPARATOR_LINE = /^\s*(?:-{3,}|\*{3,}|={3,}|_{3,})\s*$/;
const DATE_IN_TEXT = /(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})/;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Page markup to plain text: scripts and styles go, block ends become line breaks, tags are dropped. */
export function htmlToText(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article|ul|ol|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value).trim().replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/, "$1-$2-$3"));
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1990 ? null : date;
}

function dateFromText(text) {
  const match = DATE_IN_TEXT.exec(text);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1990 ? null : date;
}

const clean = (text) => String(text ?? "").replace(/\r\n?/g, "\n").trim();

// ---- plain text and Markdown ------------------------------------------------------------------------------

function readFrontmatter(raw) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: raw.slice(match[0].length) };
}

/** Splits a text document into posts: a front-matter note is one post; otherwise by separator lines or "# " headings. */
function parseText(raw) {
  const source = clean(raw);
  const front = readFrontmatter(source);
  if (front) {
    const date = validDate(front.fields.date ?? front.fields.created ?? front.fields.published ?? front.fields.created_at);
    const body = front.body.trim();
    const heading = /^#\s+(.+)$/m.exec(body);
    return [{ at: date, text: body, title: front.fields.title || heading?.[1]?.trim() || "" }].filter((entry) => entry.text);
  }
  const lines = source.split("\n");
  let parts;
  if (lines.some((line) => SEPARATOR_LINE.test(line))) {
    parts = [];
    let current = [];
    for (const line of lines) {
      if (SEPARATOR_LINE.test(line)) {
        parts.push(current.join("\n"));
        current = [];
      } else current.push(line);
    }
    parts.push(current.join("\n"));
  } else if (lines.filter((line) => /^#\s+\S/.test(line)).length >= 2) {
    parts = [];
    let current = [];
    for (const line of lines) {
      if (/^#\s+\S/.test(line) && current.some((entry) => entry.trim())) {
        parts.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    parts.push(current.join("\n"));
  } else {
    parts = [source];
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((text) => {
      const heading = /^#\s+(.+)$/m.exec(text);
      return { at: dateFromText(text.split("\n").slice(0, 3).join("\n")), text, title: heading?.[1]?.trim() ?? "" };
    });
}

// ---- HTML pages ---------------------------------------------------------------------------------------------

function metaContent(html, key) {
  const pattern = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${key}["'][^>]*>`, "i");
  return pattern.exec(html)?.[0]?.match(/content=["']([^"']*)["']/i)?.[1] ?? "";
}

function parseHtmlPost(html) {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim() || htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "");
  const at = validDate(metaContent(html, "article:published_time") || /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(html)?.[1] || metaContent(html, "date"));
  const body = /<(article|main)\b[\s\S]*<\/\1>/i.exec(html)?.[0] ?? /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  return { at, text: htmlToText(body), title: title.slice(0, 120) };
}

/** One post per <article> when the page holds several, otherwise the page itself. */
function parseHtml(raw) {
  const articles = [...String(raw).matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((match) => match[0]);
  const posts = articles.length > 1 ? articles.map(parseHtmlPost) : [parseHtmlPost(String(raw))];
  return posts.filter((post) => post.text);
}

// ---- XML backups (WordPress export, Tistory backup, RSS/Atom) --------------------------------------------

function tagText(block, names) {
  for (const name of names) {
    const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
    if (found) return found[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  }
  return "";
}

function parseXml(raw) {
  const blocks = [...String(raw).matchAll(/<(item|entry|post)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]);
  const entries = [];
  for (const block of blocks) {
    const body = tagText(block, ["content:encoded", "content", "description", "summary", "body"]);
    const text = /<[a-z!][^>]*>/i.test(body) ? htmlToText(body) : clean(decodeEntities(body));
    if (!text) continue;
    entries.push({
      at: validDate(tagText(block, ["wp:post_date", "pubDate", "published", "updated", "date", "created"])),
      text,
      title: decodeEntities(tagText(block, ["title"])).slice(0, 120),
    });
  }
  return entries;
}

// ---- JSON dumps -------------------------------------------------------------------------------------------

function parseJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^﻿/, ""));
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data && Object.values(data).find((value) => Array.isArray(value) && value.some((entry) => entry && typeof entry === "object"))) || [];
  const pick = (entry, keys) => keys.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim()) ?? "";
  const entries = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.trim()) entries.push({ at: null, text: clean(entry), title: "" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const body = pick(entry, ["content", "text", "body", "message", "memo", "description", "html"]);
    const text = /<[a-z!][^>]*>/i.test(body) ? htmlToText(body) : clean(body);
    if (!text) continue;
    const dateValue = ["date", "createdAt", "created_at", "created", "published", "publishedAt", "pubDate", "time", "timestamp"].map((key) => entry[key]).find((value) => value !== undefined && value !== null && value !== "");
    entries.push({ at: validDate(dateValue), text, title: pick(entry, ["title", "subject", "name"]).slice(0, 120) });
  }
  return entries;
}

// ---- entry point ----------------------------------------------------------------------------------------

/** Works out the file's kind from its name and content and returns its posts. */
export function parseImportFile({ name = "", text = "" }) {
  const raw = String(text).replace(/^﻿/, "");
  const lower = name.toLowerCase();
  const head = raw.slice(0, 600).trimStart().toLowerCase();

  const kakao = parseKakaoExport(raw);
  if (kakao.length) return { format: "kakao", entries: kakao.map((message) => ({ at: message.at, text: message.text, title: "" })) };

  if (lower.endsWith(".json") || /^[[{]/.test(head)) {
    const entries = parseJson(raw);
    if (entries.length) return { format: "json", entries };
  }
  if (lower.endsWith(".xml") || head.startsWith("<?xml") || /^<(rss|feed)\b/.test(head)) {
    const entries = parseXml(raw);
    if (entries.length) return { format: "xml", entries };
  }
  if (/\.html?$/.test(lower) || /^<(!doctype html|html)\b/.test(head)) return { format: "html", entries: parseHtml(raw) };
  return { format: lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : "text", entries: parseText(raw) };
}

/** Plain-language name of what was recognized, for the screen. */
export const FORMAT_LABELS = {
  kakao: "카카오톡 대화",
  text: "텍스트",
  markdown: "마크다운",
  html: "웹페이지(HTML)",
  xml: "블로그 백업(XML)",
  json: "JSON",
};
