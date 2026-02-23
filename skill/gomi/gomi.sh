#!/usr/bin/env bash
# gomi — fetch garbage collection data from taoshotaro/gomi
# Usage:
#   gomi.sh cities                              → list available cities
#   gomi.sh schedule <city_id>                  → get schedule for city
#   gomi.sh separation <city_id>                → get separation rules for city
#   gomi.sh search <query>                      → search cities by Japanese name

set -euo pipefail

BASE_URL="https://raw.githubusercontent.com/taoshotaro/gomi/main/data"

fetch() {
  if command -v curl &>/dev/null; then
    curl -sf "$1"
  elif command -v wget &>/dev/null; then
    wget -qO- "$1"
  else
    echo "Error: curl or wget required" >&2
    exit 1
  fi
}

case "${1:-}" in
  cities)
    fetch "$BASE_URL/cities.json"
    ;;
  schedule)
    if [ -z "${2:-}" ]; then
      echo "Usage: gomi.sh schedule <city_id>  (e.g. tokyo/shinagawa)" >&2
      exit 1
    fi
    fetch "$BASE_URL/jp/$2/schedule.json"
    ;;
  separation)
    if [ -z "${2:-}" ]; then
      echo "Usage: gomi.sh separation <city_id>  (e.g. tokyo/shinagawa)" >&2
      exit 1
    fi
    fetch "$BASE_URL/jp/$2/separation.json"
    ;;
  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: gomi.sh search <query>  (e.g. 品川)" >&2
      exit 1
    fi
    cities=$(fetch "$BASE_URL/cities.json")
    echo "$cities" | grep -i "$2" || echo "No cities found matching '$2'"
    ;;
  *)
    echo "gomi — Japanese garbage collection data (taoshotaro/gomi)"
    echo ""
    echo "Commands:"
    echo "  cities                  List available cities"
    echo "  schedule <city_id>      Get collection schedule (e.g. tokyo/shinagawa)"
    echo "  separation <city_id>    Get separation rules"
    echo "  search <query>          Search cities by name"
    ;;
esac
