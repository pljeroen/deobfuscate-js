#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INPUT="$1"
OUTPUT="$2"

timeout 60 npx --prefix "$PROJECT_DIR" tsx "$PROJECT_DIR/src/index.ts" --unsafe "$INPUT" "$OUTPUT" 2>/dev/null

if [ $? -ne 0 ] || [ ! -f "$OUTPUT" ]; then
  echo -n "" > "$OUTPUT"
fi
exit 0
