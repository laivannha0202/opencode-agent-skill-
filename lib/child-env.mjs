// Child environment boundary for a provisioning child process.
//
// WHAT THIS IS FOR
//
// `npm run <script>` does not execute the script with the environment the user
// typed. npm injects its OWN configuration into every script it launches,
// derived from whichever project scope the script was started in:
//
//     npm_config_allow_scripts   <- ~/.npmrc `allow-scripts=...`
//     npm_config_local_prefix    <- the project the script was started from
//     npm_config_prefix          <- the global install prefix
//     npm_config_user_agent      <- "npm/<v> node/<v> ..."
//     npm_command, npm_execpath  <- the parent invocation itself
//
// A script that then runs a NESTED npm in a DIFFERENT project scope inherits
// that scope-bound configuration and is poisoned by it. This was measured, not
// assumed, for `scripts/acceptance-fresh-pi.mjs`:
//
//     npm run accept:fresh-pi
//       -> child npm install exits 1
//       -> "npm error code EALLOWSCRIPTS
//           --allow-scripts is not allowed in project-scoped installs."
//
//     node scripts/acceptance-fresh-pi.mjs
//       -> PASS 26/26
//
// The cause is one variable. A controlled A/B, same temp directory, same
// command, only the environment differing:
//
//     with    npm_config_allow_scripts=<package>   -> exit 1, EALLOWSCRIPTS
//     without npm_config_allow_scripts            -> exit 0, "added 1 package"
//
// `allow-scripts` is a USER-scope npm 11 setting that npm materialises as an
// environment variable for its children. A project-scoped install refuses to
// accept it. The child is not misconfigured; it is being told about a
// configuration that belongs to a different scope.
//
// WHAT THIS DOES *NOT* DO
//
// It does not scrub the environment. PATH, HOME, USERPROFILE, TEMP, the Pi
// provider variables, credentials and every user variable survive untouched --
// only npm's allow-scripts configuration is removed, and only at the spawn
// boundary where the nested npm actually runs. Removing the whole npm_
// namespace would also have "fixed" this, but it would do so by deleting
// variables that were measured NOT to change the child's behaviour, which is
// indistinguishable from not knowing what the defect was.
//
// `npm_config_local_prefix`, `npm_config_prefix`, `npm_config_loglevel`,
// `npm_config_user_agent` and an arbitrary `npm_config_*` were each tested
// against the same nested install and each left the exit status at 0. They are
// therefore NOT removed. A variable belongs on the deny list only when it has
// been shown to change the child's outcome.
//
// SECRETS
//
// Nothing here prints a value. `describeSanitizedEnv` reports variable NAMES
// only, so a denial log can never leak a token that happens to be in the
// environment being sanitised.

import os from "node:os"

// Environment variable names npm materialises for its own children that describe
// the PARENT invocation's npm configuration rather than the child's.
//
// Each entry is here because it was measured to change the outcome of a nested,
// differently-scoped `npm install`; see the header. Both spellings are listed
// because npm echoes the config under the name the user wrote it as well as the
// canonical kebab-case form.
export const NPM_SCOPE_BREAKING_ENV_KEYS = Object.freeze([
  "npm_config_allow_scripts",
  "npm_config_allowScripts",
  "npm_allow_scripts",
  "npm_allowScripts",
])

const DENY_SET = new Set(NPM_SCOPE_BREAKING_ENV_KEYS)

// Variables that must survive sanitisation whatever else happens. This list is
// asserted by the regression tests rather than trusted: a sanitiser that quietly
// dropped PATH or a provider token would be worse than the bug it repairs.
export const PRESERVED_ENV_KEYS = Object.freeze([
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_API_KEY",
  "PI_AGENT_DIR",
])

// Variables the child is explicitly told to receive, whatever the parent had.
// These are the ones this repository's acceptance harness depends on.
export const CHILD_ENV_OVERRIDES = Object.freeze({
  UES_POST_WRITE_FEEDBACK: "1",
})

/**
 * Remove exactly the npm-injected variables proven to poison a differently
 * scoped child npm, apply the caller's own overrides, and keep everything else.
 *
 * The input is never mutated, the output is a fresh object, and key ORDER is
 * the input's order with the denied keys filtered out, so two runs of the same
 * environment produce byte-identical results.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ overrides?: Record<string, string | undefined> }} [options]
 * @returns {Record<string, string>}
 */
export function sanitizeChildEnv(env = {}, options = {}) {
  const source = env && typeof env === "object" ? env : {}
  const out = {}
  for (const key of Object.keys(source)) {
    if (DENY_SET.has(key)) continue
    const value = source[key]
    if (value === undefined) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(options.overrides || {})) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out
}

/**
 * Which variable names the sanitiser removed. NAMES ONLY -- an environment
 * value is exactly the thing that must never reach a log.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function describeSanitizedEnv(env = {}) {
  const source = env && typeof env === "object" ? env : {}
  return Object.keys(source).filter((key) => DENY_SET.has(key)).sort()
}

/**
 * The environment a provisioning child must run with: the parent's environment
 * with npm's scope-breaking configuration removed and the caller's overrides
 * applied. Used at the spawn boundary and by the acceptance tests.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ overrides?: Record<string, string | undefined> }} [options]
 * @returns {Record<string, string>}
 */
export function provisioningChildEnv(env = process.env, options = {}) {
  return sanitizeChildEnv(env, {
    overrides: { ...CHILD_ENV_OVERRIDES, ...(options.overrides || {}) },
  })
}

export function homeDir() {
  return os.homedir()
}

export const childEnvRuntimeExports = Object.freeze({
  sanitizeChildEnv,
  describeSanitizedEnv,
  provisioningChildEnv,
  NPM_SCOPE_BREAKING_ENV_KEYS,
  PRESERVED_ENV_KEYS,
  CHILD_ENV_OVERRIDES,
})
