import { normalizeResults } from "./index.js";

const PC_URL = "https://www.baidu.com/s";
const MOBILE_URL = "https://m.baidu.com/s";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 去除 HTML 标签与实体
 */
function decodeEntities(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 摘要提取：c-abstract（PC）/ content-right（PC）/ summaryData（移动端 SSR JSON）
 */
function extractSnippet(chunk) {
  if (!chunk) return "";
  const cAbstract = chunk.match(
    /<div class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (cAbstract) return decodeEntities(cAbstract[1]);

  const contentRight = chunk.match(
    /<span class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i
  );
  if (contentRight) return decodeEntities(contentRight[1]);

  const summary = chunk.match(
    /"summaryData":[\s\S]*?"generalLines":[\s\S]*?\{"text":"([\s\S]*?)"/
  );
  if (summary) return decodeEntities(summary[1]);

  return "";
}

function isUsableUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
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

/**
 * PC 版解析：遍历 <h3>…<a href>…</a></h3>，容器带 mu= 时优先用真实 URL
 */
export function parsePcResults(html) {
  const results = [];
  const segments = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = h3Re.exec(html)) !== null) {
    segments.push({ inner: m[1], start: m.index, end: h3Re.lastIndex });
  }

  for (let i = 0; i < segments.length; i++) {
    const { inner, start, end } = segments[i];
    const aMatch = inner.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;

    const href = aMatch[1].trim();
    const title = decodeEntities(aMatch[2]);
    if (!title) continue;
    if (!isUsableUrl(href)) continue;

    const containerStart = Math.max(0, start - 400);
    const muMatch = html.slice(containerStart, start).match(/\bmu="([^"]+)"/);
    const url = muMatch && isUsableUrl(muMatch[1]) ? muMatch[1] : href;

    const nextStart = segments[i + 1] ? segments[i + 1].start : Math.min(end + 2500, html.length);
    const description = extractSnippet(html.slice(end, nextStart));

    results.push({ title, url, description });
  }
  return results;
}

/**
 * 移动端版解析：有机结果是 SSR JSON 卡片（无可爬链接），但视频推荐卡片用 data-url 存真实 URL、
 * 标题在 <!--s-text-->、摘要取卡片内可见文本（视频文案）。
 */
export function parseMobileResults(html) {
  const results = [];
  const seen = new Set();
  const urlRe = /data-url="([^"]+)"/g;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, "&").trim();
    if (!isUsableUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // 定位包裹该 data-url 的 <a> 块，标题与 URL 在同一块内配对
    const aStart = html.lastIndexOf("<a", m.index);
    const aEnd = html.indexOf("</a>", m.index);
    if (aStart < 0 || aEnd < aStart) continue;
    const block = html.slice(aStart, aEnd + 4);

    const titleMatch = block.match(/<!--s-text-->([\s\S]*?)<!--\/s-text-->/);
    const title = titleMatch ? decodeEntities(titleMatch[1]) : "";
    if (!title) continue;

    // 摘要：块内可见文本（去标题、脚本、SSR 注释、视频时间标记）
    let visible = block
      .replace(/<!--s-text-->([\s\S]*?)<!--\/s-text-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<!--s-data:[\s\S]*?-->|<!--\/?s-text-->|<!--s-text-->|<!--\/s-data-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^\s*(00:00\s*\/\s*00:00|0:\d{2}\s*\/\s*\d{2}:\d{2})\s*/i, "")
      .trim()
      .slice(0, 160);

    results.push({ title, url, description: visible });
  }
  return results;
}

/**
 * 判断是否为百度安全验证/异常页
 */
function isChallengePage(html) {
  if (!html) return true;
  if (/<h3[^>]*>[\s\S]*?<a[^>]*href="https?:/i.test(html)) return false;
  if (/data-url="https?:/i.test(html)) return false;
  return (
    /百度安全验证|wappass|请开启JavaScript和Cookies|出现验证码/.test(html) ||
    html.length < 5000
  );
}

async function fetchAndParse(url, query, rn, signal) {
  const isMobile = url.includes("m.baidu.com");
  const params = new URLSearchParams();
  params.set(isMobile ? "word" : "wd", query);
  if (!isMobile) params.set("ie", "utf-8");
  params.set("rn", String(rn));

  const cookie = `BAIDUID=${Math.random().toString(36).slice(2)}:FG=1; BIDUPSID=${Math.random().toString(36).slice(2)};`;

  const response = await fetch(`${url}?${params.toString()}`, {
    signal,
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: isMobile ? "https://m.baidu.com/" : "https://www.baidu.com/",
      cookie,
    },
  });
  if (!response.ok) return [];

  const html = await response.text();
  if (isChallengePage(html)) return [];
  return isMobile ? parseMobileResults(html) : parsePcResults(html);
}

async function searchBaidu({ query, signal }) {
  if (!query) throw new Error("Query cannot be empty!");
  const rn = 10;

  // PC 优先；空/被验证则移动端兜底
  let results = [];
  try {
    results = await fetchAndParse(PC_URL, query, rn, signal);
  } catch {
    results = [];
  }
  if (results.length === 0) {
    try {
      results = await fetchAndParse(MOBILE_URL, query, rn, signal);
    } catch {
      results = [];
    }
  }

  if (results.length === 0) return [];
  return normalizeResults(results.slice(0, rn));
}

export default searchBaidu;
