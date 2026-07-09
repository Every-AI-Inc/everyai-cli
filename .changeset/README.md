# Changesets

This directory is managed by [changesets](https://github.com/changesets/changesets).

Add a changeset for any user-facing change:

```bash
npx changeset
```

Each changeset is a small markdown file describing the change and the semver bump
(`patch` / `minor` / `major`). On merge to `main`, the release workflow collects
pending changesets into a "Version Packages" PR; merging that PR publishes to npm.
