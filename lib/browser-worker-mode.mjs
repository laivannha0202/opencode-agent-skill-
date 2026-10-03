// V16.3 LIVE DeepSeek: the managed worker mode matrix.
//
// This module exists because of a real bug. The smoke script started its worker
// with `live: false` unconditionally, so `--live` ran against an EPHEMERAL
// context, threw away the session `--auth` had just persisted, and reported
// `profile: (ephemeral)` next to `UI_CHANGED` while a real login sat on disk.
//
// It lives in `lib/` rather than in the script for two reasons: importing a
// script executes its `main()`, which is not something a test should trigger, and
// a mode table is POLICY, not glue.
//
//   mode                persistent  headed  purpose
//   -------------------- ----------  ------  --------------------------------
//   default preflight    no          yes     observe only; mutates nothing
//   --auth               YES         no      human logs in; profile is written
//   --live               YES         yes     reuse that profile for one query
//   CI / release         no          yes     never persistent
//
// `--live` is PERSISTENT WITHOUT EXCEPTION. A live consultation that silently
// used a throwaway profile would report "logged out" no matter how many times the
// user authenticated, which is precisely the failure being fixed here.

import { DEEPSEEK_PROFILE_NAME } from "./browser-profile.mjs"

export const WORKER_MODE = Object.freeze({
  PREFLIGHT: "preflight",
  AUTH: "auth",
  LIVE: "live",
})

export const WORKER_PROFILE_MODE = Object.freeze({
  EPHEMERAL: "ephemeral",
  PERSISTENT: "persistent",
})

/**
 * Resolve the mode from CLI intent.
 *
 * `auth` wins over `live` because the headed manual-login flow is strictly the
 * earlier step; passing both is a caller mistake, not a mode we invent.
 */
export function resolveWorkerMode(args = {}) {
  if (args.auth === true) return WORKER_MODE.AUTH
  if (args.live === true) return WORKER_MODE.LIVE
  return WORKER_MODE.PREFLIGHT
}

/**
 * The full plan for one worker start.
 *
 * `persistentProfileName` is null for preflight so a preflight can neither read
 * nor write the persisted session, and it is the SAME name for `--auth` and
 * `--live` so the two cannot resolve to different directories.
 */
export function workerModePlan(args = {}) {
  const mode = resolveWorkerMode(args);
  const requested = String(args.profile ?? "").trim();
  const profileName = requested || DEEPSEEK_PROFILE_NAME;
  const live = mode !== WORKER_MODE.PREFLIGHT;
  return {
    mode,
    live,
    headed: mode === WORKER_MODE.AUTH,
    profileName,
    persistentProfileName: live ? profileName : null,
    expectedProfileMode: live ? WORKER_PROFILE_MODE.PERSISTENT : WORKER_PROFILE_MODE.EPHEMERAL,
    // The exact argv the worker transport must receive. Kept here so the mode
    // decision and the process arguments cannot drift apart.
    scriptArgs: [
      ...(live ? ["--live", `--profile=${profileName}`] : []),
      ...(mode === WORKER_MODE.AUTH ? ["--headed"] : []),
    ],
  };
}

/**
 * Fail-closed guard: a mode that promised a persistent profile must not run on an
 * ephemeral one. Returns a reason string, or null when the capability is
 * acceptable for the plan.
 */
export function workerModeViolation(plan = {}, capability = {}) {
  const expected = plan.expectedProfileMode || WORKER_PROFILE_MODE.EPHEMERAL;
  const actual = String(capability.profileMode || WORKER_PROFILE_MODE.EPHEMERAL);
  if (expected === actual) return null;
  return `${plan.mode} requires a ${expected} profile, worker reported ${actual} (${capability.profileReason || "unknown"})`;
}

/**
 * The profile path a mode is expected to attach to, resolved through the same
 * resolver the worker uses. Used by tests to prove `--auth` and `--live` target
 * one identical directory.
 */
export function expectedProfilePath(plan, profileForMode) {
  const resolved = profileForMode({
    live: plan.live === true,
    profile: plan.persistentProfileName || "",
  });
  return resolved.userDataDir;
}