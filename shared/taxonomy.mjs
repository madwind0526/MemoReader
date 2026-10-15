// The category layout: a few broad categories. Every memo belongs to exactly one of them, and each
// category is one folder in the vault. Only SNS has sub-folders (one per site), chosen from the link.

export const CATEGORIES = ["PC", "AI", "ComfyUI", "생활", "영화", "투자", "SNS", "기타"];

/** Sub-folders of SNS, in display order. ETC is everything that is not one of the named sites. */
export const SNS_SUBCATEGORIES = ["페북", "인스타", "쓰레드", "블로그", "ETC"];

/** What belongs where, in words the organizer prompt can use. */
export const CATEGORY_GUIDE = {
  PC: "computers, PC and mobile games, gaming news and gear, IT magazines and tech news, utility software",
  AI: "AI models, AI video and image generation, how to use AI, vibe coding, open-source AI tools, motion graphics",
  ComfyUI: "anything about ComfyUI: nodes, workflows, ComfyUI-related tools (choose it whenever the content is about ComfyUI, even though it is also AI)",
  생활: "everyday life: travel, real estate, health, cars, starting a business, traditional liquor, pets, home and living products, architecture and design, smart farms, fashion",
  영화: "movies, TV dramas and series, anime, trailers, actors and actresses, film reviews and recommendations",
  투자: "stocks, ETFs, dividends, crypto and coins, NFT, DEX and other finance, the economy and markets",
  SNS: "ordinary social-media posts (humor, daily life, opinions, memes, clips) and social-media links whose content cannot be read, ONLY when the content fits none of the topical categories above. A post about AI, PC, ComfyUI, everyday life, movies or investing goes to that category even when it came from Facebook, Instagram or Threads",
  기타: "only when nothing above fits",
};

const SNS_ALIASES = new Map([
  ["페북", "페북"], ["페이스북", "페북"], ["facebook", "페북"],
  ["인스타", "인스타"], ["인스타그램", "인스타"], ["instagram", "인스타"],
  ["쓰레드", "쓰레드"], ["스레드", "쓰레드"], ["threads", "쓰레드"],
  ["블로그", "블로그"], ["블러그", "블로그"], ["blog", "블로그"],
  ["etc", "ETC"], ["기타", "ETC"],
]);

const BLOG_HOSTS = /(^|\.)(blog\.naver\.com|blog\.me|tistory\.com|brunch\.co\.kr|velog\.io|blogspot\.com|wordpress\.com|medium\.com)$/;

/** Which SNS sub-folder a link belongs to. Anything unknown is ETC. */
export function snsSubcategory(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
  } catch {
    return "ETC";
  }
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return "페북";
  if (/(^|\.)instagram\.com$/.test(host)) return "인스타";
  if (/(^|\.)(threads\.com|threads\.net)$/.test(host)) return "쓰레드";
  if (BLOG_HOSTS.test(host)) return "블로그";
  return "ETC";
}

/** The category to store: SNS always gets its sub-folder from the link; every other category is unchanged. */
export function finalizeCategory(category, url = "") {
  const text = String(category ?? "").trim();
  if (text === "SNS" || text.startsWith("SNS/")) return `SNS/${snsSubcategory(url)}`;
  return text;
}

/** Where the finer categories used before this layout belong. Names not listed here need a look at the content. */
export const LEGACY_CATEGORY_MAP = {
  "AI 활용법": "AI",
  "AI 모델": "AI",
  "AI 영상 스크립트": "AI",
  "모션그래픽 툴": "AI",
  "크리에이티브 코딩": "AI",
  "ComfyUI 노드": "ComfyUI",
  "게이밍 정보": "PC",
  "게이밍 기어": "PC",
  "모바일 게임": "PC",
  "IT 매거진": "PC",
  "유틸리티 툴": "PC",
  "여행 정보": "생활",
  "부동산 정보": "생활",
  "건강 관리": "생활",
  "자동차 정보": "생활",
  "창업 가이드": "생활",
  전통주: "생활",
  "펫 용품": "생활",
  "리빙 제품": "생활",
  "건축 디자인": "생활",
  스마트팜: "생활",
  "패션 정보": "생활",
};

/**
 * Brings any category into the layout: an old fine-grained name is mapped, a path like "AI/영상" keeps its
 * first part (only "SNS/<site>" keeps its second part), and anything unknown becomes 기타. An empty value
 * stays empty (not organized yet).
 */
export function normalizeCategory(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^#/, "");
  if (!text) return "";
  if (LEGACY_CATEGORY_MAP[text]) return LEGACY_CATEGORY_MAP[text];
  const [first, second = ""] = text.split("/").map((part) => part.trim());
  const match = CATEGORIES.find((name) => name.toLowerCase() === first.toLowerCase());
  if (match === "SNS") {
    const sub = SNS_ALIASES.get(second.toLowerCase());
    return sub ? `SNS/${sub}` : "SNS";
  }
  return match ?? "기타";
}
