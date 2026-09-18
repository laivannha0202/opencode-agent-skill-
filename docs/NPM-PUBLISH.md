# Publishing to npm

The repository is prepared to publish as:

```text
@laivannha0202/opencode-agent-skill
```

## One-time setup

1. Create or sign in to an npm account.
2. Make sure that account owns the `@laivannha0202` scope, or change the package scope in `package.json` to one you own.
3. Run:

```cmd
npm login
npm whoami
npm run ci
npm publish --access public
```

After the first successful publish, users can install with:

```cmd
npm install -g @laivannha0202/opencode-agent-skill
```

If their npm blocks lifecycle scripts, they can follow installation with `ocskill install`, or explicitly allow this package's lifecycle scripts when their npm version supports that option.

## GitHub Actions publishing

Create a repository secret named `NPM_TOKEN` containing an npm automation token.

Then either:

- run the **Publish npm** workflow manually, or
- push a version tag such as `v2.1.0`.

## Release checklist

1. Update `package.json` and `package-lock.json` versions.
2. Update `CHANGELOG.md`.
3. Run `npm run ci` locally.
4. Confirm `ocskill install`, `ocskill status`, and `ocskill remove` against a temporary `OPENCODE_CONFIG_DIR` when installer behavior changed.
5. Commit and push.
6. Create and push the matching `vX.Y.Z` tag.
7. Confirm the Publish npm workflow succeeds.
8. Install the published tarball on at least one clean environment before announcing the release.
