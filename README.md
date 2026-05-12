# docs-skill

OpenClaw skill for downloading public documentation into Markdown format.

For the user, use only:

- `/docs onefile <url>`
- `/docs manyfiles <url>`

The downloader first tries `r.jina.ai` and automatically falls back to direct fetch if needed.

## Installation

```bash
npm install
```

## Usage

### Download as single file

```bash
node scripts/getdocs.js onefile <url>
```

### Download as multiple files

```bash
node scripts/getdocs.js manyfiles <url>
```

### Supported public commands

- `/docs onefile <url>`
- `/docs manyfiles <url>`

## Output

- `onefile` mode: Returns a single `full-docs.md` file
- `manyfiles` mode: Returns a folder with individual Markdown files plus `FILELIST.md`

## Optional QMD indexing

If QMD is available, `getdocs` automatically creates a QMD collection after a successful download.

This lets an AI agent query large downloaded documentation through search first, instead of reading every Markdown file into context.

Typical flow:

1. Download docs with `onefile` or `manyfiles`.
2. `getdocs` creates a QMD collection for the generated Markdown output.
3. Follow-up analysis starts with QMD search against that collection.
4. The agent reads only the relevant files or line ranges returned by QMD.

The download still succeeds if QMD is not installed or indexing fails.

### QMD detection

Detection order:

1. `GETDOCS_QMD_BIN`, if set.
2. A local workspace wrapper at `scripts/qmd-local.sh`, if present.
3. `qmd` from `PATH`, for normal CLI installations.

You can disable QMD indexing with:

```bash
GETDOCS_QMD=off node scripts/getdocs.js manyfiles <url>
```

### QMD result fields

When QMD indexing is attempted, the wrapper may include:

- `RESULT_QMD_STATUS=created|disabled|failed`
- `RESULT_QMD_COLLECTION=<collection-name>`
- `RESULT_QMD_COMMAND_HINT=<qmd command to search this collection>`

For follow-up questions, use the command from `RESULT_QMD_COMMAND_HINT` and filter by `RESULT_QMD_COLLECTION`.

Example:

```bash
qmd search -c <RESULT_QMD_COLLECTION> "how OAuth works" -n 8 --line-numbers
```

Then read only the selected hits, not the whole downloaded docs corpus.

## Dependencies

- cheerio
- turndown
- turndown-plugin-gfm

## License

MIT

## About author

Created by Denis Skripnik — blind developer working with AI agents, accessibility, automation, and Web3 tooling.

- X: https://x.com/denis_skripnik
- Telegram (ru): https://t.me/blind_dev
- VK (ru): https://vk.com/blind_dev
