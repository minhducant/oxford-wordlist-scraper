/**
 * Cambridge Dictionary Crawler
 *
 * Reads words from output/oxford_words.json (or --word / --input flag),
 * fetches each word's Cambridge Dictionary page, and extracts:
 *   - Part of speech
 *   - UK / US IPA pronunciation
 *   - UK / US audio URLs
 *   - Definitions + example sentences
 *   - CEFR level (if shown on the page)
 *
 * Output:
 *   output/cambridge_words.json  — full structured data
 *   output/cambridge_words.csv   — flat CSV (first definition per entry)
 *
 * Progress is saved to output/cambridge_checkpoint.json after every
 * --batch (default 50) words, so the run is fully resumable.
 *
 * Usage:
 *   npx ts-node crawl_cambridge.ts                        # enrich all Oxford words
 *   npx ts-node crawl_cambridge.ts --level b2             # only B2 words
 *   npx ts-node crawl_cambridge.ts --word "abandon"       # single word lookup
 *   npx ts-node crawl_cambridge.ts --limit 200            # first 200 words
 *   npx ts-node crawl_cambridge.ts --delay 800            # ms between requests
 *   npx ts-node crawl_cambridge.ts --no-resume            # start fresh
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Definition {
  sense: string;
  examples: string[];
  cefrLevel?: string;
}

interface Pronunciation {
  region: 'uk' | 'us';
  ipa: string;
  audioUrl?: string;
}

interface CambridgeEntry {
  pos: string;
  pronunciations: Pronunciation[];
  definitions: Definition[];
  cefrLevel?: string;
}

interface CambridgeWordResult {
  word: string;
  url: string;
  entries: CambridgeEntry[];
  fetchedAt: string;
  error?: string;
}

interface Checkpoint {
  processed: string[];
  lastUpdated: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CAMBRIDGE_BASE = 'https://dictionary.cambridge.org';
const DICT_URL = `${CAMBRIDGE_BASE}/dictionary/english`;
const OUTPUT_DIR = path.resolve('./output');
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, 'cambridge_checkpoint.json');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'cambridge_words.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'cambridge_words.csv');

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠  ${msg}`);

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchHtml(url: string, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 404) return '';
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1500 * attempt);
    }
  }
  return '';
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Cambridge HTML structure (simplified):
 *
 * <div class="pr entry-body__el">
 *   <div class="pos-header dpos-h">
 *     <span class="hw dhw">abandon</span>
 *     <span class="pos dpos">verb</span>
 *   </div>
 *   <span class="uk dpron-i">
 *     <span class="ipa dipa">/əˈbæn.dən/</span>
 *     <source src="...uk_pron...mp3" type="audio/mpeg">
 *   </span>
 *   <span class="us dpron-i">
 *     <span class="ipa dipa">/əˈbæn.dən/</span>
 *     <source src="...us_pron...mp3" type="audio/mpeg">
 *   </span>
 *   <div class="sense-body dsense_b">
 *     <div class="def-block ddef_block">
 *       <div class="def ddef_d db">to leave a place, thing, or person forever:</div>
 *       <span class="eg deg">He abandoned his car on the motorway.</span>
 *       <span class="epp-xref B2">B2</span>
 *     </div>
 *   </div>
 * </div>
 */
