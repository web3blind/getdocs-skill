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

## Dependencies

- cheerio
- turndown
- turndown-plugin-gfm

## License

MIT
