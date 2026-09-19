# Publishing to npm

The package is published as:

```text
@laivannha0202/opencode-agent-skill
```

## Release prerequisites

1. The npm account must have publish rights to the `@laivannha0202` scope.
2. `package.json` and `package-lock.json` versions must match.
3. `CHANGELOG.md` must contain the release.
4. Run the complete local validation:

```cmd
npm run ci
```

V4 CI includes syntax validation, full-catalog routing validation, hidden-grader integrity checks, unit/integration tests, package dry-run, and an isolated packed global-install smoke.

## Manual release-like test

Do not use `npm install -g .` as a release simulation because npm may create a symlink/junction back to the checkout.

Use:

```cmd
npm pack
npm install -g .\laivannha0202-opencode-agent-skill-4.0.0.tgz --allow-scripts=@laivannha0202/opencode-agent-skill
ocskill status
ocskill doctor
```

For routine development, the automated `smoke:pack` test uses an isolated npm prefix/OpenCode config so it does not replace the developer's currently installed UES.

## Manual publish

```cmd
npm login
npm whoami
npm run ci
npm publish --access public
```

After publication verify:

```cmd
npm view @laivannha0202/opencode-agent-skill versions --json
npm view @laivannha0202/opencode-agent-skill@4.0.0 version
npm dist-tag ls @laivannha0202/opencode-agent-skill
```

The expected release tag is:

```text
latest: 4.0.0
```

## GitHub Actions publishing

The repository's publish workflow is release-ready for token-based publishing and provenance. It runs the same package validation before `npm publish`.

For stronger long-term supply-chain security, configure npm Trusted Publishing for:

```text
GitHub owner: laivannha0202
Repository: opencode-agent-skill-
Workflow: publish.yml
```

Then the GitHub-hosted workflow can authenticate through OIDC instead of a long-lived npm publish token. npm Trusted Publishing requires the corresponding publisher relationship to be configured on npm; repository code alone cannot create that account-side trust relationship.

Until that npm-side setup is complete, keep a valid publish credential configured as `NPM_TOKEN`.

## Release checklist

1. Confirm version/changelog/package-lock consistency.
2. Run `npm run ci` locally on Windows and at least one Unix-like environment when practical.
3. Run `npm pack` and inspect the tarball contents.
4. Verify packed install/state/resource counts.
5. When installer compatibility changed, exercise both forced V1 and V2 paths through tests.
6. When updater behavior changed, test explicit latest-tag resolution, equal-version behavior, and downgrade refusal.
7. Commit and push the release branch.
8. Merge only after review/local validation is clean.
9. Create/push the matching `vX.Y.Z` tag or run the publish workflow.
10. Verify registry version and `latest` dist-tag.
11. Install the published package on a clean environment before announcing it.

## One-command user install

After publication:

```cmd
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

If lifecycle execution is blocked by local npm policy:

```cmd
ocskill install
```
