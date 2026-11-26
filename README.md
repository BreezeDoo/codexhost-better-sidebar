# Better Sidebar for CodexHost

A file, change and conversation-outline workbench for **CodexHost Web** — in a resizable right-hand drawer, plus a full-page workspace.

> Status: `1.0.0`. Requires CodexHost with host-extension `manifestVersion: 2` support.

## Features

- **Files** — lazy tree, filename search, text editing and save, Markdown/code preview, images.
- **Changes** — current branch, staged/unstaged/untracked files, line-by-line diff against `HEAD`.
- **Outline** — jump between user turns and headings in the final answer of each turn; Markdown files get a heading outline too.
- **Workspace** — follows the selected thread's Codex session (`session_meta.cwd` / `runtime_workspace_roots[0]`), with manual root override and recent workspaces.
- **Two surfaces** — right-edge drawer in Web, independent page in the plugin workspace.

## Install

1. Download `better-sidebar-1.0.0.zip` from [Releases](https://github.com/BreezeDoo/codexhost-better-sidebar/releases).
2. **CodexHost Desktop**: Settings → Plugins → Import plugin, choose the zip, then enable it.
3. **CodexHost Web**: open the **Plugins** workspace → **Import plugin**, choose the zip, then enable it.
4. In Web, the drawer launcher appears on the right edge. The standalone page appears in the plug-in workspace's top tab bar.

## Privacy and boundaries

The bundled backend only reads and writes inside the workspace you select. It never uploads files, refuses `.git` and dependency directories, and writes atomically after checking the file's modification time. Git history is read with bundled JavaScript (`isomorphic-git`) — no `git` binary, no shell, no `child_process`.

Settings are stored by CodexHost in `host-extension-data/better-sidebar/settings.json`.

## Development

```bash
npm install
npm run build:backend   # esbuild → backend/index.mjs
npm test                # backend filesystem/git tests
npm run build:zip       # dist/better-sidebar-1.0.0.zip
```

Source layout:

```
manifest.json
page/        standalone page entry
web/         Web drawer entry
shared/      workbench UI, CSS, markdown renderer, icons
backend/src/ backend source; backend/index.mjs is the committed bundle
tests/       backend tests
assets/      icon and screenshots
```

The frontend is plain ESM (no build step). Both `page` and `web` use `shared/workbench.css`; only the backend is bundled, because it vendors `isomorphic-git` and `diff`.

## Publish a release

1. Bump `version` in `manifest.json` (and the zip filename/README if you like).
2. `npm test && npm run build`.
3. Create a public, non-draft GitHub Release with tag `v<version>`; upload `dist/better-sidebar-<version>.zip` as the only zip asset. If you change the icon or screenshots, upload those files as separate assets with the same names so the registry can verify them byte-for-byte.
4. Submit the repository URL through the CodexHost extension registry issue form, or add `sources/better-sidebar.json` with `{"id":"better-sidebar","repository":"https://github.com/BreezeDoo/codexhost-better-sidebar","trustTier":"community"}` in `BytePioneer-AI/codexhost-extensions-registry`.

## License

MIT
