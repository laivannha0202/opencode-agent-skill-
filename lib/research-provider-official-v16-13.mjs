// V16.13 Official-docs provider helper — NON-AUTHORITATIVE.
//
// Uses package/registry/repo/homepage metadata + a curated override. Never
// guesses an official domain. Prefers exact-version docs; records explicitly
// when exact-version docs are unavailable.

export const OFFICIAL_PROVIDER_POLICY = "research-provider-official-v16-13";
export const OFFICIAL_PROVIDER_SCHEMA_VERSION = 1;

// Curated known official-domain overrides. Small, explicit, never guessed.
const KNOWN_OFFICIAL_DOMAINS = Object.freeze({
  "next": "nextjs.org",
  "next.js": "nextjs.org",
  "react": "react.dev",
  "react-dom": "react.dev",
  "vue": "vuejs.org",
  "svelte": "svelte.dev",
  "typescript": "typescriptlang.org",
  "vite": "vite.dev",
  "express": "expressjs.com",
  "fastify": "fastify.dev",
  "nestjs": "docs.nestjs.com",
  "django": "docs.djangoproject.com",
  "flask": "flask.palletsprojects.com",
  "spring-boot": "docs.spring.io",
  "playwright": "playwright.dev",
});

function hostFromUrl(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function officialDomainFromMetadata({ packageName, repository, homepage, registry }) {
  const name = String(packageName || "").toLowerCase();
  if (name && KNOWN_OFFICIAL_DOMAINS[name]) return { domain: KNOWN_OFFICIAL_DOMAINS[name], basis: "curated-override" };
  for (const candidate of [homepage, registry?.homepage, repository?.url, registry?.repository]) {
    const host = candidate ? hostFromUrl(candidate) : null;
    if (host && !/github\.com|npmjs\.com/.test(host)) return { domain: host, basis: "package-metadata" };
  }
  return { domain: null, basis: "unknown" };
}

/**
 * Resolve the official target without guessing. Returns { domain } or
 * { unknown: true }.
 */
export function resolveOfficialTarget(input = {}) {
  if (input.officialDomainOverride) {
    return { domain: String(input.officialDomainOverride).toLowerCase(), basis: "explicit-override", versionedDocUrl: input.versionedDocUrl || null };
  }
  const found = officialDomainFromMetadata(input);
  if (!found.domain) return { unknown: true, reason: "no-official-domain-in-metadata", basis: found.basis };
  return found;
}

// Curated exact-version documentation URL TEMPLATES. A template exists only
// where the project's own docs prove the convention. We NEVER synthesize
// `/docs/<version>` for an arbitrary domain: an unproven path is a fabricated
// URL that returns 404 (or, worse, a different page) and pollutes the evidence.
const VERSIONED_DOC_TEMPLATES = Object.freeze({
  "nextjs.org": (v) => (v ? `https://nextjs.org/docs/${v}` : null),
  "react.dev": () => null, // react.dev is not version-path addressable
  "vuejs.org": (v) => (v && /^\d+\./.test(v) ? `https://vuejs.org/v${v}/` : null),
});

/**
 * Resolve the URL to fetch for an official exact-version document.
 *
 * Resolution order (Section 7 of the directive):
 *   1. explicit exact-version URL supplied by the caller;
 *   2. a curated template that PROVES the path convention;
 *   3. a curated/explicit `versionedDocUrl` on the target;
 *   4. otherwise: null, and the caller records exact-version docs unavailable.
 *
 * Never returns a guessed `/docs/<version>` for an unproven domain.
 */
export function resolveOfficialDocUrl(target = {}, versionJoin = {}, input = {}) {
  if (input.officialDocUrl) return String(input.officialDocUrl);
  if (target.versionedDocUrl) return String(target.versionedDocUrl);
  const domain = String(target.domain || "").toLowerCase();
  const installed = versionJoin.installedVersion != null ? String(versionJoin.installedVersion) : "";
  const template = VERSIONED_DOC_TEMPLATES[domain];
  if (typeof template === "function") {
    const url = template(installed);
    if (url) return url;
  }
  return null;
}

/**
 * Bounded query plan (<= maxQueries). Prefers exact-version documentation.
 */
export function buildOfficialQueries(brief = {}, versionJoin = {}, target = {}) {
  const max = Math.max(0, Math.min(2, Number(brief.maxQueries ?? 2)));
  const question = String(brief.question || "").slice(0, 300);
  const pkg = String(versionJoin.package || brief.package || "").trim();
  const installed = String(versionJoin.installedVersion || "").trim();
  const queries = [];
  if (target.domain && pkg) {
    queries.push({
      provider: "official-docs",
      query: `site:${target.domain} ${pkg} ${installed ? installed + " " : ""}${question}`.trim().slice(0, 300),
      versionPinned: Boolean(installed),
      installedVersion: installed || null,
    });
  }
  if (queries.length < max && pkg) {
    queries.push({
      provider: "official-docs",
      query: `${pkg} ${installed ? "v" + installed + " " : ""}documentation ${question}`.trim().slice(0, 300),
      versionPinned: Boolean(installed),
      installedVersion: installed || null,
    });
  }
  return queries.slice(0, max);
}

/**
 * Record whether the fetched source matched the installed version. Never
 * silently treat latest docs as the installed version.
 */
export function evaluateOfficialVersionMatch(source = {}, versionJoin = {}) {
  const installed = String(versionJoin.installedVersion || "");
  const text = `${source.canonicalUrl || ""} ${source.title || ""} ${source.excerpt || ""}`;
  const mentionsInstalled = installed ? text.includes(installed) : false;
  if (!installed) return { versionMatch: "UNKNOWN", note: "installed-version-unknown" };
  if (mentionsInstalled || source.versionMatch === true) {
    return { versionMatch: "MATCHED", note: "exact-version-evidence", versionMatchedSource: source.canonicalUrl || null };
  }
  return { versionMatch: "LATEST_ONLY", note: "exact-version-docs-unavailable-recorded", versionMatchedSource: null };
}

export const officialProviderExports = Object.freeze({
  resolveOfficialTarget,
  resolveOfficialDocUrl,
  buildOfficialQueries,
  evaluateOfficialVersionMatch,
});
