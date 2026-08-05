import { env } from "../envs.js";
import { ApiError } from "./errors.js";
import { cleanText } from "./html.js";
import { normalizeResults } from "./index.js";

async function searchTavily(params) {
  const { query, signal } = params;
  const apiKey = String(env.TAVILY_API_KEY || "").trim();

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
      code: "TAVILY_NOT_CONFIGURED",
      category: "configuration",
      message: "TAVILY_API_KEY is not configured",
    });
  }

  const maxResults = 10;
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_BAD_STATUS",
      category: "upstream",
      message: `Tavily upstream error: ${response.status}`,
    });
  }

  const payload = await response.json();
  const results = (Array.isArray(payload.results) ? payload.results : [])
    .map((row) => {
      const url = String(row?.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        title: cleanText(String(row?.title ?? url)) || url,
        url,
        description: cleanText(String(row?.content ?? "")),
      };
    })
    .filter(Boolean);

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_EMPTY",
      category: "upstream",
      message: "Tavily returned no results",
    });
  }

  return normalizeResults(results);
}

export const tavilyAdapter = {
  name: "tavily",
  label: "Tavily",
  priority: 100,
  supports: {
    language: false,
    time_range: false,
    pageno: false,
  },
  // 只有配置了 TAVILY_API_KEY 才启用；否则默认链自动跳过
  isAvailable: () => !!String(env.TAVILY_API_KEY || "").trim(),
  search: searchTavily,
};

export default searchTavily;
