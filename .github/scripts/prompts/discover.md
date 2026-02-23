# Source Discovery Prompt

Search for machine-readable garbage collection data for **{{CITY_NAME_JA}}** ({{PREFECTURE_JA}}).

{{#if SOURCE_URL}}
Start with this official URL: {{SOURCE_URL}}
{{/if}}

## What to find

Search for these data sources in priority order:

### 1. Machine-readable data (CSV/JSON)
Search queries to try:
- "{{CITY_NAME_JA}} ごみ収集日 CSV"
- "{{CITY_NAME_JA}} オープンデータ ごみ"
- "{{CITY_NAME_JA}} open data garbage"
- "{{PREFECTURE_JA}} オープンデータカタログ ごみ"

Look for CSV/JSON files containing collection schedules with area names and days.

### 2. Official garbage schedule page
Search queries to try:
- "{{CITY_NAME_JA}} ごみ収集カレンダー"
- "{{CITY_NAME_JA}} ごみ 曜日"
- "{{CITY_NAME_JA}} ごみ 地区 一覧"

### 3. Separation rules page
Search queries to try:
- "{{CITY_NAME_JA}} ごみ 分別 一覧"
- "{{CITY_NAME_JA}} ごみ 出し方"
- "{{CITY_NAME_JA}} 資源とごみの分け方"

## Output

Return a single JSON object:

```json
{
  "csv_url": "<direct download URL to CSV/JSON file, or null if not found>",
  "schedule_urls": ["<URLs to official schedule pages>"],
  "separation_urls": ["<URLs to separation rules pages>"],
  "official_url": "<main garbage info page>",
  "city_id": "{{CITY_ID}}",
  "prefecture_id": "{{PREFECTURE_ID}}"
}
```

## Rules

- Only include URLs you have verified exist via web search
- csv_url should be a direct download link (ending in .csv, .json, or a download endpoint), not a page about the data
- Include multiple separation_urls if rules are split across pages
- If you find a CSV, still find the separation page (CSV usually only has schedule data)
