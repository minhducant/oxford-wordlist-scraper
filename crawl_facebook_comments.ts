/**
 * Facebook Comments Crawler
 *
 * Hỗ trợ 2 chế độ:
 *   --mode api     : Dùng Graph API (cần token có quyền pages_read_engagement)
 *   --mode browser : Dùng Puppeteer scraping với cookies đăng nhập
 *
 * Usage (API mode):
 *   npx ts-node crawl_facebook_comments.ts --mode api --post-id <ID> --token <TOKEN>
 *
 * Usage (Browser mode — cần cookies.json từ session đăng nhập):
 *   npx ts-node crawl_facebook_comments.ts --mode browser --url <POST_URL> --cookies cookies.json
 *   npx ts-node crawl_facebook_comments.ts --mode browser --url <URL> --cookies cookies.json --limit 200
 *
 * Cách export cookies.json:
 *   1. Đăng nhập Facebook trên Chrome/Firefox
 *   2. Cài extension "EditThisCookie" hoặc "Cookie-Editor"
 *   3. Mở facebook.com, export cookies dạng JSON
 *   4. Lưu file vào thư mục project với tên cookies.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import puppeteer, { type Page } from 'puppeteer';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FacebookUser {
  id: string;
  name: string;
}

interface Comment {
  id: string;
  message: string;
  from?: FacebookUser;
  createdTime: string;
  likeCount: number;
  commentCount: number;
  replies?: Comment[];
}

interface CrawlResult {
  crawledAt: string;
  source: string;
  total: number;
  comments: Comment[];
}

interface GraphComment {
  id: string;
  message: string;
  from?: { id: string; name: string };
  created_time: string;
  like_count: number;
  comment_count: number;
}

interface GraphResponse {
  data: GraphComment[];
  paging?: { next?: string };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const GRAPH_FIELDS = 'id,message,from,created_time,like_count,comment_count';
const PAGE_SIZE = 100;
const OUTPUT_DIR = path.resolve('./output');

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = (msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
};

// ─── Graph API mode ───────────────────────────────────────────────────────────

async function graphFetchPage(url: string): Promise<GraphResponse> {
  const res = await fetch(url);
  const json = await res.json() as any;
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return json as GraphResponse;
}

async function fetchCommentsViaApi(
  postId: string,
  token: string,
  maxItems = 0,
  fetchReplies = false,
): Promise<Comment[]> {
  const comments: Comment[] = [];
  let nextUrl: string | null =
    `${GRAPH_BASE}/${encodeURIComponent(postId)}/comments` +
    `?fields=${GRAPH_FIELDS}&limit=${PAGE_SIZE}&access_token=${token}`;
  let page = 1;

  while (nextUrl) {
    log(`API: fetching page ${page}…`);
    const data = await graphFetchPage(nextUrl);

    for (const raw of data.data) {
      const comment: Comment = {
        id: raw.id,
        message: raw.message ?? '',
        from: raw.from,
        createdTime: raw.created_time,
        likeCount: raw.like_count ?? 0,
        commentCount: raw.comment_count ?? 0,
      };

      if (fetchReplies && raw.comment_count > 0) {
        comment.replies = await fetchCommentsViaApi(raw.id, token, 0, false);
      }

      comments.push(comment);

      if (maxItems > 0 && comments.length >= maxItems) {
        log(`Reached limit of ${maxItems}`);
        return comments;
      }
    }

    log(`  → page ${page}: ${data.data.length} comments (total: ${comments.length})`);
    nextUrl = data.paging?.next ?? null;
    page++;
  }

  return comments;
}

// ─── Browser / Puppeteer mode ─────────────────────────────────────────────────

function normalizeSameSite(v: string | null | undefined): 'Strict' | 'Lax' | 'None' {
  if (!v) return 'Lax';
  if (v.toLowerCase() === 'strict') return 'Strict';
  if (v.toLowerCase() === 'none' || v.toLowerCase() === 'no_restriction') return 'None';
  return 'Lax';
}

async function loadCookies(page: any, cookieFile: string): Promise<void> {
  if (!fs.existsSync(cookieFile)) {
    log(`Cookie file not found: ${cookieFile} — proceeding without login (limited to ~10 comments)`);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
  const cookies = raw.map((c: any) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? '.facebook.com',
    path: c.path ?? '/',
    expires: c.expirationDate ?? c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: normalizeSameSite(c.sameSite),
  }));
  await page.setCookie(...cookies);
  log(`Loaded ${cookies.length} cookies from ${cookieFile}`);
}

async function fetchCommentsViaBrowser(
  postUrl: string,
  maxItems = 0,
  cookieFile?: string,
): Promise<Comment[]> {
  log('Launching headless browser…');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=vi-VN,vi'],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });

    // Load cookies before navigating so Facebook recognizes the session
    if (cookieFile) await loadCookies(page, cookieFile);

    log(`Navigating to: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Dismiss cookie banners (but NOT the post preview dialog)
    await dismissDialogs(page);

    // Expand all "View more comments" until we have enough
    await expandAllComments(page, maxItems);

    // Extract comments from DOM
    const comments = await extractComments(page);
    log(`Extracted ${comments.length} comments from DOM`);
    return comments;
  } finally {
    await browser.close();
    log('Browser closed');
  }
}

async function dismissDialogs(page: Page): Promise<void> {
  // Only close cookie consent banners — NOT the post preview dialog
  // (Facebook renders post content inside a dialog when not logged in)
  const cookieSelectors = [
    '[data-testid="cookie-policy-manage-dialog-close-button"]',
    '[aria-label="Allow all cookies"]',
    'button[title="Allow all cookies"]',
  ];

  for (const sel of cookieSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await new Promise(r => setTimeout(r, 500));
        log(`Dismissed cookie dialog: ${sel}`);
      }
    } catch { /* ignore */ }
  }
}

