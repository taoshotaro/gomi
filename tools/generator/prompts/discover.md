# Source Discovery Prompt V2

Discover official garbage data sources for **{{CITY_NAME_JA}}** ({{PREFECTURE_JA}}).

This prompt is used in a bounded multi-round agent loop. Return **JSON only**.

## Objective

Find high-quality sources for both targets:
- `schedule`
- `separation`

Prefer official government domains and official open-data domains.

## Allowed source types

- `csv`
- `xlsx`
- `api` (json endpoint)
- `html`
- `pdf`
- `image`

## Required JSON schema

```json
{
  "city_id": "romanized-kebab-case",
  "prefecture_id": "romanized-kebab-case",
  "official_url": "https://...",
  "candidate_urls": [
    {
      "url": "https://...",
      "target": "schedule|separation|both",
      "reason_tags": ["official", "machine-readable", "separation-master"]
    }
  ]
}
```

## Hard rules

1. Candidate URLs must be directly relevant to garbage schedule/separation content.
2. Exclude utility/navigation pages (sitemap, privacy, login, search pages).
3. Use at most 3 web searches, then switch to fetch/navigation inside trusted official domains.
4. Include at least one machine-readable schedule candidate when available (`csv|xlsx|api`).
5. Include separation master/list pages with item/category coverage.
6. Keep candidate count under 20.
7. Prefer canonical URLs and avoid duplicate or near-duplicate queries.

## ID rules

Generate `city_id` and `prefecture_id` as romanized kebab-case identifiers.

Strip administrative suffixes:
- Prefecture: 都 / 道 / 府 / 県
- City/Ward/Town/Village: 区 / 市 / 町 / 村 / 郡

Examples:
- 品川区 -> `shinagawa`
- 東京都 -> `tokyo`
- 神奈川県 -> `kanagawa`
