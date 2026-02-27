# Schedule Extraction from Parsed CSV Summary

Convert the parsed CSV summary below into schedule.json format.

## Parsed CSV Summary

```json
{{CSV_SUMMARY}}
```

## Target schema

```json
{{SCHEDULE_SCHEMA}}
```

## Requirements

- city_id = "{{PREFECTURE_ID}}/{{CITY_ID}}"
- city_name_ja = "{{CITY_NAME_JA}}"
- source_url = "{{SOURCE_URL}}"
- Use all rows from the summary; do not output partial areas
- Every area gets its own entry, even when schedules are identical
- category_id must be kebab-case (e.g., burnable, non-burnable, recyclable)
- Days must be english lowercase (monday..sunday)
- Support both weekly/monthly/appointment collection patterns
- Output only valid JSON matching the schema
