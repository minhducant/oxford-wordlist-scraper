/**
 * Oxford 3000/5000 Word List Crawler
 *
 * Crawls: https://www.oxfordlearnersdictionaries.com/wordlists/oxford3000-5000
 *
 * Output:
 *   output/oxford_words.json   — full structured data
 *   output/oxford_words.csv    — flat CSV (word, level, pos, url)
 *   output/oxford_A1.txt       — one file per CEFR level (word TAB pos)
 *   output/oxford_A2.txt
 *   output/oxford_B1.txt
 *   output/oxford_B2.txt
 *   output/oxford_C1.txt
 *
 * Usage:
 *   npx ts-node crawl.ts
 *   npx ts-node crawl.ts --level b2          # filter by level
 *   npx ts-node crawl.ts --format json       # json | csv | txt | all (default: all)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

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

const FETCH_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
};

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
};

const warn = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.warn(`[${ts}] ⚠  ${msg}`);
};

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  log(`GET ${url}`);
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  log(`Received ${(html.length / 1024).toFixed(1)} KB`);
  return html;
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Real HTML structure of the Oxford word list page:
 *
 * <ul class="top-g">
 *   <li>
 *     <div class="top-container">
 *       <div class="top-g">
 *         <span class="belong-to oxford5000"></span>
 *         <div class="top-g-header">
 *           <a class="headword" href="/definition/english/abandon_1">abandon</a>
 *           <span class="pos">verb</span>
 *         </div>
 *         <div class="symbols">
 *           <span class="ox5k-label label" data-ox5kband="b2">B2</span>
 *         </div>
 *       </div>
 *     </div>
 *   </li>
 * </ul>
 */
function parseWordList(html: string): WordEntry[] {
  const words: WordEntry[] = [];
  const liBlocks = html.match(/<li[^>]+data-hw="[^"]+"[\s\S]*?<\/li>/g) ?? [];
  log(`Found ${liBlocks.length} word-entry <li> blocks, parsing...`);

  for (const li of liBlocks) {
    // ── Word ──────────────────────────────────────────────────────────────────
    const hwMatch = li.match(/data-hw="([^"]+)"/i);
    if (!hwMatch) continue;
    const word = hwMatch[1].trim().toLowerCase();
    if (!word) continue;

    // ── URL ───────────────────────────────────────────────────────────────────
    const urlMatch = li.match(/href="(\/definition\/[^"]+)"/i);
    const url = urlMatch ? urlMatch[1] : '';

    // ── Part of speech ────────────────────────────────────────────────────────
    const posMatch = li.match(/<span[^>]+class="[^"]*\bpos\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    const pos = posMatch ? posMatch[1].trim() : 'unknown';

    // ── CEFR level (data-ox3000 / data-ox5000 / belong-to span) ──────────────
    const levelMatch =
      li.match(/data-ox3000="([^"]+)"/i) ??
      li.match(/data-ox5000="([^"]+)"/i) ??
      li.match(/<span[^>]+class="[^"]*\bbelong-to\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    if (!levelMatch) continue;

    const level = levelMatch[1].trim().toLowerCase() as CefrLevel;
    if (!CEFR_LEVELS.includes(level)) continue;

    // ── Audio URLs ────────────────────────────────────────────────────────────
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
    // Same word can appear with different POS — keep all unique combos
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
  log(`✓ JSON saved → ${p}`);
}

function saveCsv(result: CrawlResult): void {
  const p = path.join(OUTPUT_DIR, 'oxford_words.csv');
  const header = 'word,level,pos,url,audioUk,audioUs';
  const rows = result.words.map(w =>
    `${w.word},${w.level},${w.pos},${w.url},${w.audioUk ?? ''},${w.audioUs ?? ''}`
  );
  fs.writeFileSync(p, [header, ...rows].join('\n'), 'utf-8');
  log(`✓ CSV saved  → ${p} (${result.words.length} rows)`);
}

function saveTxtPerLevel(result: CrawlResult): void {
  for (const level of CEFR_LEVELS) {
    const levelWords = result.byLevel[level];
    if (levelWords.length === 0) continue;
    const p = path.join(OUTPUT_DIR, `oxford_${level.toUpperCase()}.txt`);
    const lines = levelWords.map(w => `${w.word}\t${w.pos}`);
    fs.writeFileSync(p, lines.join('\n'), 'utf-8');
    log(`✓ TXT saved  → ${p} (${levelWords.length} words)`);
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
  log('Oxford 3000/5000 Crawler starting...');
  if (args.level) log(`Filter: level = ${args.level.toUpperCase()}`);

  // 1. Fetch
  let html: string;
  try {
    html = await fetchHtml(SOURCE_URL);
  } catch (err) {
    console.error(`\nFailed to fetch page: ${err}`);
    console.error('Check your network connection and try again.\n');
    process.exit(1);
  }

  // 2. Parse
  const rawWords = parseWordList(html);
  log(`Parsed ${rawWords.length} raw entries`);

  if (rawWords.length === 0) {
    warn('No words found — the page structure may have changed.');
    ensureDir(OUTPUT_DIR);
    const htmlPath = path.join(OUTPUT_DIR, 'page.html');
    fs.writeFileSync(htmlPath, html, 'utf-8');
    warn(`Raw HTML saved → ${htmlPath}`);

    // Print the first <li> that looks like a word entry
    const sample = (html.match(/<li[\s\S]*?<\/li>/g) ?? [])
      .find(li => li.includes('/definition/') || li.includes('headword'));
    if (sample) {
      console.error('\nFirst candidate <li> block:\n');
      console.error(sample.slice(0, 1000));
    }
    process.exit(1);
  }

  // 3. Dedup + optional filter
  let words = deduplicateWords(rawWords);
  log(`After dedup: ${words.length} unique entries`);

  if (args.level) {
    words = words.filter(w => w.level === args.level);
    log(`After filter (${args.level}): ${words.length} words`);
  }

  // 4. Build result
  const result: CrawlResult = {
    crawledAt: new Date().toISOString(),
    source: SOURCE_URL,
    total: words.length,
    words,
    byLevel: groupByLevel(words),
  };

  // 5. Save
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