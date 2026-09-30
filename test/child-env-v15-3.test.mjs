// V15.3 Phase 6 - the provisioning-child environment boundary.
//
// The defect: `npm run accept:fresh-pi` failed while
// `node scripts/acceptance-fresh-pi.mjs` passed, because npm exports its own
// configuration into the script environment and the nested project-scoped
// `npm install` refuses the inherited user-scoped `allow-scripts`.
//
// These tests pin the narrowest possible fix: remove exactly the variable that
// was MEASURED to poison the child, and prove that everything else survives.
// A sanitiser that removed the whole npm namespace would also pass the first
// case; it is the survival cases that make this a repair rather than a blunt
// instrument.

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  CHILD_ENV_OVERRIDES,
  describeSanitizedEnv,
  NPM_SCOPE_BREAKING_ENV_KEYS,
  PRESERVED_ENV_KEYS,
  provisioningChildEnv,
  sanitizeChildEnv,
} from "../lib/child-env.mjs"

const POISON = "npm_config_allow_scripts"
const POISON_VALUE = "@laivannha0202/opencode-agent-skill"

test("V15.3 child env: the proven npm poison variable is removed", () => {
  const env = sanitizeChildEnv({ [POISON]: POISON_VALUE, PATH: "/usr/bin" })
  assert.equal(POISON in env, false, "the scope-breaking npm variable must not reach the child")
  assert.equal(env.PATH, "/usr/bin")
  assert.deepEqual(describeSanitizedEnv({ [POISON]: POISON_VALUE }), [POISON])
})

test("V15.3 child env: the deny list is exactly the measured set, in both spellings", () => {
  // Each spelling npm may export the same setting under is removed, and nothing
  // is removed that was measured NOT to change the nested install's outcome.
  const names = new Set(NPM_SCOPE_BREAKING_ENV_KEYS)
  for (const key of ["npm_config_allow_scripts", "npm_config_allowScripts", "npm_allow_scripts"]) {
    assert.ok(names.has(key), `${key} must be denied`)
  }
  for (const key of [
    "npm_config_local_prefix",
    "npm_config_prefix",
    "npm_config_loglevel",
    "npm_config_user_agent",
    "npm_config_registry",
    "npm_command",
    "npm_execpath",
  ]) {
    assert.equal(names.has(key), false, `${key} was measured harmless and must not be denied`)
  }
  const env = sanitizeChildEnv({ npm_config_local_prefix: "E:/x", npm_config_user_agent: "npm/11" })
  assert.equal(env.npm_config_local_prefix, "E:/x")
  assert.equal(env.npm_config_user_agent, "npm/11")
})

test("V15.3 child env: an unrelated environment survives byte for byte", () => {
  const input = {
    [POISON]: POISON_VALUE,
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/dev",
    USERPROFILE: "C:\\Users\\dev",
    TEMP: "C:\\Temp",
    LANG: "en_GB.UTF-8",
    PI_PROVIDER: "anthropic",
    PI_API_KEY: "sk-not-a-real-key",
    OPENAI_API_KEY: "sk-also-not-real",
    MY_PROJECT_FLAG: "keep-me",
  }
  const out = sanitizeChildEnv(input)
  for (const [key, value] of Object.entries(input)) {
    if (key === POISON) continue
    assert.equal(out[key], value, `${key} must survive unchanged`)
  }
  // The input object itself is never mutated: a caller that reuses it must not
  // find its own environment silently rewritten.
  assert.equal(input[POISON], POISON_VALUE)
})

test("V15.3 child env: the required Pi variables are present in the output", () => {
  const out = provisioningChildEnv({ ...process.env, PATH: process.env.PATH })
  for (const [key, value] of Object.entries(CHILD_ENV_OVERRIDES)) {
    assert.equal(out[key], value, `${key} must be supplied to the provisioning child`)
  }
  // Windows spells the same variable `Path`, and the sanitiser copies keys
  // verbatim rather than renaming them, so the comparison is case-insensitive on
  // a case-insensitive platform and exact everywhere else.
  const lookup = (env, key) => {
    if (key in env) return env[key]
    if (process.platform !== "win32") return undefined
    const found = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
    return found ? env[found] : undefined
  }
  for (const key of PRESERVED_ENV_KEYS) {
    const expected = lookup(process.env, key)
    if (expected === undefined) continue
    assert.equal(lookup(out, key), expected, `${key} must reach the child untouched`)
  }
})

test("V15.3 child env: nothing in the sanitiser prints or returns a value", () => {
  const secret = "super-secret-token"
  const described = describeSanitizedEnv({ [POISON]: secret, PI_API_KEY: secret })
  assert.equal(described.includes(secret), false)
  assert.deepEqual(described, [POISON])
  // The description is names only, even when every denied key is present.
  const many = sanitizeChildEnv(Object.fromEntries(NPM_SCOPE_BREAKING_ENV_KEYS.map((k) => [k, secret])))
  assert.deepEqual(Object.keys(many), [])
})

test("V15.3 child env: sanitisation is deterministic and handles junk input", () => {
  const input = { B: "2", [POISON]: POISON_VALUE, A: "1" }
  assert.equal(JSON.stringify(sanitizeChildEnv(input)), JSON.stringify(sanitizeChildEnv(input)))
  assert.deepEqual(sanitizeChildEnv({}), {})
  assert.deepEqual(sanitizeChildEnv(null), {})
  assert.deepEqual(sanitizeChildEnv(undefined), {})
  assert.deepEqual(sanitizeChildEnv({ KEEP: undefined }), {}, "an undefined value is not an environment entry")
})

test("V15.3 child env: the real poison reproduces and the sanitised environment does not", { timeout: 180_000 }, () => {
  // Reproduce the release gate's exact shape: a nested project-scoped install in
  // a directory that is NOT the project npm was started from.
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  const install = (env) => spawnSync(npmCommand, [
    "install", "--ignore-scripts", "--no-package-lock", "--no-save", "--dry-run", "typebox@1.3.27",
  ], {
    cwd: process.env.TEMP || process.env.TMP || process.cwd(),
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
  })
  const base = { ...process.env }
  delete base[POISON]

  const poisoned = install({ ...base, [POISON]: POISON_VALUE })
  const clean = install(sanitizeChildEnv({ ...process.env }))
  assert.equal(clean.status, 0, `sanitised child must install: ${clean.stderr || clean.stdout}`)
  // The poisoning run is asserted to FAIL only when this machine's npm actually
  // enforces the rule; on an older npm it is a no-op and the assertion below is
  // what carries the test.
  if (poisoned.status !== 0) {
    const output = String(poisoned.stderr || poisoned.stdout)
    assert.match(output, /EALLOWSCRIPTS|allow-scripts|allowScripts/)
  }
})
