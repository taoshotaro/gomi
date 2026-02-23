# Schedule Extraction Prompt (Fallback)

Extract the garbage collection schedule from the text below into our schema format.

## Source text:

{{CLEANED_TEXT}}

## Target schema (schedule.json):

```json
{{SCHEDULE_SCHEMA}}
```

## Requirements

- city_id = "{{PREFECTURE_ID}}/{{CITY_ID}}"
- city_name_ja = "{{CITY_NAME_JA}}"
- source_url = "{{SOURCE_URL}}"
- Extract EVERY area/district. Do NOT output just 2-3 examples. If a city has 70+ areas, output all 70+.
- Every area gets its own entry, even if multiple areas share the same schedule. Do NOT group or merge areas.
- Use kebab-case for area_id (romanized from area name)
- Use kebab-case for category_id: "burnable", "non-burnable", "recyclable", "plastic-containers", "oversized", etc.
- Days must be English lowercase: "monday", "tuesday", etc.
- collection_days types:
  - Weekly: `{ "type": "weekly", "days": ["monday", "thursday"] }`
  - Monthly: `{ "type": "monthly", "pattern": [{ "week": 2, "day": "wednesday" }] }`
  - Appointment: `{ "type": "appointment", "contact_phone": "...", "contact_url": "...", "notes_ja": "..." }`
- Output ONLY valid JSON, no explanation.
