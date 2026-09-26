# Publishing to npm

The public package name is:

```text
opencode-agent-skill
```

Current stable release target:

```text
14.4.0
```

## Release prerequisites

1. The npm account must have publish rights to the unscoped `opencode-agent-skill` package.
2. `package.json` and `package-lock.json` versions must match.
3. `CHANGELOG.md` must contain the release.
4. Local validation must pass from the exact release commit:

```cmd
npm run ci
```

The release gate includes source-integrity validation, runtime import/export validation, syntax checks, the full Node test suite, release consistency, package dry-run, Pi smoke tests, package-closure validation and packed-install smoke.

## Stable 14.4.0 local release

This repository does not require GitHub Actions for a manual release.

Authenticate interactively on the release machine:

```cmd
npm login
npm whoami
```

Confirm the stable version is not already published:

```cmd
npm view opencode-agent-skill@14.4.0 version --registry=https://registry.npmjs.org/
```

Run the complete gate and inspect the package:

```cmd
npm run ci
npm pack
```

Test the exact tarball with Pi:

```cmd
pi install .\opencode-agent-skill-14.4.0.tgz
pi list
```

Publish stable to the default `latest` dist-tag:

```cmd
npm publish --access public
```

For manual/local publishing, do not add `--provenance`. npm provenance is intended for supported cloud CI/OIDC publishing. If trusted publishing is configured later, provenance can be generated automatically by the supported CI provider.

Verify the registry after publication:

```cmd
npm view opencode-agent-skill@14.4.0 version
npm view opencode-agent-skill dist-tags
npm view opencode-agent-skill@latest version
```

Expected stable result:

```text
latest: 14.4.0
```

## Git tag

After the npm publication succeeds, create the matching immutable release tag from the same tested commit:

```cmd
npm run release:check-tag -- v14.4.0
git tag -a v14.4.0 -m "UES 14.4.0"
git push origin v14.4.0
```

Never move an existing release tag and never use force push for a release.

## Public install

Pi package install:

```cmd
npm install -g @earendil-works/pi-coding-agent
pi install npm:opencode-agent-skill
pi
```

Optional global CLI:

```cmd
npm install -g opencode-agent-skill@latest
ues version
```

Update an existing npm-based Pi install:

```cmd
pi update
```

## Release checklist

1. `git status` is clean.
2. `git pull --ff-only origin main`.
3. `npm run ci` passes.
4. `npm pack` succeeds and the tarball contains the required Pi/runtime files.
5. Exact packed install works.
6. `npm whoami` resolves the authorized publisher.
7. Exact target version is not already present.
8. `npm publish --access public` succeeds.
9. Registry reports `latest: 14.4.0`.
10. Create and push `v14.4.0` from the same commit.
11. Test `pi install npm:opencode-agent-skill` in a clean environment before announcing the release.
