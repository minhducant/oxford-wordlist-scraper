/**
 * Oxford 3000/5000 Word List Crawler — Browser mode
 *
 * Dùng Puppeteer để bypass bot protection (403) của Oxford.
 * Cần: npm install puppeteer
 *
 * Usage:
 *   npx ts-node crawl-browser.ts
 *   npx ts-node crawl-browser.ts --level b2
 *   npx ts-node crawl-browser.ts --format json
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import puppeteer, { type Page } from 'puppeteer';

// ─── Types ────────────────────────────────────────────────────────────────────

type CefrLevel = 'a1' | 'a2' | 'b1' | 'b2' | 'c1';

interface WordEntry {
  word: string;
  pos: string;
  level: CefrLevel;
  url: string;
  audioUk?: string;
  audioUs?: string;
}

interface CrawlResult {
  crawledAt: string;
  source: string;
  total: number;
  words: WordEntry[];
  byLevel: Record<CefrLevel, WordEntry[]>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_URL = 'https://www.oxfordlearnersdictionaries.com/wordlists/oxford3000-5000';
const OUTPUT_DIR = path.resolve('./output');
const CEFR_LEVELS: CefrLevel[] = ['a1', 'a2', 'b1', 'b2', 'c1'];

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
};

// ─── Fetch via Puppeteer ──────────────────────────────────────────────────────

async function fetchWithBrowser(): Promise<string> {
  log('Launching headless browser...');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Mimic a real browser
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    log(`Navigating to ${SOURCE_URL}`);
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Wait for the word list to render
    log('Waiting for word list to render...');
    await page.waitForSelector('li', { timeout: 15_000 });

    // Scroll to bottom to trigger lazy loading (if any)
    await autoScroll(page);

    const html = await page.content();
    log(`Page HTML: ${(html.length / 1024).toFixed(1)} KB`);
    return html;
  } finally {
    await browser.close();
    log('Browser closed');
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let totalHeight = 0;
      const distance = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
  // Give time for any lazy-loaded content
  await new Promise(r => setTimeout(r, 2000));
  log('Auto-scroll complete');
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parseWordList(html: string): WordEntry[] {
  const words: WordEntry[] = [];
  const liBlocks = html.match(/<li[^>]+data-hw="[^"]+"[\s\S]*?<\/li>/g) ?? [];
  log(`Found ${liBlocks.length} word-entry <li> blocks`);

  for (const li of liBlocks) {
    const hwMatch = li.match(/data-hw="([^"]+)"/i);
    if (!hwMatch) continue;
    const word = hwMatch[1].trim().toLowerCase();
    if (!word) continue;

    const urlMatch = li.match(/href="(\/definition\/[^"]+)"/i);
    const url = urlMatch ? urlMatch[1] : '';

    const posMatch = li.match(/<span[^>]+class="[^"]*\bpos\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    const pos = posMatch ? posMatch[1].trim() : 'unknown';

    const levelMatch =
      li.match(/data-ox3000="([^"]+)"/i) ??
      li.match(/data-ox5000="([^"]+)"/i) ??
      li.match(/<span[^>]+class="[^"]*\bbelong-to\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    if (!levelMatch) continue;

    const level = levelMatch[1].trim().toLowerCase() as CefrLevel;
    if (!CEFR_LEVELS.includes(level)) continue;

    const mp3s = [...li.matchAll(/data-src-mp3="([^"]+)"/gi)].map(m => m[1]);
    const base = 'https://www.oxfordlearnersdictionaries.com';
    const audioUk = mp3s.find(u => u.includes('uk_pron')) ? base + mp3s.find(u => u.includes('uk_pron'))! : undefined;
    const audioUs = mp3s.find(u => u.includes('us_pron')) ? base + mp3s.find(u => u.includes('us_pron'))! : undefined;

    words.push({ word, pos, level, url, audioUk, audioUs });
  }

  return words;
}

// ─── Transform ────────────────────────────────────────────────────────────────

function deduplicateWords(words: WordEntry[]): WordEntry[] {
  const seen = new Set<string>();
  return words.filter(w => {
    const key = `${w.word}__${w.pos}__${w.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupByLevel(words: WordEntry[]): Record<CefrLevel, WordEntry[]> {
  return CEFR_LEVELS.reduce(
    (acc, level) => {
      acc[level] = words.filter(w => w.level === level);
      return acc;
    },
    {} as Record<CefrLevel, WordEntry[]>,
  );
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveJson(result: CrawlResult): void {
  const p = path.join(OUTPUT_DIR, 'oxford_words.json');
  fs.writeFileSync(p, JSON.stringify(result, null, 2), 'utf-8');
  log(`✓ JSON → ${p}`);
}

function saveCsv(result: CrawlResult): void {
  const p = path.join(OUTPUT_DIR, 'oxford_words.csv');
  const rows = result.words.map(w => `${w.word},${w.level},${w.pos},${w.url}`);
  fs.writeFileSync(p, ['word,level,pos,url', ...rows].join('\n'), 'utf-8');
  log(`✓ CSV  → ${p}`);
}

function saveTxtPerLevel(result: CrawlResult): void {
  for (const level of CEFR_LEVELS) {
    const lw = result.byLevel[level];
    if (!lw.length) continue;
    const p = path.join(OUTPUT_DIR, `oxford_${level.toUpperCase()}.txt`);
    fs.writeFileSync(p, lw.map(w => `${w.word}\t${w.pos}`).join('\n'), 'utf-8');
    log(`✓ TXT  → ${p} (${lw.length} words)`);
  }
}

function printSummary(result: CrawlResult): void {
  console.log('\n┌──────────────────────────────────────┐');
  console.log('│       Oxford 3000/5000 Summary        │');
  console.log('├───────────────┬──────────────────────┤');
  console.log(`│ Total words   │ ${String(result.total).padEnd(20)} │`);
  console.log('├───────────────┼──────────────────────┤');
  for (const level of CEFR_LEVELS) {
    const count = result.byLevel[level]?.length ?? 0;
    console.log(`│ ${level.toUpperCase().padEnd(13)} │ ${String(count).padEnd(20)} │`);
  }
  console.log('└───────────────┴──────────────────────┘\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCLIArgs(): { level?: CefrLevel; format: string } {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        level: { type: 'string' },
        format: { type: 'string', default: 'all' },
      },
    });
    return {
      level: values.level as CefrLevel | undefined,
      format: (values.format as string) ?? 'all',
    };
  } catch {
    return { format: 'all' };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCLIArgs();
  log('Oxford 3000/5000 Crawler (browser mode) starting...');
  if (args.level) log(`Filter: level = ${args.level.toUpperCase()}`);

  const html = await fetchWithBrowser();

  const rawWords = parseWordList(html);
  log(`Parsed ${rawWords.length} raw entries`);

  if (rawWords.length === 0) {
    console.error('No words found — inspect page.html to debug');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'page.html'), html, 'utf-8');
    process.exit(1);
  }

  let words = deduplicateWords(rawWords);
  log(`After dedup: ${words.length} unique entries`);

  if (args.level) {
    words = words.filter(w => w.level === args.level);
    log(`After filter (${args.level}): ${words.length} words`);
  }

  const result: CrawlResult = {
    crawledAt: new Date().toISOString(),
    source: SOURCE_URL,
    total: words.length,
    words,
    byLevel: groupByLevel(words),
  };

  ensureDir(OUTPUT_DIR);
  const fmt = args.format.toLowerCase();
  if (fmt === 'json' || fmt === 'all') saveJson(result);
  if (fmt === 'csv' || fmt === 'all') saveCsv(result);
  if (fmt === 'txt' || fmt === 'all') saveTxtPerLevel(result);

  printSummary(result);
  log('Done! ✓');
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});