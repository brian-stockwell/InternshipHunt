#!/bin/zsh
# setup.sh: one-time install for InternshipHunt on a Mac.
# Safe to run again; every step skips what is already done.
# Usage: zsh ~/InternshipHunt/setup.sh

ROOT="$HOME/InternshipHunt"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { print -P "%B$1%b"; }

# 1. The folder must live at ~/InternshipHunt; the finder's instructions assume it.
if [[ "$HERE" != "$ROOT" ]]; then
  echo "This folder is at: $HERE"
  echo "It needs to be at:  $ROOT"
  echo "Move the InternshipHunt folder into your home folder (Finder > Go > Home), then run this again."
  exit 1
fi

# 2. Node.js
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  [[ -n "$c" && -x "$c" ]] && { NODE="$c"; break; }
done
if [[ -z "$NODE" ]]; then
  echo "Node.js is not installed."
  echo "Download the macOS installer (LTS) from https://nodejs.org, run it, then run this again."
  exit 1
fi
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 18 )); then
  echo "Node.js $("$NODE" -v) is too old. Install the current LTS from https://nodejs.org, then run this again."
  exit 1
fi
say "Node.js $("$NODE" -v) found at $NODE"
export PATH="$(dirname "$NODE"):$PATH"

# 3. Install the one dependency and run the tests.
cd "$ROOT/app" || exit 1
say "Installing..."
npm install --no-audit --no-fund || { echo "npm install failed."; exit 1; }
say "Running the tests..."
npm test >/tmp/internshiphunt-tests.log 2>&1 && say "All tests passed." || { echo "Tests failed; see /tmp/internshiphunt-tests.log"; exit 1; }

# 4. Point the weekly finder's instructions at this Mac.
sed -i '' "s|__INTERNSHIPHUNT_ROOT__|$ROOT|g; s|__NODE__|$NODE|g" "$ROOT/cowork/PLAYBOOK.md"
chmod +x "$ROOT/bin/ih"

# 5. Start the app now and at every login.
say "Turning on autostart..."
"$NODE" "$ROOT/app/autostart.js" install || exit 1

for i in {1..20}; do
  [[ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://localhost:4321/)" == "200" ]] && break
  sleep 0.5
done
open "http://localhost:4321"
say "Done. InternshipHunt is running at http://localhost:4321"
echo "Control it any time with: ~/InternshipHunt/bin/ih help"
