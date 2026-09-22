# Publishing to npm

The package is published as:

```text
opencode-agent-skill
```

## Release prerequisites

1. The npm account must have publish rights to the unscoped `opencode-agent-skill` package name.
2. `package.json` and `package-lock.json` versions must match.
3. `CHANGELOG.md` must contain the release.
4. Run the complete local validation:

```cmd
npm run ci
```

CI includes syntax validation, resource validation, static skill routing, the 129-case V2 router matrix, 13 V11 contract tasks, standard/long/polyglot hidden-grader integrity checks, unit/integration tests, package dry-run, packed global-install smoke, and a plain one-command install/resource sync smoke.

## Manual release-like test

Do not use `npm install -g .` as a release simulation because npm may create a symlink/junction back to the checkout.

Use:

```cmd
npm pack
npm install -g .\opencode-agent-skill-11.0.0.tgz --allow-scripts=opencode-agent-skill
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
npm view opencode-agent-skill versions --json
npm view opencode-agent-skill@11.0.0 version
npm dist-tag ls opencode-agent-skill
```

The expected release tag is:

```text
latest: 11.0.0
```

## GitHub Actions publishing

The repository's publish workflow is OIDC/provenance-ready and runs the same package validation before `npm publish`.

For stronger long-term supply-chain security, configure npm Trusted Publishing for:

```text
GitHub owner: laivannha0202
Repository: opencode-agent-skill-
Workflow: publish.yml
```

Then the GitHub-hosted workflow can authenticate through OIDC instead of a long-lived npm publish token. npm Trusted Publishing requires the corresponding publisher relationship to be configured on npm; repository code alone cannot create that account-side trust relationship.

Until the npm-side Trusted Publisher relationship is configured, the workflow can fall back to a valid `NPM_TOKEN`. After OIDC publishing is verified, remove long-lived publish-token access where practical.

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
npm install -g opencode-agent-skill
```

If lifecycle execution is blocked by local npm policy:

```cmd
ocskill install
```
