#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INPUT="$1"
OUTPUT="$2"

# Refuse when OUTPUT is the same file as INPUT (same device and inode, which
# also covers symlinks and hard links). A path that does not exist is never
# the same file, so a missing input still gets the empty-output fallback.
if [ "$INPUT" -ef "$OUTPUT" ]; then
  echo "ERROR: input and output are the same file: INPUT=$INPUT OUTPUT=$OUTPUT; nothing was written" >&2
  exit 1
fi

timeout 60 npx --prefix "$PROJECT_DIR" tsx "$PROJECT_DIR/src/index.ts" --unsafe "$INPUT" "$OUTPUT" 2>/dev/null
CLI_STATUS=$?

if [ "$CLI_STATUS" -ne 0 ] || [ ! -f "$OUTPUT" ]; then
  # The empty-output fallback truncates OUTPUT by path, so check again that it
  # has not become the input while the CLI ran.
  if [ "$INPUT" -ef "$OUTPUT" ]; then
    echo "ERROR: input and output are the same file: INPUT=$INPUT OUTPUT=$OUTPUT; nothing was written" >&2
    exit 1
  fi
  if ! echo -n "" > "$OUTPUT"; then
    echo "ERROR: could not create the empty output file: OUTPUT=$OUTPUT" >&2
    exit 1
  fi
fi
exit 0
