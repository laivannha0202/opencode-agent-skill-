// V16.7.1 Part 6: persisted, secret-free web-reasoning enablement metadata.
//
// Daily UX is `cd <project>; pi`. The user must not have to export
// `UES_WEB_REASONING_LIVE=1` in every shell. This suite proves:
//   1. the config file stores ONLY metadata (enabled/mode/profile NAME) and no
//      field could ever carry a credential;
//   2. writes are atomic and bounded, and a corrupt file is reported, never
//      silently repaired;
//   3. the documented precedence is exactly env override > persisted > default;
//   4. FORCE is never a default and a malformed env value is treated as absent;
//   5. `live` is derived, and a disabled config can never launch a browser;
//   6. the CLI exposes `ues deepseek on/off/mode` and writes the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(ROOT, "lib", "deepseek-web-config.mjs");
const CLI = path.join(ROOT, "bin", "ocskill.mjs");

const {
  WEB_CONFIG_SCHEMA_VERSION,
  WEB_CONFIG_POLICY,
  WEB_CONFIG_FILE,
  WEB_CONFIG_MODE,
  DEFAULT_WEB_ENABLED,
  DEFAULT_WEB_MODE,
  isValidWebProfileName,
  normalizeWebMode,
  normalizeWebConfig,
  webConfigFile,
  readWebConfig,
  writeWebConfig,
  resolveWebEnablement,
} = await import(pathToFileURL(MODULE).href);

function tempConfigDir() {
  return mkdtempSync(path.join(os.tmpdir(), "ues-webcfg-"));
}

test("V16.7.1 web-config: the schema is bounded metadata only", () => {
  assert.equal(WEB_CONFIG_SCHEMA_VERSION, 1);
  assert.equal(WEB_CONFIG_POLICY, "deepseek-web-config-v16-7-1");
  assert.equal(WEB_CONFIG_FILE, "web-reasoning.json");
  const normalized = normalizeWebConfig({});
  assert.deepEqual(Object.keys(normalized).sort(), ["enabled", "mode", "profile", "schemaVersion"]);
  // No credential-shaped field can survive normalization.
  const injected = normalizeWebConfig({
    enabled: true, mode: "auto", profile: "personal",
    password: "x", cookie: "x", token: "x", otp: "x", storageState: "x",
  });
  assert.deepEqual(Object.keys(injected).sort(), ["enabled", "mode", "profile", "schemaVersion"]);
  assert.ok(!("password" in injected) && !("cookie" in injected) && !("token" in injected));
});

test("V16.7.1 web-config: default is OFF (optional, backwards compatible) and mode default is AUTO, never FORCE", () => {
  assert.equal(DEFAULT_WEB_ENABLED, false);
  assert.equal(DEFAULT_WEB_MODE, WEB_CONFIG_MODE.AUTO);
  assert.notEqual(DEFAULT_WEB_MODE, WEB_CONFIG_MODE.FORCE);
  const normalized = normalizeWebConfig({});
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.mode, "auto");
});

test("V16.7.1 web-config: an invalid mode normalizes to AUTO and a hostile profile name is dropped", () => {
  assert.equal(normalizeWebMode("nonsense"), "auto");
  assert.equal(normalizeWebMode("OFF"), "off");
  assert.equal(normalizeWebMode("FORCE"), "force");
  assert.equal(normalizeWebConfig({ mode: "bogus" }).mode, "auto");
  // Traversal / absolute / separator attempts never become a profile.
  for (const bad of ["../../escape", "a/b", "a\\b", "", "  ", "-lead", "C:\\x"]) {
    assert.equal(normalizeWebConfig({ profile: bad }).profile, null, `profile ${JSON.stringify(bad)} must be dropped`);
  }
  assert.equal(isValidWebProfileName("personal"), true);
  assert.equal(isValidWebProfileName("work-2.test"), true);
  assert.equal(isValidWebProfileName("a/b"), false);
});

