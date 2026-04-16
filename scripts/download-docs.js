#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const BINARY_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".mp4",
  ".mp3",
  ".wav",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".css",
  ".js",
  ".map",
  ".json",
  ".xml",
  ".txt"
]);

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (!token.startsWith("-")) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=");
      if (inlineValue !== undefined) {
        args[key] = inlineValue;
      } else if (next && !next.startsWith("-")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = "true";
      }
      continue;
    }

    if (token === "-u" && next) {
      args.url = next;
      i += 1;
      continue;
    }

    if (token === "-m" && next) {
      args.mode = next;
      i += 1;
      continue;
    }

    if (token === "-o" && next) {
      args.out = next;
      i += 1;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/download-docs.js --url <docs-url> --mode <manyfiles|onefile>

Options:
  --url, -u          Docs root URL
  --mode, -m         manyfiles | onefile
  --out, -o          Output root directory (default: docs-results)
  --fetch-mode       auto | direct | jina (default: auto)
  --jina-rpm         Max Jina requests per minute in auto/jina mode (default: 20, about 3s/request)
  --jina-key         Jina API key
  --concurrency      Parallel page fetches (default: 5)
  --retries          Retry count per request (default: 3)
  --retry-delay-ms   Delay between retries in ms (default: 1000)
  --help, -h         Show help
`);
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function normalizeMode(modeRaw) {
  const mode = String(modeRaw || "").trim().toLowerCase();
  if (mode !== "manyfiles" && mode !== "onefile") {
    throw new Error(`Unsupported mode "${modeRaw}". Use "manyfiles" or "onefile".`);
  }
  return mode;
}

function normalizeFetchMode(fetchModeRaw) {
  const mode = String(fetchModeRaw || "auto").trim().toLowerCase();
  if (!["auto", "direct", "jina"].includes(mode)) {
    throw new Error(`Unsupported fetch mode "${fetchModeRaw}". Use "auto", "direct", or "jina".`);
  }
  return mode;
}

function parseNumber(input, fallback) {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeUrl(urlRaw) {
  const parsed = new URL(urlRaw);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = normalizePathname(parsed.pathname);
  return parsed.toString();
}

function normalizePathname(pathname) {
  let next = pathname || "/";
  if (!next.startsWith("/")) {
    next = `/${next}`;
  }
  next = next.replace(/\/{2,}/g, "/");
  if (next.length > 1 && next.endsWith("/")) {
    next = next.slice(0, -1);
  }
  return next;
}

function hostFolderName(hostname) {
  return hostname.replace(/[:*?"<>|\\/\x00-\x1F]/g, "_");
}

function sanitizeSegment(segment) {
  const clean = segment
    .trim()
    .replace(/[:*?"<>|\\/\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/\.+$/, "");

  if (!clean) {
    return "_";
  }
  return clean;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseLocValues(xmlText) {
  const locs = [];
  const regex = /<loc>\s*([^<\s][^<]*)\s*<\/loc>/gi;
  let match = regex.exec(xmlText);
  while (match) {
    locs.push(decodeXmlEntities(match[1].trim()));
    match = regex.exec(xmlText);
  }
  return locs;
}

function parseRobotsSitemaps(robotsText) {
  const lines = robotsText.split(/\r?\n/);
  const found = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith("sitemap:")) {
      continue;
    }
    const sitemapUrl = line.slice("sitemap:".length).trim();
    if (sitemapUrl) {
      found.push(sitemapUrl);
    }
  }
  return found;
}

function canonicalizeUrl(candidate, base) {
  try {
    const next = base ? new URL(candidate, base) : new URL(candidate);
    next.hash = "";
    next.search = "";
    next.pathname = normalizePathname(next.pathname);
    return next.toString();
  } catch {
    return null;
  }
}

function hasBinaryExtension(urlString) {
  try {
    const pathname = new URL(urlString).pathname || "";
    const ext = path.posix.extname(pathname).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  } catch {
    return true;
  }
}

function isDocUrlAllowed(urlString, origin, docsPathRoot) {
  try {
    const parsed = new URL(urlString);
    if (parsed.origin !== origin) {
      return false;
    }

    const normalizedPath = normalizePathname(parsed.pathname);
    const pathMatchesRoot =
      docsPathRoot === "/" ||
      normalizedPath === docsPathRoot ||
      normalizedPath.startsWith(`${docsPathRoot}/`);

    if (!pathMatchesRoot) {
      return false;
    }

    return !hasBinaryExtension(urlString);
  } catch {
    return false;
  }
}

async function wait(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(urlString, retries, retryDelayMs) {
  let attempt = 0;
  let lastError = null;

  while (attempt < retries) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(urlString, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "docs-downloader/1.0 (+strict-crawl)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) {
        await wait(retryDelayMs);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${urlString}`);
}

