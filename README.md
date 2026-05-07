# Oxford 3000/5000 Word List Crawler

Crawls the full Oxford 3000 and 5000 word list from:  
https://www.oxfordlearnersdictionaries.com/wordlists/oxford3000-5000

## Requirements

- Node.js ≥ 18 (uses built-in `fetch`)
- TypeScript + `ts-node`

## Setup

```bash
npm install
```

## Usage

```bash
# Crawl everything → output/ (JSON + CSV + TXT per level)
npx ts-node crawl.ts

# Only words at B2 level
npx ts-node crawl.ts --level b2

# Output JSON only
npx ts-node crawl.ts --format json

# Combine both flags
npx ts-node crawl.ts --level a1 --format csv
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

## Output

```
output/
├── oxford_words.json     ← Full structured result
├── oxford_words.csv      ← Flat: word, level, pos, url
├── oxford_A1.txt         ← word TAB pos
├── oxford_A2.txt
├── oxford_B1.txt
├── oxford_B2.txt
└── oxford_C1.txt
```

### JSON shape

```json
{
  "crawledAt": "2025-01-01T00:00:00.000Z",
  "source": "https://...",
  "total": 5741,
  "words": [
    { "word": "abandon", "pos": "verb", "level": "b2", "url": "/definition/english/abandon_1" }
  ],
  "byLevel": {
    "a1": [...],
    "a2": [...],
    "b1": [...],
    "b2": [...],
    "c1": [...]
  }
}
```

## Notes

- No external dependencies beyond TypeScript — uses built-in `fetch` and `fs`.
- Oxford renders the full word list in a single HTML page (no pagination needed).
- Duplicate entries (same word + POS + level) are removed automatically.
- Words with multiple POS (e.g. `about` as adverb and preposition) are kept as separate entries.
