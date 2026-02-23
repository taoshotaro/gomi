# gomi (ごみ)

Japanese garbage collection schedules and separation rules as structured data.

Each municipality in Japan has different garbage collection days, categories, and separation rules. This project maintains machine-readable data for cities and provides a Claude skill to query it.

## How it works

1. **Data** — Structured JSON files per city with collection schedules and separation rules
2. **GitHub Action** — Open an issue to request a new city. AI researches the official rules and creates a PR
3. **Claude Skill** — Ask "What garbage is collected today?" or "How do I throw away a PET bottle?"

## Available cities

| City | Prefecture | Data |
|------|-----------|------|
| 品川区 | 東京都 | [schedule](data/jp/tokyo/shinagawa-ku/schedule.json) / [separation](data/jp/tokyo/shinagawa-ku/separation.json) |

## Adding a new city

1. [Open an issue](../../issues/new?template=add-city.yml) with the city name and prefecture
2. The GitHub Action will research the city's official garbage page using AI
3. A PR will be created with the generated data
4. Review and merge

Or trigger manually via `Actions → Generate City Data → Run workflow`.

## Using the Claude Skill

Install the skill in Claude Code:

```
claude skill install taoshotaro/gomi
```

Then ask questions like:

```
> 今日のごみは？ (品川区)
> ペットボトルの捨て方
> How do I throw away a frying pan in Shinagawa?
```

## Data format

Each city has two files:

- **`schedule.json`** — Collection days by area, with weekly/monthly/appointment patterns
- **`separation.json`** — What goes where, with searchable keywords

See [schema reference](skill/gomi/references/schema.md) for details.

## Validation

```bash
bun install
bun run validate
```

## License

MIT
