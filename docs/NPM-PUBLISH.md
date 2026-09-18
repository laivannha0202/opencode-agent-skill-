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
npm install -g @laivannha0202/opencode-agent-skill --allow-scripts=@laivannha0202/opencode-agent-skill
```

Current npm versions require install-time lifecycle scripts to be explicitly approved for global installs. The approved `postinstall` synchronizes UES into OpenCode, so this is the intended one-command installation path. Older npm versions that predate package-specific approval can use the same command without `--allow-scripts`. If lifecycle scripts are skipped, follow with `ocskill install`.

## GitHub Actions publishing

Create a repository secret named `NPM_TOKEN` containing an npm automation token.

Then either:

- run the **Publish npm** workflow manually, or
- push a version tag such as `v3.0.0`.

## Release checklist

1. Update `package.json` and `package-lock.json` versions.
2. Update `CHANGELOG.md`.
3. Run `npm run ci` locally. CI includes `npm run smoke:pack`, which packs the project, installs the tarball into an isolated global npm prefix, verifies that install is not linked back to the source checkout, and checks resource synchronization.
4. For a manual release-like test, run `npm pack`, install the resulting `.tgz` rather than `npm install -g .`, and verify `ocskill install`, `ocskill status`, and `ocskill remove`.
5. Confirm `ocskill update` against a published test/current version when update behavior changed.
6. Commit and push.
7. Create and push the matching `vX.Y.Z` tag.
8. Confirm the Publish npm workflow succeeds.
9. Install the published package on at least one clean environment before announcing the release.


## Local development note

`npm install -g .` can create a symlink/junction to the source checkout. That is useful for development, but it is not a valid release simulation and can break if the checkout lives on a temporary or RAM disk.

Use:

```cmd
npm pack
npm install -g .\laivannha0202-opencode-agent-skill-3.0.0.tgz --allow-scripts=@laivannha0202/opencode-agent-skill
```

The packed-install smoke test enforces both the real-copy behavior and automatic OpenCode synchronization in CI.
