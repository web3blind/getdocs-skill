#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillRoot = path.resolve(__dirname, "..");
const downloadScriptPath = path.join(__dirname, "download-docs.js");
const runsRoot = path.join(skillRoot, "runs");
const UTF8_BOM = "\uFEFF";
const FULL_RUN_ATTEMPTS = 3;
const FULL_RUN_RETRY_DELAY_MS = 1500;

function printHelp() {
  console.log(`Usage:
  node scripts/getdocs.js onefile <url>
  node scripts/getdocs.js manyfiles <url>
  node scripts/getdocs.js /docs onefile <url>
  node scripts/getdocs.js /docs manyfiles <url>
  node scripts/getdocs.js "docs in one file <url>"
  node scripts/getdocs.js "docs in many files <url>"
`);
}

function sanitizeSegment(segment) {
  const clean = String(segment)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/\.+$/g, "");

  return clean || "_";
}

function hostFolderName(hostname) {
  return hostname.replace(/[:*?"<>|\\/\x00-\x1F]/g, "_");
}

function formatTimestamp(date = new Date()) {
  const parts = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ];
  const time = [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ];

  return `${parts.join("")}-${time.join("")}`;
}

function buildUrlSlug(parsedUrl) {
  const segments = parsedUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map(sanitizeSegment);

  if (segments.length === 0) {
    return sanitizeSegment(parsedUrl.hostname);
  }

  return [sanitizeSegment(parsedUrl.hostname), ...segments].join("__");
}

function parseCommand(argv) {
  const raw = argv.join(" ").trim();

  if (!raw || raw === "--help" || raw === "-h") {
    return { help: true };
  }

  const patterns = [
    {
      regex: /^\/docs\s+(onefile|manyfiles)\s+(.+)$/i,
      extract: (match) => ({ mode: match[1].toLowerCase(), url: match[2].trim() })
    },
    {
      regex: /^(onefile|manyfiles)\s+(.+)$/i,
      extract: (match) => ({ mode: match[1].toLowerCase(), url: match[2].trim() })
    },
    {
      regex: /^docs in one file\s+(.+)$/i,
      extract: (match) => ({ mode: "onefile", url: match[1].trim() })
    },
    {
      regex: /^docs in many files\s+(.+)$/i,
      extract: (match) => ({ mode: "manyfiles", url: match[1].trim() })
    }
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern.regex);
    if (match) {
      return pattern.extract(match);
    }
  }

  throw new Error(
    'Unsupported command. Use "/docs onefile <url>", "/docs manyfiles <url>", "docs in one file <url>", or "docs in many files <url>".'
  );
}

function validateUrl(urlString) {
  let parsed;

  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  return parsed;
}

function runDownloader(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [downloadScriptPath, ...args], {
      cwd: skillRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          [
            `docs-downloader exited with code ${code}.`,
            stdout.trim(),
            stderr.trim()
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    });
  });
}

async function wait(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runDownloaderWithRetries(args, attempts = FULL_RUN_ATTEMPTS) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runDownloader(args);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(FULL_RUN_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function writeUtf8BomFile(filePath, content) {
  await fs.writeFile(filePath, `${UTF8_BOM}${content}`, "utf8");
}

async function collectMarkdownFiles(rootDir) {
  const results = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== "FILELIST.md") {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

async function writeResultFiles({
  mode,
  url,
  runRoot,
  finalDir,
  finalFile,
  fileListPath,
  files
}) {
  const resultLines = [
    `RESULT_MODE=${mode}`,
    `RESULT_URL=${url}`,
    finalFile ? `RESULT_FILE=${finalFile}` : `RESULT_DIRECTORY=${finalDir}`,
    fileListPath ? `RESULT_FILELIST=${fileListPath}` : null,
    Array.isArray(files) ? `RESULT_FILES_COUNT=${files.length}` : null
  ].filter(Boolean);

  const resultPath = path.join(runRoot, "RESULT.txt");
  await writeUtf8BomFile(resultPath, `${resultLines.join("\n")}\n`);

  const payload = {
    mode,
    url,
    resultPath,
    outputFile: finalFile || null,
    outputDirectory: finalDir || null,
    fileListPath: fileListPath || null,
    files: files || null
  };

  await fs.writeFile(path.join(runRoot, "RESULT.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resultLines;
}

async function writeFileList(finalDir, url) {
  const files = await collectMarkdownFiles(finalDir);
  const relativeFiles = files.map((filePath) => path.relative(finalDir, filePath));
  const fileListPath = path.join(finalDir, "FILELIST.md");
  const content = [
    "# Downloaded Files",
    "",
    `Source URL: ${url}`,
    "",
    ...relativeFiles.map((filePath) => `- ${filePath}`)
  ].join("\n");

  await writeUtf8BomFile(fileListPath, `${content}\n`);

  return {
    fileListPath,
    files
  };
}

async function main() {
  const parsedCommand = parseCommand(process.argv.slice(2));
  if (parsedCommand.help) {
    printHelp();
    return;
  }

  const { mode, url } = parsedCommand;
  const parsedUrl = validateUrl(url);
  const runName = `${buildUrlSlug(parsedUrl)}-${mode}-${formatTimestamp()}`;
  const runRoot = path.join(runsRoot, runName);
  const finalDir = path.join(runRoot, hostFolderName(parsedUrl.hostname));

  await fs.mkdir(runRoot, { recursive: true });

  await runDownloaderWithRetries(["--url", url, "--mode", mode, "--out", runRoot]);

  if (mode === "onefile") {
    const finalFile = path.join(finalDir, "full-docs.md");
    await fs.access(finalFile);
    const resultLines = await writeResultFiles({
      mode,
      url,
      runRoot,
      finalDir,
      finalFile
    });

    console.log(resultLines.join("\n"));
    return;
  }

  await fs.access(finalDir);
  const { fileListPath, files } = await writeFileList(finalDir, url);
  const resultLines = await writeResultFiles({
    mode,
    url,
    runRoot,
    finalDir,
    fileListPath,
    files
  });

  console.log(resultLines.join("\n"));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
