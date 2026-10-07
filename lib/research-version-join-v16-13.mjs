// V16.13 Version join — FIRST CLASS helper.
//
// Always preserves installed + latest. Implementation recommendations target
// installedVersion unless the task explicitly requests an upgrade.

export const RESEARCH_VERSION_JOIN_POLICY = "research-version-join-v16-13";
export const RESEARCH_VERSION_JOIN_SCHEMA_VERSION = 1;

export const VERSION_RELATION = Object.freeze({
  EQUAL: "EQUAL",
  BEHIND_MAJOR: "BEHIND_MAJOR",
  BEHIND_MINOR: "BEHIND_MINOR",
  BEHIND_PATCH: "BEHIND_PATCH",
  AHEAD: "AHEAD",
  UNKNOWN: "UNKNOWN",
});

function parseSemver(value) {
  const text = String(value || "").trim().replace(/^[v=]/, "");
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] == null ? 0 : Number(match[2]),
    patch: match[3] == null ? 0 : Number(match[3]),
  };
}

export function compareVersions(installed, latest) {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (!a || !b) return VERSION_RELATION.UNKNOWN;
  if (a.major !== b.major) return a.major < b.major ? VERSION_RELATION.BEHIND_MAJOR : VERSION_RELATION.AHEAD;
  if (a.minor !== b.minor) return a.minor < b.minor ? VERSION_RELATION.BEHIND_MINOR : VERSION_RELATION.AHEAD;
  if (a.patch !== b.patch) return a.patch < b.patch ? VERSION_RELATION.BEHIND_PATCH : VERSION_RELATION.EQUAL;
  return VERSION_RELATION.EQUAL;
}

/**
 * Join installed + latest without ever collapsing installed into latest.
 * Example: installed Next.js 15.4 + latest 16.2 keeps both; the
 * recommendation targets 15.4 unless upgradeRequested is true.
 */
export function joinVersions(input = {}) {
  const installedVersion = input.installedVersion != null ? String(input.installedVersion) : null;
  const latestVersion = input.latestVersion != null ? String(input.latestVersion) : null;
  const versionRelation = installedVersion && latestVersion
    ? compareVersions(installedVersion, latestVersion)
    : VERSION_RELATION.UNKNOWN;
  const upgradeRequested = input.upgradeRequested === true;
  return {
    schemaVersion: RESEARCH_VERSION_JOIN_SCHEMA_VERSION,
    policy: RESEARCH_VERSION_JOIN_POLICY,
    package: input.package != null ? String(input.package) : null,
    installedVersion,
    latestVersion,
    versionRelation,
    versionMatchedSource: input.versionMatchedSource || null,
    latestSource: input.latestSource || null,
    breakingChangeRange: input.breakingChangeRange || null,
    recommendationTarget: upgradeRequested ? latestVersion : installedVersion,
    recommendationTargetsInstalledByDefault: !upgradeRequested,
    exactVersionMatched: Boolean(input.versionMatchedSource) && versionRelation === VERSION_RELATION.EQUAL,
  };
}

export const researchVersionJoinExports = Object.freeze({
  compareVersions,
  joinVersions,
});
