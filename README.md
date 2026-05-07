# Wordlist Scraper

This repository contains two main crawlers:

1. `crawl_oxford.ts` — scrape the Oxford 3000/5000 word list.
2. `crawl_cambridge.ts` — enrich Oxford words with Cambridge Dictionary data.

## Requirements

- Node.js ≥ 18
- TypeScript + `ts-node`

## Setup

```bash
npm install
```

---

## Oxford crawler (`crawl_oxford.ts`)

Crawls the full Oxford 3000 and 5000 word list from:
https://www.oxfordlearnersdictionaries.com/wordlists/oxford3000-5000

### Usage

```bash
npx ts-node crawl_oxford.ts
```

Optional flags:

```bash
npx ts-node crawl_oxford.ts --level b2
npx ts-node crawl_oxford.ts --format json
npx ts-node crawl_oxford.ts --level a1 --format csv
```

### `--level` options
`a1` | `a2` | `b1` | `b2` | `c1`

### `--format` options
| Value | Files created |
|-------|--------------|
| `all` (default) | JSON + CSV + TXT per level |
| `json` | `oxford_words.json` |
| `csv`  | `oxford_words.csv` |
| `txt`  | `oxford_A1.txt` … `oxford_C1.txt` |

### Output

```text
output/
├── oxford_words.json     ← full structured result
├── oxford_words.csv      ← flat CSV: word, level, pos, url, audioUk, audioUs
├── oxford_A1.txt         ← word TAB pos
├── oxford_A2.txt
├── oxford_B1.txt
├── oxford_B2.txt
└── oxford_C1.txt
```

### Notes

- Uses built-in `fetch` and `fs`.
- Removes duplicate word+POS+level entries.
- Keeps separate entries for the same word with different parts of speech.

---

## Cambridge enricher (`crawl_cambridge.ts`)

Reads words from `output/oxford_words.json` by default and fetches Cambridge Dictionary pages to extract:
- part of speech
- UK / US IPA pronunciations
- UK / US audio URLs
- definitions and example sentences
- CEFR level tags when available

### Usage

```bash
npx ts-node crawl_cambridge.ts
```

Optional flags:

```bash
npx ts-node crawl_cambridge.ts --level b2
npx ts-node crawl_cambridge.ts --word "abandon"
npx ts-node crawl_cambridge.ts --limit 200
npx ts-node crawl_cambridge.ts --delay 800
npx ts-node crawl_cambridge.ts --no-resume
```

### Output

```text
output/
├── cambridge_words.json      ← full structured Cambridge results
├── cambridge_words.csv       ← flat CSV summary
└── cambridge_checkpoint.json ← resumable progress checkpoint
```

### Notes

- Progress is saved after each batch to `output/cambridge_checkpoint.json`.
- The crawler is designed to resume runs and avoid reprocessing completed words.
- Cambridge pages may be missing for some words; those are logged with an error status.

---

## Recommended workflow

1. Run the Oxford crawler first:

```bash
npx ts-node crawl_oxford.ts
```

2. Then enrich the results with Cambridge data:

```bash
npx ts-node crawl_cambridge.ts
```

## Troubleshooting

- If `output/oxford_words.json` is missing, run `crawl_oxford.ts` first.
- If you want only one word from Cambridge, use `--word "<word>"`.
