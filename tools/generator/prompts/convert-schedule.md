# CSV-to-Schedule Converter Prompt

Write a TypeScript script that converts the CSV data below into our schedule.json format.

## CSV sample (first {{SAMPLE_ROWS}} rows):

```
{{CSV_SAMPLE}}
```

## Target schema (schedule.json):

```json
{{SCHEDULE_SCHEMA}}
```

## Requirements

- The script reads CSV from `Bun.argv[2]` (first CLI argument after script name) and writes JSON to `Bun.argv[3]`
- Use Bun APIs (Bun.file, Bun.write) — no Node.js fs imports needed
- city_id = "{{PREFECTURE_ID}}/{{CITY_ID}}"
- city_name_ja = "{{CITY_NAME_JA}}"
- source_url = "{{SOURCE_URL}}"
- Map Japanese day names to English: 月→monday, 火→tuesday, 水→wednesday, 木→thursday, 金→friday, 土→saturday, 日→sunday
- IMPORTANT: CSV may contain full-width digits (２, ４) — normalize to half-width (2, 4) before parsing
- Parse patterns like "第1・3火曜日" or "第２木・第４木" → monthly `[{week:1, day:"tuesday"}, {week:3, day:"tuesday"}]`
- Parse patterns like "毎週月・木" or "火・金" → weekly `["monday", "thursday"]`
- Generate area_id in kebab-case from area name (romaji). Use a simple mapping or transliteration.
- All areas in the CSV must appear in the output. Do NOT skip or summarize.
- Every area gets its own entry, even if multiple areas share the same schedule. Do NOT group or merge areas.
- Handle CSV encoding (likely Shift_JIS or UTF-8). Try UTF-8 first, fall back to Shift_JIS if garbled.
- Output ONLY the TypeScript code, no explanation, no markdown fences.
