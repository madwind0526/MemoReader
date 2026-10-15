// Reads a browser-exported cookies.txt (Netscape format, e.g. from the "Get cookies.txt LOCALLY" extension)
// so the headless browser can open pages that need a login. Only the cookies that belong to the page being
// opened are ever handed to the browser; the file itself is read in place and never copied.
import { readFile, stat } from "node:fs/promises";

/** One cookie per line: domain, include-subdomains, path, secure, expiry, name, value. "#HttpOnly_" marks HttpOnly. */
export function parseCookies(text, nowSeconds = Date.now() / 1000) {
  const cookies = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const httpOnly = raw.startsWith("#HttpOnly_");
    if (raw.startsWith("#") && !httpOnly) continue;
    const parts = (httpOnly ? raw.slice("#HttpOnly_".length) : raw).split("\t");
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expiry, name, ...value] = parts;
    const expires = Number(expiry);
    if (!name || !domain) continue;
    if (expires > 0 && expires < nowSeconds) continue; // already expired
    cookies.push({
      name,
      value: value.join("\t"),
      domain,
      path: cookiePath || "/",
      secure: secure.toUpperCase() === "TRUE",
      httpOnly,
      ...(expires > 0 ? { expires } : {}),
    });
  }
  return cookies;
}

/** The cookies that apply to this address: same host, or a parent domain the cookie was set for. */
export function cookiesForUrl(cookies, rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Reads and parses the file, remembering the result until the file changes. Returns [] when there is no usable file. */
export function createCookieJar({ readImpl = readFile, statImpl = stat } = {}) {
  let cachedPath = "";
  let cachedStamp = 0;
  let cached = [];
  return async function load(filePath) {
    if (!filePath) return [];
    try {
      const stamp = (await statImpl(filePath)).mtimeMs;
      if (filePath !== cachedPath || stamp !== cachedStamp) {
        cached = parseCookies(await readImpl(filePath, "utf8"));
        cachedPath = filePath;
        cachedStamp = stamp;
      }
      return cached;
    } catch {
      return [];
    }
  };
}

// Cookie names that mean "this browser is logged in" on the sites people usually want to read.
const LOGIN_COOKIE_NAMES = new Set(["c_user", "xs", "sessionid", "ds_user_id", "auth_token", "reddit_session", "NID_SES", "SID", "__Secure-3PSID", "li_at"]);

function siteOf(domain) {
  const labels = domain.replace(/^\./, "").toLowerCase().split(".");
  // co.kr, or.kr, go.kr ...: the registrable name has three parts.
  const keep = labels.length >= 3 && /^(co|or|go|ne|ac|re)$/.test(labels.at(-2)) && labels.at(-1).length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** What a cookie file contains, without any cookie value: how many cookies, and where a login is saved. */
export function summarizeCookies(cookies) {
  const sites = new Set();
  for (const cookie of cookies) if (LOGIN_COOKIE_NAMES.has(cookie.name)) sites.add(siteOf(cookie.domain));
  return { count: cookies.length, sites: [...sites].sort() };
}
