import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
} from "./engineRequest.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const PC_URL = "https://www.baidu.com/s";
const MOBILE_URL = "https://m.baidu.com/s";
const BAIDU_CHALLENGE_PATTERNS = [
  /百度安全验证/i,
  /wappass/i,
  /请开启JavaScript和Cookies/i,
];

function isBaiduChallengeResponse(source) {
  const text = String(source || "");
  if (isChallengeResponse(text, BAIDU_CHALLENGE_PATTERNS)) {
    return true;
  }
  // 无结果容器且极短 → 视为验证/异常页
  if (
    text.length > 0 &&
    text.length < 5000 &&
    !/<h3\b/i.test(text) &&
    !/c-container/i.test(text)
  ) {
    return true;
  }
  return false;
}

function isUsableUrl(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    // 跳过"相关搜索/大家都在搜"推荐块
    if (host.includes("recommend_list.baidu.com")) {
      return false;
    }
    // 跳过 baidu.com 首页/搜索框；保留 /link 重定向、baijiahao、baike 等内容页
    if (
      (host === "baidu.com" || host === "www.baidu.com") &&
      (u.pathname === "/" || u.pathname === "/s")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractSnippet(node) {
  if (!node) {
    return "";
  }
  const snippetNode =
    node.querySelector(".c-abstract") ||
    node.querySelector('[class*="content-right"]') ||
    node.querySelector('[class*="summary"]');
  return cleanText(snippetNode?.text || "");
}

/**
 * PC 版解析：#content_left 下的 c-container / result-op，mu= 优先真实 URL
 */
export function parseBaiduPcResults(html) {
  const root = parseHtml(html);
  const containers = root.querySelectorAll(
    "#content_left .result.c-container, " +
      "#content_left .c-container[mu], " +
      "#content_left .c-container, " +
      "#content_left .result-op"
  );
  const results = [];

  for (const node of containers) {
    const link =
      node.querySelector("h3 a[href]") || node.querySelector("a[href]");
    if (!link) {
      continue;
    }

    const mu = String(node.getAttribute("mu") || "").trim();
    const href = String(link.getAttribute("href") || "").trim();
    const url = mu && isUsableUrl(mu) ? mu : href;
    if (!isUsableUrl(url)) {
      continue;
    }

    const title = cleanText(node.querySelector("h3")?.text || link.text) || url;
    const description = extractSnippet(node);

    results.push({ title, url, description });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Baidu parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

/**
 * 移动端版解析：视频/文章推荐卡片用 data-url 存真实 URL，标题取卡片内 h3 或可见文本
 */
export function parseBaiduMobileResults(html) {
  const root = parseHtml(html);
  const cards = root.querySelectorAll("[data-url]");
  const results = [];
  const seen = new Set();

  for (const card of cards) {
    const url = String(card.getAttribute("data-url") || "")
      .replace(/&amp;/g, "&")
      .trim();
    if (!isUsableUrl(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);

    const title = cleanText(card.querySelector("h3")?.text || card.text);
    if (!title) {
      continue;
    }

    results.push({ title, url, description: "" });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Baidu mobile parser could not find results",
    });
  }

  return normalizeResults(results);
}

function randomBaiduCookie() {
  return `BAIDUID=${Math.random().toString(36).slice(2)}:FG=1; BIDUPSID=${Math.random().toString(36).slice(2)};`;
}

async function fetchBaiduText(url, params, extra = {}) {
  return fetchSearchText(url, {
    engine: "baidu",
    engineLabel: "Baidu",
    signal: params.signal,
    language: params.language,
    referrer: url.includes("m.baidu.com")
      ? "https://m.baidu.com/"
      : "https://www.baidu.com/",
    cookies: randomBaiduCookie(),
    blockedStatuses: [403, 429],
    isBlocked: isBaiduChallengeResponse,
    blockedSurface: "html",
    ...extra,
  });
}

async function searchBaidu(params) {
  const { query, signal } = params;
  if (!query) {
    throw new ApiError({
      status: 400,
      code: "MISSING_QUERY",
      category: "request",
      message: "Query cannot be empty",
    });
  }

  // PC 优先；空/被验证则移动端兜底
  let html = null;
  try {
    const pcUrl = `${PC_URL}?wd=${encodeURIComponent(query)}&ie=utf-8&rn=10`;
    html = await fetchBaiduText(pcUrl, params);
    return parseBaiduPcResults(html);
  } catch (pcError) {
    // 只有 PC 通道失败才尝试移动端；信号被 abort 则直接抛
    if (signal?.aborted) {
      throw pcError;
    }
  }

  try {
    const mobileUrl = `${MOBILE_URL}?word=${encodeURIComponent(query)}`;
    html = await fetchBaiduText(mobileUrl, params);
    return parseBaiduMobileResults(html);
  } catch (mobileError) {
    if (mobileError instanceof ApiError) {
      throw mobileError;
    }
    throw mobileError;
  }
}

export const baiduAdapter = {
  name: "baidu",
  label: "百度",
  priority: 90,
  supports: {
    language: true,
    time_range: false,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchBaidu,
};

export default searchBaidu;
