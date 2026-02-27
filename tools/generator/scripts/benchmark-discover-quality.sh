#!/usr/bin/env bash
set -uo pipefail

# Discover quality/speed benchmark for multiple cities.
# Usage:
#   tools/generator/scripts/benchmark-discover-quality.sh
# Optional:
#   CITIES="品川区:東京都,横浜市:神奈川県" tools/generator/scripts/benchmark-discover-quality.sh

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

# Default city set; override via CITIES env var (comma-separated CITY:PREF pairs).
default_cities=(
  "品川区:東京都"
  "世田谷区:東京都"
  "横浜市:神奈川県"
  "大阪市:大阪府"
  "福岡市:福岡県"
)

if [[ -n "${CITIES:-}" ]]; then
  IFS=',' read -r -a cities <<<"$CITIES"
else
  cities=("${default_cities[@]}")
fi

root="/tmp/gomi-bench-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$root"

printf "city\tpref\tstatus\tsec\tstopReason\tqualityReady\tschedScore\tsepScore\tschedType\tsepType\tschedUrl\tsepUrl\tworkDir\n" | tee "$root/results.tsv"

for cp in "${cities[@]}"; do
  city="${cp%%:*}"
  pref="${cp##*:}"

  if [[ -z "$city" || -z "$pref" || "$city" == "$pref" ]]; then
    echo "Skipping invalid entry: $cp" >&2
    continue
  fi

  safe_city="$(echo "$city" | tr ' /' '__')"
  safe_pref="$(echo "$pref" | tr ' /' '__')"
  work="$root/${safe_pref}-${safe_city}"
  log="$work/run.log"
  mkdir -p "$work"

  start=$(date +%s)

  if bun run tools/generator/cli/generate-city.ts \
    --city "$city" \
    --prefecture "$pref" \
    --mode fast \
    --model GLM-4.7 \
    --base-url https://api.z.ai/api/anthropic/v1 \
    --skills-mode local \
    --strict-skills-compat \
    --discover-stop-mode quality \
    --stop-after discover \
    --work-dir "$work" >"$log" 2>&1; then
    status="OK"
  else
    status="FAIL"
  fi

  end=$(date +%s)
  sec=$((end - start))

  report="$work/discover-report.json"
  selected="$work/discover-selected.json"

  if [[ -f "$report" ]]; then
    stop_reason=$(jq -r '.stopReason // "n/a"' "$report" 2>/dev/null || echo "n/a")
    quality_ready=$(jq -r '.rounds[-1].qualityReady // false' "$report" 2>/dev/null || echo "false")
    sched_score=$(jq -r '.rounds[-1].schedulePrimaryScore // "n/a"' "$report" 2>/dev/null || echo "n/a")
    sep_score=$(jq -r '.rounds[-1].separationPrimaryScore // "n/a"' "$report" 2>/dev/null || echo "n/a")
    sched_type=$(jq -r '.rounds[-1].schedulePrimaryType // "n/a"' "$report" 2>/dev/null || echo "n/a")
    sep_type=$(jq -r '.rounds[-1].separationPrimaryType // "n/a"' "$report" 2>/dev/null || echo "n/a")
  else
    stop_reason="n/a"
    quality_ready="false"
    sched_score="n/a"
    sep_score="n/a"
    sched_type="n/a"
    sep_type="n/a"
  fi

  if [[ -f "$selected" && -f "$report" ]]; then
    sched_id=$(jq -r '.schedule[0] // ""' "$selected" 2>/dev/null || true)
    sep_id=$(jq -r '.separation[0] // ""' "$selected" 2>/dev/null || true)
    sched_url=$(jq -r --arg id "$sched_id" '.output.candidates[]? | select(.id==$id) | .url // "n/a"' "$report" 2>/dev/null | head -n1)
    sep_url=$(jq -r --arg id "$sep_id" '.output.candidates[]? | select(.id==$id) | .url // "n/a"' "$report" 2>/dev/null | head -n1)
  else
    sched_url="n/a"
    sep_url="n/a"
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$city" "$pref" "$status" "$sec" "$stop_reason" "$quality_ready" \
    "$sched_score" "$sep_score" "$sched_type" "$sep_type" \
    "${sched_url:-n/a}" "${sep_url:-n/a}" "$work" | tee -a "$root/results.tsv"

  if [[ "$status" != "OK" ]]; then
    {
      echo "---- failure tail: ${city} ${pref}"
      tail -n 120 "$log"
      echo
    } >> "$root/failures.log"
  fi
done

echo
echo "Benchmark output:"
echo "  $root/results.tsv"
if [[ -f "$root/failures.log" ]]; then
  echo "  $root/failures.log"
fi