async function fetchText(urlString, retries, retryDelayMs) {
  const response = await fetchWithRetry(urlString, retries, retryDelayMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${urlString}`);
  }
  return response.text();
}

async function fetchTextWithHeaders(urlString, retries, retryDelayMs, headers = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt < retries) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(urlString, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "docs-downloader/1.1 (+jina-fallback)",
          ...headers
        }
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${urlString}`);
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) {
        await wait(retryDelayMs);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${urlString}`);
}

async function fetchViaJina(pageUrl, retries, retryDelayMs, jinaApiKey) {
  const jinaUrl = `https://r.jina.ai/${pageUrl}`;
  const headers = {
    Accept: "text/plain",
    "X-Return-Format": "markdown",
    "X-With-Links-Summary": "true"
  };

  if (jinaApiKey) {
    headers.Authorization = `Bearer ${jinaApiKey}`;
  }

  const text = await fetchTextWithHeaders(jinaUrl, retries, retryDelayMs, headers);

  let title = pageUrl;
  const titleMatch = text.match(/^Title:\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  const markdown = text
    .replace(/^Title:.*$/m, "")
    .replace(/^URL Source:.*$/m, "")
    .replace(/^Markdown Content:.*$/m, "")
    .trim();

  const links = new Set();
  const linkRegex = /\[(?:[^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let linkMatch = linkRegex.exec(markdown);
  while (linkMatch) {
    const normalized = canonicalizeUrl(linkMatch[1]);
    if (normalized) {
      links.add(normalized);
    }
    linkMatch = linkRegex.exec(markdown);
  }

  return {
    title,
    markdown,
    links: [...links]
  };
}

async function discoverSitemapUrls(origin, docsPathRoot, retries, retryDelayMs) {
  const candidateSitemaps = new Set([
    `${origin}/sitemap.xml`,
    `${origin}/robots.txt`
  ]);

  if (docsPathRoot !== "/") {
    candidateSitemaps.add(`${origin}${docsPathRoot}/sitemap.xml`);
    candidateSitemaps.add(`${origin}${docsPathRoot}/robots.txt`);
  }

  const nestedSitemaps = [];
  const pageUrls = new Set();
  const seenSitemapFiles = new Set();

  for (const candidate of candidateSitemaps) {
    if (candidate.endsWith("/robots.txt")) {
      try {
        const robotsText = await fetchText(candidate, retries, retryDelayMs);
        for (const fromRobots of parseRobotsSitemaps(robotsText)) {
          nestedSitemaps.push(fromRobots);
        }
      } catch {
        // Ignore robots.txt failures.
      }
    } else {
      nestedSitemaps.push(candidate);
    }
  }

  while (nestedSitemaps.length > 0) {
    const sitemapUrl = canonicalizeUrl(nestedSitemaps.shift(), origin);
    if (!sitemapUrl || seenSitemapFiles.has(sitemapUrl)) {
      continue;
    }
    seenSitemapFiles.add(sitemapUrl);

    let xmlText = "";
    try {
      xmlText = await fetchText(sitemapUrl, retries, retryDelayMs);
    } catch {
      continue;
    }

    const locs = parseLocValues(xmlText);
    for (const loc of locs) {
      const normalized = canonicalizeUrl(loc);
      if (!normalized) {
        continue;
      }
      if (normalized.toLowerCase().endsWith(".xml")) {
        nestedSitemaps.push(normalized);
        continue;
      }
      if (isDocUrlAllowed(normalized, origin, docsPathRoot)) {
        pageUrls.add(normalized);
      }
    }
  }

  return pageUrls;
}

function buildTurndown() {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined"
  });
  service.use(gfm);
  return service;
}

function extractMainMarkdown(html, pageUrl, turndown) {
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").first().text().trim() ||
    pageUrl;

  const primaryCandidates = [
    '[data-testid="page-content"]',
    "main",
    "article",
    '[role="main"]'
  ];

  let selected = null;
  for (const selector of primaryCandidates) {
    const candidate = $(selector).first();
    if (candidate.length > 0) {
      selected = candidate;
      break;
    }
  }

  if (selected === null) {
    selected = $("body").first();
  }

  const content = selected.clone();
  content.find("script,style,noscript,button,svg,form,iframe").remove();
  content.find("nav,aside").remove();

  content.find("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    const absolute = canonicalizeUrl(href, pageUrl);
    if (absolute) {
      $(element).attr("href", absolute);
    }
  });

  const contentHtml = content.html() || "";
  const markdown = turndown.turndown(contentHtml).trim();

  const links = new Set();
  $('a[href], link[rel="next"], link[rel="prev"], link[rel="canonical"]').each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    const absolute = canonicalizeUrl(href, pageUrl);
    if (absolute) {
      links.add(absolute);
    }
  });

  return {
    title,
    markdown,
    links: [...links]
  };
}