function findLargestScrollableScript(): string {
  // Finds the scrollable container with the largest scrollHeight (main content area)
  return `
    (function() {
      const all = Array.from(document.querySelectorAll('*'));
      let best = null, bestH = 0;
      for (const el of all) {
        const s = window.getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 100 &&
            el.scrollHeight > bestH) {
          best = el;
          bestH = el.scrollHeight;
        }
      }
      return best ?? document.documentElement;
    })()
  `;
}

async function clickMoreComments(page: Page): Promise<boolean> {
  const MORE_LABELS = ['Xem thêm bình luận', 'View more comments', 'See more comments'];
  for (const label of MORE_LABELS) {
    try {
      const didClick = await page.evaluate((text: string) => {
        const result = document.evaluate(
          `//span[contains(text(),'${text}')]/ancestor::div[@role='button'][1]`,
          document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
        );
        const el = result.singleNodeValue as HTMLElement | null;
        if (el) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }
        return false;
      }, label);
      if (didClick) return true;
    } catch { /* stale handle */ }
  }
  return false;
}

async function expandAllComments(page: Page, maxItems: number): Promise<void> {
  let rounds = 0;
  const MAX_ROUNDS = 80;
  let noProgressRounds = 0;
  let lastCount = 0;

  while (rounds < MAX_ROUNDS) {
    // 1. Try to click "Xem thêm bình luận" first
    const clicked = await clickMoreComments(page);
    if (clicked) {
      log(`Clicked "Xem thêm bình luận" (round ${rounds + 1})`);
      await new Promise(r => setTimeout(r, 2000));
    } else {
      // 2. No button found — scroll the main container down to trigger lazy loading
      await page.evaluate(`
        (function() {
          const c = (${findLargestScrollableScript()});
          c.scrollTop += 800;
        })();
      `);
      await new Promise(r => setTimeout(r, 1200));
    }

    const count = await countVisibleComments(page);
    log(`  visible comments: ${count}${clicked ? ' (after click)' : ''}`);

    if (maxItems > 0 && count >= maxItems) {
      log(`Reached limit of ${maxItems}, stopping`);
      break;
    }

    // Detect no-progress: if count hasn't grown in 5 consecutive rounds, stop
    if (count === lastCount) {
      noProgressRounds++;
      if (noProgressRounds >= 5) {
        log('No new comments loaded after 5 rounds — stopping');
        break;
      }
    } else {
      noProgressRounds = 0;
      lastCount = count;
    }

    rounds++;
  }
}

async function countVisibleComments(page: Page): Promise<number> {
  return page.evaluate(() =>
    document.querySelectorAll('div[role="article"][aria-label*="Bình luận"]').length +
    document.querySelectorAll('div[role="article"][aria-label*="comment"]').length
  );
}

