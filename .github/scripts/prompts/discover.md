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
  "city_id": "<romanized kebab-case name WITHOUT administrative suffix>",
  "prefecture_id": "<romanized kebab-case name WITHOUT administrative suffix>"
}
```

### ID generation rules

Generate `city_id` and `prefecture_id` as romanized kebab-case identifiers for the city and prefecture.

**Do NOT include administrative suffixes in IDs.** Strip these suffixes:
- Prefecture: -to (都), -do (道), -fu (府), -ken (県)
- City/Ward/Town: -ku (区), -shi (市), -cho/machi (町), -son/mura (村), -gun (郡)

**Examples:**
| Japanese | Correct ID | Wrong ID |
|----------|-----------|----------|
| 品川区 | shinagawa | shinagawa-ku |
| 横浜市 | yokohama | yokohama-shi |
| 東京都 | tokyo | tokyo-to |
| 北海道 | hokkaido | hokkaido-do |
| 大阪府 | osaka | osaka-fu |
| 神奈川県 | kanagawa | kanagawa-ken |
| 箱根町 | hakone | hakone-machi |

## Rules

- Only include URLs you have verified exist via web search
- csv_url should be a direct download link (ending in .csv, .json, or a download endpoint), not a page about the data
- Include multiple separation_urls if rules are split across pages
- If you find a CSV, still find the separation page (CSV usually only has schedule data)