function toRelativeMarkdownPath(urlString, docsPathRoot) {
  const parsed = new URL(urlString);
  const pagePath = normalizePathname(parsed.pathname);

  let relativePath = "";
  if (docsPathRoot === "/") {
    relativePath = pagePath.slice(1);
  } else if (pagePath === docsPathRoot) {
    relativePath = "";
  } else {
    relativePath = pagePath.slice(docsPathRoot.length).replace(/^\/+/, "");
  }

  const segments = relativePath
    .split("/")
    .map((segment) => safeDecodeURIComponent(segment).trim())
    .filter(Boolean)
    .map(sanitizeSegment);

  if (segments.length === 0) {
    return "index.md";
  }

  const filename = `${segments.pop()}.md`;
  if (segments.length === 0) {
    return filename;
  }
  return path.join(...segments, filename);
}

function sortByDiscoveryIndex(entries) {
  return entries.sort((a, b) => a.discoveryIndex - b.discoveryIndex);
}

async function crawlAllPages(config) {
  const {
    startUrl,
    origin,
    docsPathRoot,
    retries,
    retryDelayMs,
    concurrency,
    fetchMode,
    jinaRpm,
    jinaApiKey
  } = config;

  const turndown = buildTurndown();
  const effectiveConcurrency = fetchMode === "direct" ? Math.max(concurrency, 1) : 1;
  const jinaDelayMs = Math.max(Math.ceil(60000 / jinaRpm), 3000);
  const discovered = new Set();
  const discoveryIndex = new Map();
  const queue = [];
  const pages = new Map();
  const failures = new Map();
  let indexCounter = 0;

  const enqueue = (urlString) => {
    if (!isDocUrlAllowed(urlString, origin, docsPathRoot)) {
      return;
    }
    if (discovered.has(urlString)) {
      return;
    }
    discovered.add(urlString);
    discoveryIndex.set(urlString, indexCounter);
    indexCounter += 1;
    queue.push(urlString);
  };

  enqueue(startUrl);

  const sitemapPages = await discoverSitemapUrls(origin, docsPathRoot, retries, retryDelayMs);
  for (const pageUrl of sitemapPages) {
    enqueue(pageUrl);
  }

  console.log(`Discovered from sitemap/seed: ${discovered.size} pages`);
  if (fetchMode !== "direct") {
    console.log(`Jina enabled: mode=${fetchMode}, rpm=${jinaRpm}, batch delay=${jinaDelayMs}ms`);
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, effectiveConcurrency);
    const results = await Promise.all(
      batch.map(async (urlString) => {
        try {
          if (fetchMode !== "direct") {
            try {
              const extracted = await fetchViaJina(urlString, retries, retryDelayMs, jinaApiKey);
              return {
                ok: true,
                requestedUrl: urlString,
                finalUrl: urlString,
                title: extracted.title,
                markdown: extracted.markdown,
                links: extracted.links,
                fetchStrategy: "jina"
              };
            } catch (jinaError) {
              if (fetchMode === "jina") {
                throw jinaError;
              }
            }
          }

          const response = await fetchWithRetry(urlString, retries, retryDelayMs);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const finalUrl = canonicalizeUrl(response.url) || urlString;
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
            throw new Error(`Unsupported content type "${contentType || "unknown"}"`);
          }

          const html = await response.text();
          const extracted = extractMainMarkdown(html, finalUrl, turndown);

          return {
            ok: true,
            requestedUrl: urlString,
            finalUrl,
            title: extracted.title,
            markdown: extracted.markdown,
            links: extracted.links,
            fetchStrategy: "direct"
          };
        } catch (error) {
          return {
            ok: false,
            requestedUrl: urlString,
            error
          };
        }
      })
    );

    for (const result of results) {
      if (!result.ok) {
        failures.set(result.requestedUrl, result.error?.message || String(result.error));
        continue;
      }

      const finalUrl = result.finalUrl;

      if (finalUrl !== result.requestedUrl && !discovered.has(finalUrl)) {
        enqueue(finalUrl);
      }

      pages.set(result.requestedUrl, {
        sourceUrl: result.finalUrl,
        title: result.title,
        markdown: result.markdown,
        discoveryIndex: discoveryIndex.get(result.requestedUrl) ?? Number.MAX_SAFE_INTEGER
      });

      for (const link of result.links) {
        enqueue(link);
      }
    }

    console.log(`Progress: downloaded ${pages.size}/${discovered.size}, queue=${queue.length}`);
    if (queue.length > 0 && fetchMode !== "direct") {
      await wait(jinaDelayMs);
    }
  }

  // Strict mode disabled: continue even if some pages failed to download
  // Log failures for visibility but don't fail the whole process
  if (failures.size > 0) {
    const lines = [...failures.entries()]
      .slice(0, 20)
      .map(([urlString, reason]) => `- ${urlString} -> ${reason}`);
    console.log(`Warning: ${failures.size} pages failed to download:`);
    console.log(lines.join("\n"));
  }

  // Log skipped pages but don't fail
  const missing = [...discovered].filter((urlString) => !pages.has(urlString));
  if (missing.length > 0) {
    const preview = missing.slice(0, 20);
    console.log(`Warning: ${missing.length} discovered pages were not downloaded:`);
    console.log(preview.join("\n"));
  }

  return {
    entries: sortByDiscoveryIndex(
      [...pages.entries()].map(([urlString, data]) => ({
        url: urlString,
        ...data
      }))
    )
  };
}

