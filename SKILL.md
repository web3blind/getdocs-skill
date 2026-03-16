---
name: getdocs
description: Download public documentation into Markdown for later analysis. Use when the user wants docs fetched from a URL with `/docs onefile URL`, `/docs manyfiles URL`, `docs in one file URL`, or `docs in many files URL`, and the agent should return either one Markdown file or a folder plus file list for page-by-page browsing.
---

# Get docs

Use this skill from the skill root.

## Supported user commands

Treat these English forms as canonical:

- `/docs onefile <url>`
- `/docs manyfiles <url>`
- `docs in one file <url>`
- `docs in many files <url>`

Map `onefile` to a single Markdown export. Map `manyfiles` to one Markdown file per page plus a file list manifest.

## Run

Run the wrapper:

```bash
node scripts/getdocs.js onefile <url>
```

or:

```bash
node scripts/getdocs.js manyfiles <url>
```

The wrapper also accepts the raw user command forms above, but prefer the canonical `onefile` / `manyfiles` invocation when you run it yourself.

## Packaging

This skill is self-contained in the `getdocs/` folder:

- `scripts/getdocs.js` is the command wrapper.
- `scripts/download-docs.js` is the downloader implementation.
- `package.json` declares the Node.js dependencies.

If `node_modules/` is not already present in the installed skill folder, install dependencies in the skill root before first use.

## Reply format

After the command succeeds, answer with exact absolute paths from the wrapper output:

- For `onefile`: return the single `RESULT_FILE`.
- For `manyfiles`: return `RESULT_DIRECTORY` and `RESULT_FILELIST`.

Do not paste the downloaded documentation unless the user asks for content. Download first, then inspect the resulting file or files only as needed for the next request.

## Reply format (IMPORTANT)

**Never use tables!** Use lists instead.

**Format rules:**

1. **No tables** — use bullet lists or numbered lists
2. **Links** — include clickable links to RSS items
3. **Structure:**
   - Version/Item name
   - Brief description (bullet points)
   - Link to original
4. **Language:** If content is in English — translate to Russian for easier reading

**Example good format:**

```markdown
## v2026.2.26

**What's new:**
- External Secrets Management — полный цикл управления secrets (audit, configure, apply, reload)
- [Link](https://github.com/...)

## v2026.2.25

**What's new:**
- Android/Chat — улучшен streaming и markdown рендеринг
- [Link](https://github.com/...)
```

**Notes**

- The downloader continues even if some pages fail — it logs warnings but saves successfully downloaded pages.
- The wrapper stores each run in `runs/` with an isolated timestamped directory.
- The generated `FILELIST.md` is the preferred entry point for selecting a page in `manyfiles` mode.
