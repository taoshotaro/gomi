# Separation Rules Extraction Prompt

Extract garbage separation rules from the text below into our schema format.

## Source text:

{{CLEANED_TEXT}}

## Target schema (separation.json):

```json
{{SEPARATION_SCHEMA}}
```

## Requirements

- city_id = "{{PREFECTURE_ID}}/{{CITY_ID}}"
- Extract all categories and their items/subcategories
- category_id must use kebab-case and match the schedule categories (e.g., "burnable", "non-burnable", "recyclable", "plastic-containers", "oversized")
- Include 3-5 keywords per item for search matching
- Keywords should include common search terms people would use (e.g., ペットボトル, 生ごみ, 段ボール, 電池, 缶, びん)
- Include preparation instructions (notes_ja) where available
- Use subcategories when items are naturally grouped (e.g., recyclable → ペットボトル, 缶, びん, 新聞紙)
- Include common household items even if the source text doesn't explicitly list them, as long as the category is clear from context
- Output ONLY valid JSON, no explanation.