test("V16.7.1 web-config: read of a missing file is not an error and normalizes to defaults", async () => {
  const dir = tempConfigDir();
  try {
    const config = await readWebConfig(dir);
    assert.equal(config.exists, false);
    assert.equal(config.enabled, false);
    assert.equal(config.mode, "auto");
    assert.equal(config.profile, null);
    assert.equal(config.invalid, undefined);
    assert.equal(config.file, webConfigFile(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.7.1 web-config: a corrupt file is reported invalid and falls back to defaults, never a half-parse", async () => {
  const dir = tempConfigDir();
  try {
    const file = webConfigFile(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ this is not json", "utf8");
    const config = await readWebConfig(dir);
    assert.equal(config.exists, true);
    assert.equal(config.invalid, true);
    assert.equal(config.enabled, false);
    assert.equal(config.mode, "auto");
    assert.equal(config.profile, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.7.1 web-config: write is atomic (no temp file left) and round-trips metadata", async () => {
  const dir = tempConfigDir();
  try {
    const written = await writeWebConfig(dir, { enabled: true, mode: "auto", profile: "personal" });
    assert.equal(written.enabled, true);
    assert.equal(written.mode, "auto");
    assert.equal(written.profile, "personal");
    const file = webConfigFile(dir);
    assert.ok(existsSync(file), "config file must exist after write");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["enabled", "mode", "profile", "schemaVersion"]);
    // No `.tmp` sibling survives an atomic write.
    const dirEntries = execFileSync(process.execPath, ["-e",
      `const fs=require('fs');console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(path.dirname(file))})))`],
      { encoding: "utf8" }).trim();
    const entries = JSON.parse(dirEntries);
    assert.ok(!entries.some((name) => name.endsWith(".tmp")), `no temp file may remain: ${entries.join(",")}`);
    const reread = await readWebConfig(dir);
    assert.equal(reread.enabled, true);
    assert.equal(reread.profile, "personal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.7.1 web-config: write ignores unknown keys entirely (no smuggling)", async () => {
  const dir = tempConfigDir();
  try {
    await writeWebConfig(dir, { enabled: true, cookie: "secret", token: "secret", storageState: "x" });
    const file = webConfigFile(dir);
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("secret"), "a credential-shaped patch value must never reach disk");
    assert.ok(!/cookie|token|storageState|password/i.test(raw));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.7.1 web-config precedence: env override beats persisted beats default", () => {
  // env wins over everything.
  const envWins = resolveWebEnablement({
    persisted: { exists: true, enabled: false, mode: "off", profile: "personal" },
    env: { enabled: true, mode: "force", profile: "work" },
  });
  assert.equal(envWins.enabled, true);
  assert.equal(envWins.mode, "force");
  assert.equal(envWins.profile, "work");
  assert.deepEqual(envWins.sources, { enabled: "env", mode: "env", profile: "env" });

  // persisted wins when env is absent.
  const persistedWins = resolveWebEnablement({
    persisted: { exists: true, enabled: true, mode: "auto", profile: "personal" },
    env: {},
  });
  assert.equal(persistedWins.enabled, true);
  assert.equal(persistedWins.mode, "auto");
  assert.equal(persistedWins.profile, "personal");
  assert.deepEqual(persistedWins.sources, { enabled: "persisted", mode: "persisted", profile: "persisted" });

  // default wins when neither is present.
  const defaultWins = resolveWebEnablement({ persisted: null, env: {} });
  assert.equal(defaultWins.enabled, DEFAULT_WEB_ENABLED);
  assert.equal(defaultWins.mode, DEFAULT_WEB_MODE);
  assert.equal(defaultWins.profile, null);
  assert.deepEqual(defaultWins.sources, { enabled: "default", mode: "default", profile: "none" });
});

test("V16.7.1 web-config precedence: a malformed env value is treated as ABSENT, never coerced", () => {
  const resolved = resolveWebEnablement({
    persisted: { exists: true, enabled: true, mode: "auto", profile: "personal" },
    env: { mode: "banana", enabled: "yes", profile: "../escape" },
  });
  // Malformed mode -> persisted; non-boolean enabled -> persisted; bad profile -> persisted.
  assert.equal(resolved.mode, "auto");
  assert.equal(resolved.sources.mode, "persisted");
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.sources.enabled, "persisted");
  assert.equal(resolved.profile, "personal");
  assert.equal(resolved.sources.profile, "persisted");
});

test("V16.7.1 web-config: `live` is derived and a disabled or OFF config can never launch a browser", () => {
  assert.equal(resolveWebEnablement({ persisted: { exists: true, enabled: false, mode: "auto" } }).live, false);
  assert.equal(resolveWebEnablement({ persisted: { exists: true, enabled: true, mode: "off" } }).live, false);
  assert.equal(resolveWebEnablement({ persisted: { exists: true, enabled: true, mode: "auto" } }).live, true);
  assert.equal(resolveWebEnablement({ persisted: { exists: true, enabled: true, mode: "force" } }).live, true);
  // A disabled config with a hostile env trying to force it ON via MODE only
  // (no LIVE flag) still resolves through persisted/default, not a surprise ON.
  const envModeOnly = resolveWebEnablement({
    persisted: { exists: true, enabled: false, mode: "auto" },
    env: { mode: "force" },
  });
  assert.equal(envModeOnly.enabled, false);
  assert.equal(envModeOnly.mode, "force");
  assert.equal(envModeOnly.live, false, "mode alone must not enable a browser");
});

test("V16.7.1 web-config: `ues deepseek on/off/mode` persists the same bounded file", () => {
  const dir = tempConfigDir();
  try {
    const env = { ...process.env, UES_CONFIG_DIR: dir };
    const run = (argv) => execFileSync(process.execPath, [CLI, ...argv], { encoding: "utf8", env });

    const onOut = run(["deepseek", "on", "--json"]);
    const onJson = JSON.parse(onOut);
    assert.equal(onJson.enabled, true);
    assert.equal(onJson.mode, "auto");
    assert.equal(onJson.credentialFree, true);

    const modeOut = run(["deepseek", "mode", "force", "--profile", "work", "--json"]);
    const modeJson = JSON.parse(modeOut);
    assert.equal(modeJson.mode, "force");
    assert.equal(modeJson.profile, "work");
    assert.equal(modeJson.enabled, true);

    const file = path.join(dir, ".ues", WEB_CONFIG_FILE);
    const raw = readFileSync(file, "utf8");
    assert.ok(!/cookie|token|password|storageState/i.test(raw));

    const offOut = run(["deepseek", "off", "--json"]);
    const offJson = JSON.parse(offOut);
    assert.equal(offJson.enabled, false);
    assert.equal(offJson.live, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V16.7.1 web-config: the shipped extension reads the persisted config and derives the worker profile from it", () => {
  const source = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8");
  assert.ok(source.includes("deepseek-web-config.mjs"), "extension must import the web-config module");
  assert.ok(source.includes("resolveWebEnablement"), "extension must resolve the enablement precedence");
  assert.ok(source.includes("readWebConfig"), "extension must read the persisted config");
  // The worker profile must come from the resolved enablement, not only the registry.
  assert.ok(source.includes("RESOLVED_WEB_ENABLEMENT?.profile"), "worker must honor the resolved profile");
  // No credential-shaped accessor may appear in the wiring.
  assert.ok(!/storageState/.test(source.slice(source.indexOf("deepseek-web-config.mjs"), source.indexOf("deepseek-web-config.mjs") + 400)));
});
