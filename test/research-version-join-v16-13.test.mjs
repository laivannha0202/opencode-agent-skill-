// V16.13 Version join: installed + latest preserved, installed targeted.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESEARCH_VERSION_JOIN_POLICY,
  VERSION_RELATION,
  compareVersions,
  joinVersions,
} from "../lib/research-version-join-v16-13.mjs";

test("version-join policy id is byte-stable", () => {
  assert.equal(RESEARCH_VERSION_JOIN_POLICY, "research-version-join-v16-13");
});

test("installed and latest are both preserved, never collapsed", () => {
  const joined = joinVersions({ package: "next", installedVersion: "15.4.0", latestVersion: "16.2.0", latestSource: "registry" });
  assert.equal(joined.installedVersion, "15.4.0");
  assert.equal(joined.latestVersion, "16.2.0");
  assert.equal(joined.versionRelation, VERSION_RELATION.BEHIND_MAJOR);
  assert.notEqual(joined.installedVersion, joined.latestVersion);
});

test("recommendation targets installed by default", () => {
  const joined = joinVersions({ package: "next", installedVersion: "15.4.0", latestVersion: "16.2.0" });
  assert.equal(joined.recommendationTarget, "15.4.0");
  assert.equal(joined.recommendationTargetsInstalledByDefault, true);
  const upgrade = joinVersions({ package: "next", installedVersion: "15.4.0", latestVersion: "16.2.0", upgradeRequested: true });
  assert.equal(upgrade.recommendationTarget, "16.2.0");
});

test("version relations classify correctly", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), VERSION_RELATION.EQUAL);
  assert.equal(compareVersions("1.2.3", "1.3.0"), VERSION_RELATION.BEHIND_MINOR);
  assert.equal(compareVersions("1.2.3", "1.2.4"), VERSION_RELATION.BEHIND_PATCH);
  assert.equal(compareVersions("2.0.0", "1.9.9"), VERSION_RELATION.AHEAD);
  assert.equal(compareVersions("nonsense", "1.0.0"), VERSION_RELATION.UNKNOWN);
});
