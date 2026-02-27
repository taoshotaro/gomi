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
| 品川区 | 東京都 | [schedule](data/jp/tokyo/shinagawa/schedule.json) / [separation](data/jp/tokyo/shinagawa/separation.json) |

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

## Generator runtime (Anthropic-compatible)

The generator CLI now uses AI SDK Anthropic provider shape and can target Anthropic-compatible endpoints (including GLM Anthropic-compatible URLs).

Example:

```bash
bun run tools/generator/cli/generate-city.ts \
  --city 品川区 \
  --prefecture 東京都 \
  --model glm-4.7 \
  --base-url https://api.z.ai/api/anthropic/v1 \
  --skills-mode hybrid \
  --strict-skills-compat
```

Parser-first defaults:
- Pipeline steps are `discover -> download -> extraction-plan -> extract -> convert -> validate`.
- `--work-dir` is the single checkpoint/input source for step reruns and `--skip-to`.
- If upstream artifacts are missing in work-dir while skipping upstream steps, the run fails fast with a clear missing-artifact error.
- `convert` is deterministic and does not send full extracted artifacts to the model.
- Validation auto-fix is disabled by default; enable only when needed with `--allow-llm-record-fallback`.
- Primary source is selected per target (`schedule` / `separation`) using hybrid ranking (`deterministic scores + LLM tie-break + hard veto`).
- HTML extraction includes mandatory cleanup; failed HTML cleanup defaults to skip-source.
- Discover uses a bounded multi-round agent loop and emits `discover-report.json`, `discover-candidates.ndjson`, and `discover-selected.json`.

Useful discover flags:
- `--discover-max-steps <n>` (fast default: `20`, thorough: `30`)
- `--discover-max-rounds <n>` (fast default: `2`, thorough: `3`)
- `--discover-max-candidates <n>` (default: `30`)
- `--discover-max-fetches <n>` (fast default: `20`, thorough: `40`)
- `--discover-link-depth <n>` (fast default: `1`, thorough: `2`)
- `--discover-allow-hosts host1,host2`
- `--discover-scoring-mode evidence-v1` (default: `evidence-v1`)
- `--discover-min-coverage-schedule <0..1>` (default: `0.75`)
- `--discover-min-coverage-separation <0..1>` (default: `0.70`)
- `--discover-max-noise-ratio <0..1>` (default: `0.12`)
- `--discover-min-cleanup-pass-rate <0..1>` (default: `0.85`)
- `--discover-freshness-half-life-days <n>` (default: `365`)
- `--stop-after discover|download|extraction-plan|extract|convert|validate`

Useful conversion flags:
- `--max-convert-fix-retries <n>` (default: `2`)
- `--allow-llm-record-fallback` (default: disabled)
- `--convert-engine template|llm-template` (default: `llm-template`)
- `--selection-mode hybrid|deterministic|llm-first` (default: `hybrid`)
- `--selection-top-k <n>` (default: `3`)
- `--selection-max-model-ms <ms>` (default: `12000` fast / `25000` thorough)
- `--selection-confidence-threshold <0..1>` (default: `0.7`)
- `--selection-evidence-bytes <n>` (default: `12000`)
- `--html-cleanup-timeout-ms <ms>` (default: `45000`)
- `--html-cleanup-failure-policy skip-source|fail-run|raw-fallback` (default: `skip-source`)
- `--max-html-cleanup-calls <n>` (default: `2`)
- `--drift-threshold <0..1>` (default: `0.2`)

Skills options:
- `--enable-skills` enables native-skills preflight and execution path selection
- `--skills-mode native|local|hybrid` (default: `hybrid`)
- `--strict-skills-compat` (default: enabled) fails fast if native skills are incompatible

## Logging modes

Default mode (no `--verbose`) prints a condensed, high-signal stream that is easier to scan:

```text
[10:34:31] discover#1 start Step attempt started
[10:34:31] discover#1 Reasoning: starting source discovery with tool-assisted search
[10:34:34] discover#1 fail Step attempt failed errorCode="STEP_ERROR"
```

Verbose mode (`--verbose`) prints the full diagnostic stream, including state/file/http/tool/model lifecycle details:

```text
2026-02-26T10:34:38.458Z [discover/1] [http.request] HTTP request start ...
2026-02-26T10:34:38.717Z [discover/1] [http.response] HTTP request success ...
2026-02-26T10:34:40.784Z [discover/1] [tool.fetch_page] fetch_page tool start ...
```

Full event history is always written to:
- `<work-dir>/events.jsonl` (structured)
- `<work-dir>/events.log` (pretty mirror)

## License

MIT
