/**
 * Vietcombank Exchange Rate Scraper
 *
 * Fetches real-time exchange rates from the Vietcombank tỷ giá page.
 * Data is loaded dynamically so Puppeteer is used to render the page.
 *
 * Output:
 *   output/vcb_exchange_rates.json  — full structured data
 *   output/vcb_exchange_rates.csv   — flat CSV
 *
 * Usage:
 *   npx ts-node crawl_vcb_exchange.ts
 *   npx ts-node crawl_vcb_exchange.ts --date 2025-05-07
 *   npx ts-node crawl_vcb_exchange.ts --no-headless     # show browser
 */

import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { parseArgs } from 'util';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExchangeRate {
  currencyCode: string;
  currencyName: string;
  buyCash: string;
  buyTransfer: string;
  sell: string;
}

interface ExchangeRateResult {
  source: string;
  fetchedAt: string;
  rateDate: string;
  rates: ExchangeRate[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VCB_URL = 'https://www.vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia';
const OUTPUT_DIR = path.resolve('./output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'vcb_exchange_rates.json');
const OUTPUT_CSV = path.join(OUTPUT_DIR, 'vcb_exchange_rates.csv');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠  ${msg}`);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resultToCsv(result: ExchangeRateResult): string {
  const header = 'currency_code,currency_name,buy_cash,buy_transfer,sell,rate_date,fetched_at';
  const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const rows = result.rates.map(r =>
    [
      esc(r.currencyCode),
      esc(r.currencyName),
      esc(r.buyCash),
      esc(r.buyTransfer),
      esc(r.sell),
      esc(result.rateDate),
      esc(result.fetchedAt),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCLI() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        date: { type: 'string' },
        headless: { type: 'boolean', default: true },
      },
    });
    return {
      date: values.date as string | undefined,
      headless: values.headless as boolean,
    };
  } catch {
    return { headless: true };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCLI();
  ensureDir(OUTPUT_DIR);

  log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: args.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 800 });

    let url = VCB_URL;
    if (args.date) {
      // VCB supports ?date=dd/MM/yyyy query param
      const [y, m, d] = args.date.split('-');
      url += `?date=${d}/${m}/${y}`;
    }

    log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the exchange rate table to appear
    log('Waiting for exchange rate table...');
    await page.waitForSelector('table', { timeout: 30000 }).catch(() => {
      warn('Table selector timed out — trying to extract anyway');
    });

    // Give JS a moment to fully populate the table
    await new Promise(r => setTimeout(r, 2000));

    // Extract data from the page
    const result = await page.evaluate((): { rateDate: string; rates: ExchangeRate[] } => {
      // Find the rate date (shown above the table)
      let rateDate = '';
      const dateEl =
        document.querySelector('.exchange-rate-date') ??
        document.querySelector('[class*="rate-date"]') ??
        document.querySelector('[class*="ty-gia"] .date') ??
        document.querySelector('.table-date') ??
        // Try any element containing a date pattern near the table
        [...document.querySelectorAll('p, span, div')].find(el =>
          /\d{2}\/\d{2}\/\d{4}/.test(el.textContent ?? ''),
        );

      if (dateEl) {
        const match = (dateEl.textContent ?? '').match(/\d{2}\/\d{2}\/\d{4}/);
        if (match) rateDate = match[0];
      }

      // Find the exchange rate table — VCB table has headers: Loại ngoại tệ, Mua, Bán
      const tables = [...document.querySelectorAll('table')];
      let rateTable: HTMLTableElement | null = null;

      for (const t of tables) {
        const headers = [...t.querySelectorAll('th, td')].map(el =>
          (el.textContent ?? '').trim().toLowerCase(),
        );
        if (
          headers.some(h => h.includes('mua') || h.includes('bán') || h.includes('ban')) &&
          headers.some(h => h.includes('ngoại') || h.includes('ngoai') || h.includes('currency'))
        ) {
          rateTable = t as HTMLTableElement;
          break;
        }
      }

      if (!rateTable) {
        // Fallback: pick the largest table on the page
        rateTable = tables.reduce(
          (best, t) => (!best || t.rows.length > best.rows.length ? t : best),
          null as HTMLTableElement | null,
        );
      }

      const rates: ExchangeRate[] = [];
      if (!rateTable) return { rateDate, rates };

      const rows = [...rateTable.querySelectorAll('tr')];

      // Detect column positions from the header row
      let codeCol = 0, nameCol = 1, buyCashCol = 2, buyTransferCol = 3, sellCol = 4;
      const headerRow = rows.find(r => r.querySelector('th'));
      if (headerRow) {
        const cells = [...headerRow.querySelectorAll('th, td')].map(el =>
          (el.textContent ?? '').trim().toLowerCase(),
        );
        cells.forEach((text, i) => {
          if (text.includes('mã') || text === 'code') codeCol = i;
          else if (text.includes('tên') || text.includes('loại') || text.includes('name') || text.includes('ngoại tệ')) nameCol = i;
          else if (text.includes('mua tiền mặt') || text.includes('cash')) buyCashCol = i;
          else if (text.includes('mua chuyển') || text.includes('transfer')) buyTransferCol = i;
          else if (text.includes('bán') || text.includes('sell')) sellCol = i;
        });
      }

      for (const row of rows) {
        if (row.querySelector('th')) continue; // skip header rows

        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 3) continue;

        const getText = (idx: number) => (cells[idx]?.textContent ?? '').replace(/\s+/g, ' ').trim();

        const currencyCode = getText(codeCol);
        const currencyName = getText(nameCol);
        const buyCash = getText(buyCashCol);
        const buyTransfer = getText(buyTransferCol);
        const sell = getText(sellCol);

        if (!currencyCode && !currencyName) continue;

        rates.push({ currencyCode, currencyName, buyCash, buyTransfer, sell });
      }

      return { rateDate, rates };
    });

    if (result.rates.length === 0) {
      warn('No exchange rate rows extracted. The page structure may have changed.');
      // Save a screenshot for debugging
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'vcb_debug.png'), fullPage: true });
      warn('Debug screenshot saved to output/vcb_debug.png');
    }

    const output: ExchangeRateResult = {
      source: url,
      fetchedAt: new Date().toISOString(),
      rateDate: result.rateDate || new Date().toLocaleDateString('vi-VN'),
      rates: result.rates,
    };

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2), 'utf-8');
    fs.writeFileSync(OUTPUT_CSV, resultToCsv(output), 'utf-8');

    console.log('\n┌──────────────────────────────────────────┐');
    console.log('│     Vietcombank Exchange Rates — Done     │');
    console.log('├─────────────────────┬────────────────────┤');
    console.log(`│ Currencies found    │ ${String(result.rates.length).padEnd(18)} │`);
    console.log(`│ Rate date           │ ${String(output.rateDate).padEnd(18)} │`);
    console.log(`│ Output JSON         │ vcb_exchange_rates.json  │`);
    console.log(`│ Output CSV          │ vcb_exchange_rates.csv   │`);
    console.log('└─────────────────────┴────────────────────┘');
    log('Done! ✓');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
