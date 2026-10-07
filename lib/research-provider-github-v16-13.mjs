// V16.13 GitHub provider helper — NON-AUTHORITATIVE.
//
// Supports public source/README/docs/releases/tags/CHANGELOG/issues/PR
// metadata via the public API where possible. Optional token
// UES_RESEARCH_GITHUB_TOKEN is never logged, never placed into evidence,
// never sent to non-GitHub hosts. RATE_LIMIT -> fallback, not global failure.

export const GITHUB_PROVIDER_POLICY = "research-provider-github-v16-13";
export const GITHUB_PROVIDER_SCHEMA_VERSION = 1;

const GITHUB_API_HOSTS = new Set(["api.github.com"]);
const GITHUB_CONTENT_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "codeload.github.com"]);

export function isGitHubHost(hostname) {
  return GITHUB_API_HOSTS.has(String(hostname).toLowerCase())
    || GITHUB_CONTENT_HOSTS.has(String(hostname).toLowerCase());
}

export function githubHeaders({ token } = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "ues-research-v16-13",
  };
  // Token is attached ONLY for GitHub hosts by the caller (see authHeadersForHost).
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Attach the research token ONLY when the target is a GitHub host. Any other
 * host returns headers WITHOUT credentials.
 */
export function authHeadersForHost(url, { token } = {}) {
  let host = "";
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return { "Accept": "application/vnd.github+json", "User-Agent": "ues-research-v16-13" };
  }
  if (token && isGitHubHost(host)) return githubHeaders({ token });
  return { "Accept": "application/vnd.github+json", "User-Agent": "ues-research-v16-13" };
}

export function parseGitHubRepo(input = "") {
  const text = String(input || "").trim();
  const match = text.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export function githubApiUrl(kind, { owner, repo, extra } = {}) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  switch (kind) {
    case "repo": return base;
    case "releases": return `${base}/releases${extra ? `/${extra}` : ""}`;
    case "tags": return `${base}/tags`;
    case "contents": return `${base}/contents/${extra || "README.md"}`;
    case "issues": return `${base}/issues${extra ? `/${extra}` : ""}`;
    case "pulls": return `${base}/pulls${extra ? `/${extra}` : ""}`;
    default: return base;
  }
}

/**
 * Bounded GitHub query plan (<= maxQueries).
 */
export function buildGitHubQueries(brief = {}, repoRef = {}) {
  const max = Math.max(0, Math.min(3, Number(brief.maxQueries ?? 3)));
  const question = String(brief.question || "").slice(0, 300);
  const queries = [];
  if (repoRef.owner && repoRef.repo) {
    queries.push({ provider: "github", kind: "releases", url: githubApiUrl("releases", repoRef), question });
    if (queries.length < max) queries.push({ provider: "github", kind: "contents", url: githubApiUrl("contents", repoRef), question });
    if (queries.length < max) queries.push({ provider: "github", kind: "issues", url: githubApiUrl("issues", repoRef), question });
  } else if (question) {
    queries.push({ provider: "github", kind: "search", query: `github ${question}`.slice(0, 300), question });
  }
  return queries.slice(0, max);
}

/**
 * Classify a GitHub failure. RATE_LIMIT is a typed fallback signal, never a
 * global failure.
 */
export function classifyGitHubFailure({ status, body } = {}) {
  if (status === 429) return { kind: "RATE_LIMIT", retryable: false, fallback: true };
  if (status === 401 || status === 403) {
    const text = String(body || "");
    if (/rate limit/i.test(text)) return { kind: "RATE_LIMIT", retryable: false, fallback: true };
    if (status === 401) return { kind: "AUTH_REQUIRED", retryable: false, fallback: true };
    return { kind: "PROVIDER_UNAVAILABLE", retryable: false, fallback: true };
  }
  if (status >= 500 && status < 600) return { kind: "HTTP_5XX", retryable: true, fallback: true };
  if (status === 404) return { kind: "EMPTY_RESULT", retryable: false, fallback: true };
  return { kind: "PROVIDER_UNAVAILABLE", retryable: false, fallback: true };
}

export const githubProviderExports = Object.freeze({
  isGitHubHost,
  authHeadersForHost,
  parseGitHubRepo,
  githubApiUrl,
  buildGitHubQueries,
  classifyGitHubFailure,
});
