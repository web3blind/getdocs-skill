# docs-skill

OpenClaw skill for downloading public documentation into Markdown format.

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

### Supported command formats

- `/docs onefile <url>`
- `/docs manyfiles <url>`
- `docs in one file <url>`
- `docs in many files <url>`

## Output

- `onefile` mode: Returns a single `full-docs.md` file
- `manyfiles` mode: Returns a folder with individual Markdown files plus `FILELIST.md`

## Dependencies

- cheerio
- turndown
- turndown-plugin-gfm

## License

MIT
