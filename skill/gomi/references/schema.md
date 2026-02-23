# Data Schema Reference

## cities.json

Index of all available cities.

```typescript
{
  version: string;          // "1.0.0"
  cities: Array<{
    id: string;             // "{prefecture}/{city}" e.g. "tokyo/shinagawa"
    name_ja: string;        // Japanese name e.g. "品川区"
    prefecture_ja: string;  // Prefecture e.g. "東京都"
    source_url: string;     // Official source URL
    data_path: string;      // Relative path under data/ e.g. "jp/tokyo/shinagawa"
    last_verified: string;  // ISO date e.g. "2026-02-23"
  }>;
}
```

## schedule.json

Collection schedule per area.

```typescript
{
  city_id: string;
  city_name_ja: string;
  source_url: string;
  areas: Array<{
    area_id: string;         // kebab-case
    area_name_ja: string;
    categories: Array<{
      category_id: string;   // "burnable", "non-burnable", "recyclable", etc.
      name_ja: string;
      collection_days: WeeklySchedule | MonthlySchedule | AppointmentSchedule;
      collection_time?: string;
      bag_type?: string;
      notes_ja?: string;
    }>;
  }>;
}
```

### collection_days discriminated union

**Weekly** — regular weekly collection:
```json
{ "type": "weekly", "days": ["monday", "thursday"] }
```

**Monthly** — specific week + day of month:
```json
{ "type": "monthly", "pattern": [{ "week": 2, "day": "wednesday" }, { "week": 4, "day": "wednesday" }] }
```

**Appointment** — reservation required:
```json
{ "type": "appointment", "contact_phone": "03-...", "contact_url": "https://...", "notes_ja": "..." }
```

## separation.json

Separation rules with keyword search.

```typescript
{
  city_id: string;
  categories: Array<{
    category_id: string;
    name_ja: string;
    items?: Array<Item>;           // Direct items
    subcategories?: Array<{        // Grouped items
      subcategory_id: string;
      name_ja: string;
      preparation_ja?: string;     // How to prepare items in this group
      items?: Array<Item>;
    }>;
  }>;
}

type Item = {
  name_ja: string;
  notes_ja?: string;
  keywords: string[];  // For fuzzy search matching
};
```