function parsePage(html: string, word: string, url: string): CambridgeWordResult {
  if (!html) {
    return { word, url, entries: [], fetchedAt: new Date().toISOString(), error: 'not found' };
  }

  const entries: CambridgeEntry[] = [];

  // Split into entry blocks (one per POS)
  // Each block starts with entry-body__el and ends before the next one or end of body
  const rawBlocks = html.split(/(?=<div[^>]+class="[^"]*\bentry-body__el\b)/);

  for (const block of rawBlocks) {
    if (!block.includes('entry-body__el')) continue;

    // ── POS ───────────────────────────────────────────────────────────────────
    const posMatch = block.match(/<span[^>]+class="[^"]*\bpos\s+dpos\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    const pos = posMatch ? posMatch[1].trim() : '';
    if (!pos) continue;

    // ── CEFR level (entry level, from header area) ────────────────────────────
    // Appears as <span class="epp-xref B2">B2</span>
    const entryCefrMatch = block.match(/<span[^>]+class="[^"]*\bepp-xref\s+([A-C][12])\b[^"]*"[^>]*>([^<]+)<\/span>/i);
    const entryLevel = entryCefrMatch ? entryCefrMatch[2].trim().toUpperCase() : undefined;

    // ── Pronunciations ────────────────────────────────────────────────────────
    const pronunciations: Pronunciation[] = [];

    const regions: Array<'uk' | 'us'> = ['uk', 'us'];
    for (const region of regions) {
      // Find the region span
      const regionPattern = new RegExp(
        `<span[^>]+class="[^"]*\\b${region}\\s+dpron-i\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>\\s*<\\/div>`,
        'i',
      );
      const regionMatch = block.match(regionPattern);
      if (!regionMatch) continue;

      const regionBlock = regionMatch[1];

      const ipaMatch = regionBlock.match(/<span[^>]+class="[^"]*\bipa\s+dipa\b[^"]*"[^>]*>([^<]+)<\/span>/i);
      const ipa = ipaMatch ? ipaMatch[1].trim() : '';
      if (!ipa) continue;

      const srcMatch = regionBlock.match(/<source[^>]+src="([^"]+\.mp3)"/i);
      const audioUrl = srcMatch ? srcMatch[1] : undefined;

      pronunciations.push({ region, ipa, audioUrl });
    }

    // ── Definitions ───────────────────────────────────────────────────────────
    const definitions: Definition[] = [];

    // Split on def-block boundaries
    const defBlocks = block.split(/(?=<div[^>]+class="[^"]*\bddef_block\b)/);

    for (const defBlock of defBlocks) {
      if (!defBlock.includes('ddef_block')) continue;

      // Definition text (may contain nested tags — strip them)
      const defMatch = defBlock.match(/<div[^>]+class="[^"]*\bdef\s+ddef_d\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (!defMatch) continue;
      const sense = stripTags(defMatch[1]);
      if (!sense) continue;

      // Examples
      const egMatches = [...defBlock.matchAll(/<span[^>]+class="[^"]*\beg\s+deg\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
      const examples = egMatches.map(m => stripTags(m[1])).filter(Boolean);

      // Per-definition CEFR level
      const defCefrMatch = defBlock.match(/<span[^>]+class="[^"]*\bepp-xref\s+([A-C][12])\b[^"]*"[^>]*>([^<]+)<\/span>/i);
      const cefrLevel = defCefrMatch ? defCefrMatch[2].trim().toUpperCase() : undefined;

      definitions.push({ sense, examples, ...(cefrLevel ? { cefrLevel } : {}) });
    }

    if (definitions.length === 0) continue;

    entries.push({
      pos,
      pronunciations,
      definitions,
      ...(entryLevel ? { cefrLevel: entryLevel } : {}),
    });
  }

  return { word, url, entries, fetchedAt: new Date().toISOString() };
}

// ─── Serialize ────────────────────────────────────────────────────────────────

