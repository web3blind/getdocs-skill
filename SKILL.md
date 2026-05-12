---
name: getdocs
description: Download public documentation into Markdown for later analysis. Use when the user wants docs fetched from a URL with `/docs onefile URL` or `/docs manyfiles URL`, and the agent should return either one Markdown file or a folder plus file list for page-by-page browsing.
---

# Get docs

Use this skill from the skill root.

## Supported user commands

For the user, the public interface is only:

- `/docs onefile <url>`
- `/docs manyfiles <url>`

Map `onefile` to a single Markdown export. Map `manyfiles` to one Markdown file per page plus a file list manifest.

## QMD indexing and retrieval-first analysis

After a successful download, `scripts/getdocs.js` automatically tries to create a QMD collection for the generated Markdown output if QMD is installed.

- QMD is optional: missing or failing QMD must not fail the docs download.
- Successful runs include `RESULT_QMD_STATUS=created`, `RESULT_QMD_COLLECTION=<name>`, and `RESULT_QMD_COMMAND_HINT=...` in the wrapper output.
- If QMD is unavailable, the wrapper may return `RESULT_QMD_STATUS=disabled` or `RESULT_QMD_STATUS=failed`; still treat the Markdown output as valid.
- The created collection is excluded from default QMD queries so downloaded docs do not pollute unrelated searches. Always filter by the returned collection name when querying those docs.

When the user asks follow-up questions about downloaded docs, use retrieval-first analysis:

1. If the latest relevant `RESULT_*` output has `RESULT_QMD_COLLECTION`, start with QMD, not file-by-file reading.
2. Prefer the command from `RESULT_QMD_COMMAND_HINT`: it may be a local wrapper or a normally installed `qmd` from `PATH`. Do not hard-code machine-specific QMD paths in analysis instructions.
3. Run a focused search against that collection, for example:

```bash
<qmd-command> search -c <RESULT_QMD_COLLECTION> "<question>" -n 8 --line-numbers
```

4. If keyword search is too narrow, run a broader retrieval query without full rerank first:

```bash
<qmd-command> query -c <RESULT_QMD_COLLECTION> "<question>" --no-rerank -n 8 --line-numbers
```

5. Read only the specific files/line ranges surfaced by QMD. Prefer `<qmd-command> get <file>:<line> -l <N>` when the QMD result gives a stable file and line reference; otherwise use a targeted `read` on the exact file.
6. Only read a whole generated file when QMD is unavailable, QMD results are clearly insufficient after retrying with better terms, or the user explicitly asks for the full file.
7. For manyfiles runs, `FILELIST.md` is still useful as a map, but do not browse every file before searching.

Quality rules for QMD retrieval:

- Use 2-3 search formulations when the first result set is weak: exact product/API terms, likely synonyms, and the user's natural-language question.
- Prefer evidence from multiple hits when answering architectural or comparative questions.
- Cite file paths and line ranges in the final answer when they materially support the conclusion.
- If QMD indexing failed, say so briefly and fall back to targeted `FILELIST.md` / file inspection.

## Task-flow decision layer

For normal user requests, default to an always-on subagent wrapper flow:

- parent session spawns a child session
- child session runs the existing `scripts/getdocs.js`
- child waits for the wrapper to finish
- child returns only the final wrapper output contract based on `RESULT_*`

Treat this orchestration wrapper as the default user path for both `onefile` and `manyfiles`, because even a single-file export may take a while.

Keep the decision layer, but only for these choices:

- `onefile` vs `manyfiles`
- download only vs download + analyze

Do not use the decision layer to choose between "subagent" and "no subagent" for normal user work.

### Download-only path

Use this path when the request is only to fetch docs from a public URL and return the generated artifact paths for later work.

Typical cases:

- `/docs onefile <url>`
- `/docs manyfiles <url>`
- "скачай документацию по этой ссылке"
- "сохрани docs в один файл / по страницам"

In this path:

- parent spawns child, child runs the existing wrapper once
- child waits for wrapper completion and returns only the final `RESULT_*` contract
- do not add detached background execution inside the child
- return only the wrapper result paths unless the user asked for content inspection

### Download + analyze path

Use this path when the request still starts with docs download, but also needs follow-up work on the downloaded result, for example:

- inspect or summarize the downloaded docs
- compare pages or sections after download
- extract specific details from the generated files

In this path:

- the download step still starts with the same existing wrapper inside the child session
- treat `scripts/getdocs.js` as the source of truth for execution and result packaging
- child waits for the wrapper to finish, returns the final `RESULT_*` contract, and only then follow-up analysis uses the generated files
- do not create detached background processes inside the child

## Run

### Default user path

For normal user requests, use the orchestration wrapper flow:

- parent spawns child
- child runs one of:

```bash
node scripts/getdocs.js onefile <url>
```

or:

```bash
node scripts/getdocs.js manyfiles <url>
```

- child waits for completion and returns only the final wrapper output contract
- do not detach or background the wrapper process inside the child

The wrapper may keep compatibility parsing internally, but user-facing guidance should expose only `/docs onefile <url>` and `/docs manyfiles <url>`.

### Direct local run

A direct local run without the parent->child wrapper is allowed only as a debug, smoke, or manual maintenance path, not as the main user path.

## Packaging

This skill is self-contained in the `getdocs/` folder:

- `scripts/getdocs.js` is the command wrapper.
- `scripts/download-docs.js` is the downloader implementation.
- `package.json` declares the Node.js dependencies.

If `node_modules/` is not already present in the installed skill folder, install dependencies in the skill root before first use.

Dependency bootstrap is a local prerequisite for the existing wrapper run, not a separate orchestration mode.

## Reply format

After the command succeeds, answer with exact absolute paths from the wrapper output.

Do not invent a parallel result contract. Use the wrapper output as the response contract, and in the default user path the child should return only the final `RESULT_*` values after completion.

- For `onefile`: return the single `RESULT_FILE`.
- For `manyfiles`: return `RESULT_DIRECTORY` and `RESULT_FILELIST`.

If present, also return QMD result lines exactly as emitted by the wrapper:

- `RESULT_QMD_STATUS`
- `RESULT_QMD_COLLECTION`
- `RESULT_QMD_COMMAND_HINT`

Do not stream partial progress as a substitute for completion. Do not paste the downloaded documentation unless the user asks for content. Download first, then inspect the resulting file or files only as needed for the next request.

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

- Internally the downloader first tries `r.jina.ai`, then falls back to direct fetch automatically. Do not ask the user to choose a fetch mode.
- The downloader continues even if some pages fail — it logs warnings but saves successfully downloaded pages.
- The wrapper stores each run in `runs/` with an isolated timestamped directory.
- The generated `FILELIST.md` is the preferred entry point for selecting a page in `manyfiles` mode.
