import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
  throwBlockedUpstreamError,
} from "./engineRequest.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const SO360_CHALLENGE_PATTERNS = [/验证码/i, /captcha/i, /antispider/i];

function isSo360ChallengeResponse(source) {
  const text = String(source || "");
  if (isChallengeResponse(text, SO360_CHALLENGE_PATTERNS)) {
    return true;
  }
  // 无结果容器且极短 → 视为验证/异常页
  if (
    text.length > 0 &&
    text.length < 5000 &&
    !/<li class="res-list"/i.test(text)
  ) {
    return true;
  }
  return false;
}

export function parseSo360Results(html) {
  if (isSo360ChallengeResponse(html)) {
    throwBlockedUpstreamError({ engine: "360搜索", surface: "html" });
  }

  const root = parseHtml(html);
  const items = root.querySelectorAll("li.res-list");
  const results = [];

  for (const node of items) {
    const link = node.querySelector("h3.res-title a[href]");
    if (!link) {
      continue;
    }

    const title = cleanText(link.innerHTML || link.text);
    const dataMdUrl = String(link.getAttribute("data-mdurl") || "").trim();
    const href = String(link.getAttribute("href") || "").trim();
    // data-mdurl 是真实 URL，优先使用
    const url =
      dataMdUrl && /^https?:\/\//i.test(dataMdUrl) ? dataMdUrl : href;
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }

    const snippet = cleanText(
      node.querySelector(".res-list-summary")?.text || ""
    );

    results.push({ title: title || url, url, description: snippet });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "360 parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

async function searchSo360(params) {
  const { query, language, signal } = params;
  const searchUrl = new URL("https://www.so.com/s");
  searchUrl.searchParams.set("q", query);

  const html = await fetchSearchText(searchUrl.toString(), {
    engine: "so360",
    engineLabel: "360搜索",
    signal,
    language,
    referrer: "https://www.so.com/",
    blockedStatuses: [403, 429],
    isBlocked: isSo360ChallengeResponse,
    blockedSurface: "html",
  });

  return parseSo360Results(html);
}

export const so360Adapter = {
  name: "so360",
  label: "360搜索",
  priority: 85,
  supports: {
    language: true,
    time_range: false,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchSo360,
};

export default searchSo360;
