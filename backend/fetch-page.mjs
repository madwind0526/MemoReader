import { lookup } from "node:dns/promises";
import net from "node:net";

import { normalizePublishedAt, parseLooseDate } from "../shared/item.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
export const MAX_TEXT_CHARS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; MemoReader/0.1; personal reading library)";

/** True for loopback, private, link-local, CGNAT (Tailscale) and other non-public addresses. */
export function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

/** Rejects non-web URLs and hosts that resolve to private addresses (SSRF guard). */
export async function assertPublicUrl(rawUrl, lookupImpl = lookup) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("올바른 주소가 아닙니다.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http/https 주소만 가져올 수 있습니다.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("내부 네트워크 주소는 가져오지 않습니다.");
  }
  return url;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attributes(tag) {
  const out = {};
  for (const match of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return out;
}

function metaContent(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (names.includes(key) && attrs.content) return decodeEntities(attrs.content).trim();
  }
  return "";
}

function htmlToText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|figure|figcaption)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function absoluteUrl(value, base) {
  if (!value) return "";
  try {
    const url = new URL(value, base || undefined);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

const VIDEO_FILE = /\.(mp4|webm|mov|m4v|ogv)$/i;
const DECORATIVE_IMAGE = /(sprite|icon|logo|avatar|emoji|pixel|tracking|blank|spacer|1x1|badge|banner-ad|\.svg)/i;
const MAX_BODY_IMAGES = 5;

/** A direct video file from og:video tags. A player/embed page is not playable in a <video> tag. */
function videoFileFrom(html, finalUrl) {
  const type = metaContent(html, ["og:video:type"]).toLowerCase();
  for (const name of ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]) {
    const url = absoluteUrl(metaContent(html, [name]), finalUrl);
    if (!url) continue;
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    if (VIDEO_FILE.test(pathname) || type.startsWith("video/")) return url;
  }
  return "";
}

/** Content pictures from the article body, skipping icons, logos and tracking pixels. */
function bodyImages(regionHtml, finalUrl, exclude) {
  const found = [];
  for (const tag of regionHtml.match(/<img\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const source = attrs.src || attrs["data-src"] || attrs["data-original"] || (attrs.srcset ?? "").split(",")[0].trim().split(/\s+/)[0];
    const url = absoluteUrl(source, finalUrl);
    if (!url || url.startsWith("data:") || DECORATIVE_IMAGE.test(url) || url === exclude || found.includes(url)) continue;
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if ((width && width < 120) || (height && height < 120)) continue;
    found.push(url);
    if (found.length >= MAX_BODY_IMAGES) break;
  }
  return found;
}

const PUBLISHED_META = [
  "article:published_time", "og:article:published_time", "og:published_time", "datepublished", "date", "dc.date",
  "dc.date.issued", "dcterms.created", "pubdate", "publish_date", "parsely-pub-date", "sailthru.date", "video:release_date", "og:video:release_date",
];

/** The date the source says it was published: page meta, JSON-LD, a <time> tag, or Instagram's description. */
function publishedFrom(html, finalUrl) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (PUBLISHED_META.includes(key) && attrs.content) {
      const value = normalizePublishedAt(decodeEntities(attrs.content).trim());
      if (value) return value;
    }
  }
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let found = "";
    const walk = (node) => {
      if (found) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const key of ["datePublished", "uploadDate", "dateCreated"]) {
          if (typeof node[key] === "string" && !found) found = normalizePublishedAt(node[key].trim());
        }
        Object.values(node).forEach(walk);
      }
    };
    try {
      walk(JSON.parse(block[1]));
    } catch {
      // malformed JSON-LD is common; ignore it
    }
    if (found) return found;
  }
  const time = /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(html)?.[1];
  const fromTime = time ? normalizePublishedAt(time.trim()) : "";
  if (fromTime) return fromTime;
  if (/(^|\.)instagram\.com$/i.test(hostOf(finalUrl))) return parseLooseDate(metaContent(html, ["og:description"]));
  return "";
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Pulls title, description, preview media and readable text out of an HTML document. */
export function extractPage(html, finalUrl = "") {
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ||
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ")).trim();
  const description = metaContent(html, ["og:description", "description", "twitter:description"]);
  const image = absoluteUrl(metaContent(html, ["og:image", "twitter:image"]), finalUrl);
  const video = videoFileFrom(html, finalUrl);
  const siteName = metaContent(html, ["og:site_name"]);

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form|header)\b[\s\S]*?<\/\1>/gi, " ");
  const candidates = [
    /<article\b[\s\S]*<\/article>/i.exec(cleaned)?.[0],
    /<main\b[\s\S]*<\/main>/i.exec(cleaned)?.[0],
    /<body\b[\s\S]*<\/body>/i.exec(cleaned)?.[0],
    cleaned,
  ];
  let text = "";
  let region = "";
  for (const candidate of candidates) {
    if (!candidate) continue;
    text = htmlToText(candidate);
    region = candidate;
    if (text.length >= 300) break;
  }
  return { title, description, image, video, images: bodyImages(region, finalUrl, image), siteName, publishedAt: publishedFrom(html, finalUrl), text: text.slice(0, MAX_TEXT_CHARS) };
}

function decoderFor(contentType, head) {
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("utf-8");
  }
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = out.length - offset;
    if (room <= 0) break;
    out.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.length, room);
  }
  return out;
}

/** Downloads a public web page and extracts readable content. Every redirect hop is re-validated. */
export async function fetchPage(rawUrl, { fetchImpl = globalThis.fetch, lookupImpl = lookup } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, lookupImpl);
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "ko,en;q=0.8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location"), current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`페이지를 가져오지 못했습니다 (HTTP ${response.status}).`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)|application\/xhtml/i.test(contentType)) {
      throw new Error("웹 문서가 아니어서 본문을 가져오지 않았습니다.");
    }
    const bytes = await readLimited(response);
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const html = decoderFor(contentType, head).decode(bytes);
    if (/text\/plain/i.test(contentType)) {
      return { finalUrl: current, title: "", description: "", image: "", video: "", images: [], siteName: "", publishedAt: "", text: html.slice(0, MAX_TEXT_CHARS) };
    }
    return { finalUrl: current, ...extractPage(html, current) };
  }
  throw new Error("리다이렉트가 너무 많습니다.");
}
