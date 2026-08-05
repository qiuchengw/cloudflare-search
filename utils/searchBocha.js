import { env } from "../envs.js";
import { ApiError } from "./errors.js";
import { cleanText } from "./html.js";
import { normalizeResults } from "./index.js";

async function searchBocha(params) {
  const { query, signal } = params;
  const apiKey = String(env.BOCHA_API_KEY || "").trim();

  if (!query) {
    throw new ApiError({
      status: 400,
      code: "MISSING_QUERY",
      category: "request",
      message: "Query cannot be empty",
    });
  }

  if (!apiKey) {
    throw new ApiError({
      status: 503,
      code: "BOCHA_NOT_CONFIGURED",
      category: "configuration",
      message: "BOCHA_API_KEY is not configured",
    });
  }

  const response = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      freshness: "noLimit",
      summary: true,
      count: 10,
    }),
  });

  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_BAD_STATUS",
      category: "upstream",
      message: `Bocha upstream error: ${response.status}`,
    });
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.data?.webPages?.value)
    ? payload.data.webPages.value
    : [];

  const results = items
    .map((row) => {
      const url = String(row?.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        title: cleanText(String(row?.name ?? url)) || url,
        url,
        description: cleanText(String(row?.summary ?? row?.snippet ?? "")),
      };
    })
    .filter(Boolean);

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_EMPTY",
      category: "upstream",
      message: "Bocha returned no results",
    });
  }

  return normalizeResults(results);
}

export const bochaAdapter = {
  name: "bocha",
  label: "博查",
  priority: 95,
  supports: {
    language: false,
    time_range: false,
    pageno: false,
  },
  // 只有配置了 BOCHA_API_KEY 才启用；否则默认链自动跳过
  isAvailable: () => !!String(env.BOCHA_API_KEY || "").trim(),
  search: searchBocha,
};

export default searchBocha;
