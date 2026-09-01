#!/usr/bin/env bash
# ============================================================
# Smoke test, part 2: serve the real static files and request them, the way
# GitHub Pages/Vercel actually would.
#
# verify.mjs's step 8 can only import()-test the four modules with no DOM or
# network dependency at load time (util.js/icons.js/data.js/config.js).
# app.js, dashboards.js, recovery.js, and supabase.js can't be smoke-tested
# that way in bare Node -- app.js touches document/window at module scope,
# and supabase.js imports from a remote https://esm.sh/... specifier. This
# script covers them the other way: start a plain static file server over
# the actual repo, and confirm every entry point a browser would request
# actually serves, with real content, at the real path.
#
# Deliberately a *plain* static server (python3 -m http.server) with no SPA
# fallback of its own -- this checks that the literal files a deploy ships
# are present and correctly pathed, the same class of bug the Vercel
# routing fix (see VERCEL.md) exists to prevent from recurring. It does not
# re-test the SPA-fallback/rewrite behavior itself, which is deployment-
# platform-specific (GitHub Pages' 404.html vs Vercel's vercel.json) and was
# verified live against both real deployments in that fix.
#
# Runnable locally exactly as it runs in CI:
#   bash .github/scripts/smoke-serve.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=8123
BASE="http://127.0.0.1:${PORT}"

# `command -v` alone isn't enough on Windows: the "python3"/"python" names on
# PATH can resolve to the Microsoft Store's app-execution-alias stub, which
# exists as a file but errors out instead of running, rather than a real
# interpreter. Try each candidate for real (a fast, harmless --version call)
# and use the first one that actually works.
PY=""
for candidate in "${PYTHON:-}" python3 python; do
  [ -n "$candidate" ] || continue
  if "$candidate" --version >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "✗ no working Python interpreter found on PATH (tried python3, python)"
  exit 1
fi

LOG="$(mktemp)"
echo "── Starting a static file server on :${PORT} ──"
"$PY" -m http.server "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to actually accept connections rather than sleeping a
# fixed guess -- flaky on a loaded CI runner otherwise. Each probe carries
# its own short timeout so a slow/refused connection can't stall the whole
# loop past its own budget.
up=0
for _ in $(seq 1 30); do
  if curl -s -m 1 -o /dev/null "$BASE/" 2>/dev/null; then
    up=1
    break
  fi
  sleep 0.3
done
if [ "$up" -ne 1 ]; then
  echo "✗ server never came up — log follows"
  cat "$LOG"
  exit 1
fi

fail=0
check_200() {
  local path="$1"
  local code
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "${BASE}${path}")
  if [ "$code" = "200" ]; then
    echo "  ✓ ${path} → 200"
  else
    echo "  ✗ ${path} → ${code} (expected 200)"
    fail=1
  fi
}

echo ""
echo "── Real entry points and assets ──"
for path in / /index.html /app.js /dashboards.js /recovery.js /supabase.js \
            /util.js /data.js /icons.js /config.js /styles.css /favicon.ico \
            /vercel.json; do
  check_200 "$path"
done

echo ""
echo "── Homepage contains the expected app shell ──"
body="$(curl -s "$BASE/")"
if echo "$body" | grep -q '<div id="app">' && echo "$body" | grep -q '<script type="module" src="./app.js">'; then
  echo "  ✓ index.html has the SPA mount point and loads app.js as a module"
else
  echo "  ✗ index.html is missing the expected app shell (#app div / module script tag)"
  fail=1
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "Smoke test (serve-and-fetch): FAILED"
  exit 1
fi
echo "Smoke test (serve-and-fetch): all real files serve correctly."