function ensureMarkdownContent(content, urlString) {
  if (content && content.trim()) {
    return content.trim();
  }
  return `> No extractable markdown content was found.\n\nSource: ${urlString}`;
}

async function writeManyFiles(entries, outputDir, docsPathRoot) {
  const collisionGuard = new Map();

  for (const entry of entries) {
    const relativeFile = toRelativeMarkdownPath(entry.url, docsPathRoot);
    const targetFile = path.join(outputDir, relativeFile);

    if (collisionGuard.has(targetFile) && collisionGuard.get(targetFile) !== entry.url) {
      throw new Error(
        `Output file collision detected: ${targetFile}\n- ${collisionGuard.get(targetFile)}\n- ${entry.url}`
      );
    }
    collisionGuard.set(targetFile, entry.url);

    const header = [
      `<!-- Source: ${entry.sourceUrl} -->`,
      `<!-- Title: ${entry.title.replace(/\r?\n/g, " ").trim()} -->`,
      ""
    ].join("\n");

    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, `${header}${ensureMarkdownContent(entry.markdown, entry.sourceUrl)}\n`, "utf8");
  }
}

function buildOneFile(entries) {
  const lines = ["# Full Documentation", ""];

  lines.push("## Pages", "");
  for (const entry of entries) {
    lines.push(`- [${entry.title}](${entry.sourceUrl})`);
  }
  lines.push("");

  for (const entry of entries) {
    lines.push(`## ${entry.title}`, "");
    lines.push(`Source: ${entry.sourceUrl}`, "");
    lines.push(ensureMarkdownContent(entry.markdown, entry.sourceUrl), "", "---", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeOutputs(config, crawlResult) {
  const {
    mode,
    outputRootDir,
    hostOutputDir,
    docsPathRoot
  } = config;

  const finalDir = path.resolve(outputRootDir, hostOutputDir);
  await fs.mkdir(finalDir, { recursive: true });

  if (mode === "manyfiles") {
    await writeManyFiles(crawlResult.entries, finalDir, docsPathRoot);
    console.log(`Saved ${crawlResult.entries.length} pages to ${finalDir}`);
    return;
  }

  const oneFilePath = path.join(finalDir, "full-docs.md");
  const content = buildOneFile(crawlResult.entries);
  await fs.writeFile(oneFilePath, content, "utf8");
  console.log(`Saved ${crawlResult.entries.length} pages to ${oneFilePath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const docsUrl = requireValue("url", args.url || process.env.DOCS_URL);
  const mode = normalizeMode(args.mode || process.env.DOCS_MODE || "manyfiles");
  const outputRootDir = args.out || process.env.DOCS_OUTPUT_DIR || "docs-results";
  const retries = parseNumber(args.retries || process.env.DOCS_RETRIES, 3);
  const retryDelayMs = parseNumber(args["retry-delay-ms"] || process.env.DOCS_RETRY_DELAY_MS, 1000);
  const concurrency = parseNumber(args.concurrency || process.env.DOCS_CONCURRENCY, 5);
  const fetchMode = normalizeFetchMode(args["fetch-mode"] || process.env.DOCS_FETCH_MODE || "auto");
  const jinaRpm = parseNumber(args["jina-rpm"] || process.env.DOCS_JINA_RPM, 20);
  const jinaApiKey = args["jina-key"] || process.env.DOCS_JINA_KEY || "";

  const normalizedStart = normalizeUrl(docsUrl);
  const startUrlParsed = new URL(normalizedStart);
  const origin = startUrlParsed.origin;
  const docsPathRoot = normalizePathname(startUrlParsed.pathname);
  const hostOutputDir = hostFolderName(startUrlParsed.hostname);

  console.log(`Start URL: ${normalizedStart}`);
  console.log(`Mode: ${mode}`);
  console.log(`Fetch mode: ${fetchMode}`);
  console.log(`Output root: ${path.resolve(outputRootDir)}`);
  console.log(`Doc root path: ${docsPathRoot}`);

  const crawlResult = await crawlAllPages({
    startUrl: normalizedStart,
    origin,
    docsPathRoot,
    retries,
    retryDelayMs,
    concurrency,
    fetchMode,
    jinaRpm,
    jinaApiKey
  });

  await writeOutputs(
    {
      mode,
      outputRootDir,
      hostOutputDir,
      docsPathRoot
    },
    crawlResult
  );
}

main().catch((error) => {
  console.error("docs-downloader failed.");
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