async function extractComments(page: Page): Promise<Comment[]> {
  return page.evaluate(() => {
    // Facebook renders each comment as div[role="article"] with a Vietnamese/English aria-label
    // e.g. "Bình luận dưới tên Nguyễn Văn A vào 4 tuần trước"
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(
        'div[role="article"][aria-label*="Bình luận"], div[role="article"][aria-label*="comment"]'
      )
    );

    const seen = new Set<string>();
    const results: Array<{
      id: string;
      message: string;
      from?: { id: string; name: string };
      createdTime: string;
      likeCount: number;
      commentCount: number;
    }> = [];

    for (const el of containers) {
      try {
        // Author name: non-aria-hidden link text (first visible link)
        const authorLink = el.querySelector<HTMLAnchorElement>(
          'a:not([aria-hidden="true"])[href*="facebook.com"]'
        );
        const name = authorLink?.textContent?.trim() ?? '';
        if (!name) continue;

        // Author profile URL → extract username or numeric ID
        const href = authorLink?.getAttribute('href') ?? '';
        const profilePath = href.split('?')[0];
        const idMatch = profilePath.match(/profile\.php\?id=(\d+)/) ??
                        profilePath.match(/facebook\.com\/([^/?]+)$/);
        const userId = idMatch?.[1] ?? '';

        // Comment ID from the comment_id param in the href
        const commentIdMatch = href.match(/comment_id=([^&]+)/);
        const commentId = commentIdMatch ? decodeURIComponent(commentIdMatch[1]) : `${userId}_${results.length}`;

        // Timestamp from aria-label: "vào X tuần/ngày/giờ trước"
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        const timeMatch = ariaLabel.match(/vào (.+)$/);
        const timeStr = timeMatch ? timeMatch[1] : '';

        // Message text: innerText of element, strip author name + timestamp line
        const fullText = el.innerText ?? '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
        // Remove name line and trailing UI lines (reactions, reply button, timestamp)
        const skipWords = [name, 'Thích', 'Phản hồi', 'Chia sẻ', 'Xem', 'Reply', 'Like', timeStr];
        const messageLines = lines.filter(l => !skipWords.some(w => w && l === w));
        const message = messageLines.join('\n').trim();
        if (!message) continue;

        // Deduplicate
        const key = `${name}||${message.slice(0, 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          id: commentId,
          message,
          from: { id: userId, name },
          createdTime: timeStr || new Date().toISOString(),
          likeCount: 0,
          commentCount: 0,
        });
      } catch { /* skip malformed elements */ }
    }

    return results;
  });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveJson(result: CrawlResult): void {
  const p = path.join(OUTPUT_DIR, 'fb_comments.json');
  fs.writeFileSync(p, JSON.stringify(result, null, 2), 'utf-8');
  log(`✓ JSON → ${p}`);
}

function saveCsv(result: CrawlResult): void {
  const p = path.join(OUTPUT_DIR, 'fb_comments.csv');
  const header = 'id,from_id,from_name,message,created_time,like_count,comment_count';
  const rows = result.comments.map(c => {
    const msg = `"${(c.message ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    return [c.id, c.from?.id ?? '', c.from?.name ?? '', msg, c.createdTime, c.likeCount, c.commentCount].join(',');
  });
  fs.writeFileSync(p, [header, ...rows].join('\n'), 'utf-8');
  log(`✓ CSV  → ${p}`);
}

function printSummary(result: CrawlResult): void {
  console.log('\n┌──────────────────────────────────────────┐');
  console.log('│        Facebook Comments Summary          │');
  console.log('├───────────────────┬──────────────────────┤');
  console.log(`│ Source            │ ${result.source.slice(0, 20).padEnd(20)} │`);
  console.log(`│ Total comments    │ ${String(result.total).padEnd(20)} │`);
  console.log(`│ Crawled at        │ ${result.crawledAt.slice(0, 19).padEnd(20)} │`);
  console.log('└───────────────────┴──────────────────────┘\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCLIArgs() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode:      { type: 'string', default: 'browser' },
      url:       { type: 'string' },
      'post-id': { type: 'string' },
      token:     { type: 'string' },
      cookies:   { type: 'string' },
      limit:     { type: 'string', default: '0' },
      format:    { type: 'string', default: 'all' },
      replies:   { type: 'boolean', default: false },
    },
  });

  const mode = (values['mode'] as string).toLowerCase();
  const limit = parseInt(values['limit'] as string, 10) || 0;
  const format = (values['format'] as string).toLowerCase();

  if (mode === 'api') {
    const postId = values['post-id'];
    const token = values['token'];
    if (!postId || !token) {
      console.error('API mode requires --post-id and --token');
      process.exit(1);
    }
    return { mode: 'api' as const, postId, token, limit, format, replies: values['replies'] as boolean };
  }

  // browser mode (default)
  const url = values['url'];
  if (!url) {
    console.error('Browser mode requires --url <facebook_post_url>');
    console.error('Example: npx ts-node crawl_facebook_comments.ts --url "https://www.facebook.com/..." --cookies cookies.json');
    process.exit(1);
  }
  return { mode: 'browser' as const, url, cookies: values['cookies'] as string | undefined, limit, format };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCLIArgs();
  log(`Facebook Comments Crawler — mode: ${args.mode}`);

  let comments: Comment[];
  let source: string;

  if (args.mode === 'api') {
    log(`Post ID : ${args.postId}`);
    log(`Replies : ${args.replies}`);
    comments = await fetchCommentsViaApi(args.postId, args.token, args.limit, args.replies);
    source = args.postId;
  } else {
    log(`URL     : ${args.url}`);
    log(`Limit   : ${args.limit === 0 ? 'unlimited' : args.limit}`);
    log(`Cookies : ${args.cookies ?? 'none (limited to ~10 comments)'}`);
    comments = await fetchCommentsViaBrowser(args.url, args.limit, args.cookies);
    source = args.url;
  }

  log(`Total comments collected: ${comments.length}`);

  const result: CrawlResult = {
    crawledAt: new Date().toISOString(),
    source,
    total: comments.length,
    comments,
  };

  ensureDir(OUTPUT_DIR);
  if (args.format === 'json' || args.format === 'all') saveJson(result);
  if (args.format === 'csv'  || args.format === 'all') saveCsv(result);

  printSummary(result);
  log('Done! ✓');
}

main().catch(err => {
  console.error('\nFatal error:', err?.message ?? err);
  process.exit(1);
});
