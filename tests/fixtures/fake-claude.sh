#!/bin/sh
# Stands in for `claude` in tests: records its args, env and stdin, prints a
# result long enough to catch pipe truncation.
OUT="$FAKE_CLAUDE_LOG"
[ -z "$OUT" ] && OUT="$(dirname "$0")/fake-claude.log"
{ echo "ARGS:$*"; echo "PWD:$(pwd)"; env | sort | sed 's/^/ENV:/'; echo "STDIN:"; cat; } > "$OUT"
node -e 'process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"x".repeat(20000),usage:{input_tokens:7,output_tokens:5}}))'
