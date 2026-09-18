# Publishing to npm

The repository is ready to publish as:

```text
@laivannha0202/opencode-agent-skill
```

## One-time setup

1. Create or sign in to an npm account.
2. Make sure that account owns the `@laivannha0202` scope, or change the package scope in `package.json` to one you own.
3. Run:

```powershell
npm login
npm whoami
npm run ci
npm publish --access public
```

After the first successful publish, users can install with:

```powershell
npm install -g @laivannha0202/opencode-agent-skill
```

## GitHub Actions publishing

Create a repository secret named `NPM_TOKEN` containing an npm automation token.

Then either:

- run the **Publish npm** workflow manually, or
- push a version tag such as `v2.0.0`.

## New release

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Run `npm run ci`.
4. Commit and push.
5. Create/push the matching `vX.Y.Z` tag.
6. Confirm the Publish npm workflow succeeds.
