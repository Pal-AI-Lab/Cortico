# AGENTS.md

Release checklist for this Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and [docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

- [ ] **Contract version**: `cortico.api` equals the world version on the `Contracts:` line that
  `check:extension` prints. A package with any other value does not load.
- [ ] **Self-description**: after changing tools, event types or the env prompt, run `pnpm describe:extension <dir>`.
  `cortico.describe` names the written file and `files` ships it.
- [ ] **Tags**: `cortico.tags` lists every tag in [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md) whose "when"
  fits, notice and warning tags included.
- [ ] **CHANGELOG.md** has a `## <version>` section for the version being published.
- [ ] **`os`**: set the npm `os` field when the package runs only on some platforms.
- [ ] **`pnpm check:extension <dir>`** passes. Its "Before publishing" section reports the items
  above for this package.
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions), in the plain-text format that
  `check:extension` prints and the [README](https://github.com/Pal-AI-Lab/cortico-extensions#readme) describes.