function resultsToCsv(results: CambridgeWordResult[]): string {
  const header = 'word,pos,cefr_level,uk_ipa,us_ipa,uk_audio,us_audio,definition,example';
  const rows: string[] = [header];

  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;

  for (const r of results) {
    if (r.error || r.entries.length === 0) {
      rows.push(`${esc(r.word)},,,,,,,,`);
      continue;
    }
    for (const entry of r.entries) {
      const ukP = entry.pronunciations.find(p => p.region === 'uk');
      const usP = entry.pronunciations.find(p => p.region === 'us');
      const firstDef = entry.definitions[0];
      rows.push(
        [
          esc(r.word),
          esc(entry.pos),
          esc(entry.cefrLevel ?? ''),
          esc(ukP?.ipa ?? ''),
          esc(usP?.ipa ?? ''),
          esc(ukP?.audioUrl ?? ''),
          esc(usP?.audioUrl ?? ''),
          esc(firstDef?.sense ?? ''),
          esc(firstDef?.examples[0] ?? ''),
        ].join(','),
      );
    }
  }
  return rows.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCLI() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        level: { type: 'string' },
        word: { type: 'string' },
        input: { type: 'string' },
        limit: { type: 'string' },
        delay: { type: 'string', default: '600' },
        batch: { type: 'string', default: '50' },
        resume: { type: 'boolean', default: true },
      },
    });
    return {
      level: values.level as string | undefined,
      word: values.word as string | undefined,
      input: values.input as string | undefined,
      limit: values.limit ? parseInt(values.limit as string) : undefined,
      delay: parseInt((values.delay as string) ?? '600'),
      batch: parseInt((values.batch as string) ?? '50'),
      resume: values.resume as boolean,
    };
  } catch {
    return { delay: 600, batch: 50, resume: true };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCLI();
  ensureDir(OUTPUT_DIR);

  // 1. Build word list
  let words: string[] = [];

  if (args.word) {
    words = [args.word];
  } else if (args.input) {
    const raw = fs.readFileSync(path.resolve(args.input), 'utf-8');
    words = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } else {
    const oxfordFile = path.join(OUTPUT_DIR, 'oxford_words.json');
    if (!fs.existsSync(oxfordFile)) {
      console.error('output/oxford_words.json not found. Run crawl.ts first, or pass --word / --input.');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(oxfordFile, 'utf-8'));
    let oxWords: Array<{ word: string; level: string }> = data.words ?? [];

    if (args.level) {
      oxWords = oxWords.filter(w => w.level === args.level!.toLowerCase());
      log(`Filtered to level ${args.level.toUpperCase()}: ${oxWords.length} entries`);
    }

    // Deduplicate — same word may appear with multiple POS
    const seen = new Set<string>();
    for (const w of oxWords) {
      if (!seen.has(w.word)) {
        seen.add(w.word);
        words.push(w.word);
      }
    }
  }

  if (args.limit) words = words.slice(0, args.limit);

  log(`Cambridge Dictionary Crawler starting — ${words.length} unique words`);
  log(`Delay: ${args.delay}ms | Batch checkpoint: every ${args.batch}`);

  // 2. Load checkpoint + existing results
  const checkpoint: Checkpoint =
    args.resume && fs.existsSync(CHECKPOINT_PATH)
      ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'))
      : { processed: [], lastUpdated: '' };

  const processedSet = new Set(checkpoint.processed);

  const results: CambridgeWordResult[] = fs.existsSync(OUTPUT_JSON)
    ? JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf-8'))
    : [];

  const remaining = words.filter(w => !processedSet.has(w));
  log(`Already done: ${processedSet.size} | Remaining: ${remaining.length}`);
  if (remaining.length === 0) {
    log('Nothing to do — all words already processed. Use --no-resume to restart.');
    return;
  }

  // 3. Crawl
  let done = 0;
  for (const word of remaining) {
    const url = `${DICT_URL}/${encodeURIComponent(word)}`;
    const tag = `[${++done}/${remaining.length}]`;

    try {
      process.stdout.write(`${tag} ${word.padEnd(24)} `);
      const html = await fetchHtml(url);
      const result = parsePage(html, word, url);
      results.push(result);
      processedSet.add(word);

      const defCount = result.entries.reduce((n, e) => n + e.definitions.length, 0);
      if (result.error) {
        console.log(`— ${result.error}`);
      } else {
        console.log(`✓  ${result.entries.length} entr, ${defCount} def`);
      }
    } catch (err) {
      console.log(`✗  ${err}`);
      results.push({ word, url, entries: [], fetchedAt: new Date().toISOString(), error: String(err) });
      processedSet.add(word);
    }

    // Checkpoint
    if (done % args.batch === 0) {
      saveProgress(results, processedSet);
      log(`Checkpoint saved (${done} done)`);
    }

    await sleep(args.delay);
  }

  // 4. Final save
  saveProgress(results, processedSet);

  const withEntries = results.filter(r => r.entries.length > 0).length;
  console.log('\n┌──────────────────────────────────────────┐');
  console.log('│     Cambridge Dictionary — Summary        │');
  console.log('├─────────────────────┬────────────────────┤');
  console.log(`│ Total words         │ ${String(results.length).padEnd(18)} │`);
  console.log(`│ With entries        │ ${String(withEntries).padEnd(18)} │`);
  console.log(`│ Not found / errors  │ ${String(results.length - withEntries).padEnd(18)} │`);
  console.log('└─────────────────────┴────────────────────┘');
  log('Done! ✓');
}

function saveProgress(results: CambridgeWordResult[], processedSet: Set<string>): void {
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2), 'utf-8');
  fs.writeFileSync(OUTPUT_CSV, resultsToCsv(results), 'utf-8');
  fs.writeFileSync(
    CHECKPOINT_PATH,
    JSON.stringify({ processed: [...processedSet], lastUpdated: new Date().toISOString() }, null, 2),
    'utf-8',
  );
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
