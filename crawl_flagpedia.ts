/**
 * Flagpedia Country Flags Scraper
 *
 * Fetches all 254 country flag entries from flagpedia.net/index
 * and downloads the flag images to output/flags/.
 *
 * Fields collected per country:
 *   name, slug, isoCode, flagUrl, localPath, pageUrl, area (km²), population
 *
 * Output:
 *   output/flagpedia_countries.json  — full structured data
 *   output/flagpedia_countries.csv   — flat CSV
 *   output/flags/                    — downloaded flag images
 *
 * Usage:
 *   npx ts-node crawl_flagpedia.ts
 *   npx ts-node crawl_flagpedia.ts --no-images       # skip image download
 *   npx ts-node crawl_flagpedia.ts --no-headless     # show browser
 *   npx ts-node crawl_flagpedia.ts --concurrency 10  # parallel downloads (default: 5)
 */

import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { parseArgs } from 'util';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CountryFlag {
  name: string;
  slug: string;
  isoCode: string;
  flagUrl: string;
  localPath: string | null;
  pageUrl: string;
  area: number | null;
  population: number | null;
}

interface FlagpediaResult {
  source: string;
  crawledAt: string;
  total: number;
  countries: CountryFlag[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://flagpedia.net';
const INDEX_URL = `${BASE_URL}/index`;
const OUTPUT_DIR = path.resolve('./output');
const FLAGS_DIR = path.join(OUTPUT_DIR, 'flags');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'flagpedia_countries.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'flagpedia_countries.csv');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠  ${msg}`);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resultToCsv(result: FlagpediaResult): string {
  const header = 'name,slug,iso_code,area_km2,population,flag_url,local_path,page_url';
  const esc = (s: string | number | null) =>
    `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = result.countries.map(c =>
    [
      esc(c.name),
      esc(c.slug),
      esc(c.isoCode),
      esc(c.area),
      esc(c.population),
      esc(c.flagUrl),
      esc(c.localPath),
      esc(c.pageUrl),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

/** Download a single URL to destPath, following redirects. */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        downloadFile(res.headers.location!, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/** Run async tasks with a concurrency limit. */
async function pLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCLI() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        headless: { type: 'boolean', default: true },
        images: { type: 'boolean', default: true },
        concurrency: { type: 'string', default: '5' },
      },
    });
    return {
      headless: values.headless as boolean,
      images: values.images as boolean,
      concurrency: parseInt(values.concurrency as string, 10) || 5,
    };
  } catch {
    return { headless: true, images: true, concurrency: 5 };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCLI();
  ensureDir(OUTPUT_DIR);
  if (args.images) ensureDir(FLAGS_DIR);

  log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: args.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let countries: CountryFlag[] = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 900 });

    log(`Navigating to ${INDEX_URL}`);
    await page.goto(INDEX_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    log('Waiting for flag grid...');
    await page.waitForSelector('.flag-grid li a', { timeout: 30000 }).catch(() => {
      warn('Flag grid selector timed out — trying to extract anyway');
    });

    const raw = await page.evaluate((baseUrl: string) => {
      const items = [...document.querySelectorAll('.flag-grid li a')];
      return items.map(a => {
        const href = a.getAttribute('href') ?? '';
        const slug = href.replace(/^\//, '');
        const name = (a.querySelector('span')?.textContent ?? '').trim();
        const img = a.querySelector('img');
        const imgSrc = img?.getAttribute('src') ?? '';
        const srcset = img?.getAttribute('srcset') ?? '';
        const hqSrc = srcset.split(' ')[0] || imgSrc;
        const flagUrl = hqSrc.startsWith('http') ? hqSrc : `${baseUrl}${hqSrc}`;
        const area = a.getAttribute('data-area');
        const population = a.getAttribute('data-population');
        const codeMatch = (imgSrc || hqSrc).match(/\/([^/]+)\.(png|webp|svg)/);
        const isoCode = codeMatch ? codeMatch[1].split('?')[0] : '';
        return {
          name,
          slug,
          isoCode,
          flagUrl,
          pageUrl: `${baseUrl}${href}`,
          area: area ? parseFloat(area) : null,
          population: population ? parseFloat(population) : null,
        };
      });
    }, BASE_URL);

    if (raw.length === 0) {
      warn('No country entries extracted. The page structure may have changed.');
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'flagpedia_debug.png'), fullPage: true });
      warn('Debug screenshot saved to output/flagpedia_debug.png');
    }

    countries = raw.map(c => ({ ...c, localPath: null }));
  } finally {
    await browser.close();
  }

  // ── Download images ──────────────────────────────────────────────────────────
  if (args.images && countries.length > 0) {
    log(`Downloading ${countries.length} flag images (concurrency: ${args.concurrency})...`);
    let done = 0;
    let failed = 0;

    const tasks = countries.map((country, i) => async () => {
      const ext = country.flagUrl.split('?')[0].split('.').pop() ?? 'webp';
      const filename = `${country.isoCode}.${ext}`;
      const destPath = path.join(FLAGS_DIR, filename);

      // Skip if already downloaded
      if (fs.existsSync(destPath)) {
        countries[i].localPath = `output/flags/${filename}`;
        done++;
        return;
      }

      try {
        await downloadFile(country.flagUrl, destPath);
        countries[i].localPath = `output/flags/${filename}`;
        done++;
      } catch (err) {
        warn(`Failed to download ${country.name}: ${(err as Error).message}`);
        failed++;
      }

      if ((done + failed) % 20 === 0 || done + failed === countries.length) {
        process.stdout.write(`\r  Progress: ${done + failed}/${countries.length} (${failed} failed)   `);
      }
    });

    await pLimit(tasks, args.concurrency);
    process.stdout.write('\n');
    log(`Images downloaded: ${done} OK, ${failed} failed`);
  }

  // ── Write output ─────────────────────────────────────────────────────────────
  const result: FlagpediaResult = {
    source: INDEX_URL,
    crawledAt: new Date().toISOString(),
    total: countries.length,
    countries,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(OUTPUT_CSV, resultToCsv(result), 'utf-8');

  const imagesDownloaded = countries.filter(c => c.localPath).length;
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log('│          Flagpedia Scraper — Done             │');
  console.log('├──────────────────────────┬───────────────────┤');
  console.log(`│ Countries found          │ ${String(countries.length).padEnd(17)} │`);
  if (args.images) {
    console.log(`│ Images downloaded        │ ${String(imagesDownloaded).padEnd(17)} │`);
    console.log(`│ Images folder            │ output/flags/             │`);
  }
  console.log(`│ Output JSON              │ flagpedia_countries.json  │`);
  console.log(`│ Output CSV               │ flagpedia_countries.csv   │`);
  console.log('└──────────────────────────┴───────────────────┘');
  log('Done! ✓');
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
