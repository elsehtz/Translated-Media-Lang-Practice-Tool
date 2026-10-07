#!/bin/bash
# El Dahih player: double-click to start. Close this window (or press Ctrl+C) to stop.
cd "$(dirname "$0")" || exit 1
echo "── El Dahih player ──"

pick_python() {
  for p in python3.14 python3.13 python3.12 python3.11 python3.10 \
           /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
    if command -v "$p" >/dev/null 2>&1 &&
       "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      echo "$p"; return 0
    fi
  done
  command -v python3 >/dev/null 2>&1 && { echo python3; return 0; }
  return 1
}

PY="$(pick_python)" || {
  echo "Python 3 isn't installed. Install it with:  xcode-select --install   (or: brew install python)"
  read -r -p "Press Return to close."; exit 1
}
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Note: $("$PY" --version) is old; the episode list works best with Python 3.10+ (brew install python)."
fi

# Private environment for this app, so nothing is installed system-wide.
if [ -d .venv ] && ! .venv/bin/python -c 'import sys' >/dev/null 2>&1; then rm -rf .venv; fi
if [ ! -d .venv ]; then
  echo "First run: setting up (about a minute)…"
  "$PY" -m venv .venv || { read -r -p "Couldn't create the environment. Press Return to close."; exit 1; }
fi
VPY=.venv/bin/python

# YouTube changes often, so keep the two helper libraries current on every start.
echo "Checking helper libraries…"
if ! "$VPY" -m pip install --disable-pip-version-check -q -U -r requirements.txt; then
  if ! "$VPY" -c 'import yt_dlp, youtube_transcript_api' 2>/dev/null; then
    read -r -p "Couldn't install the helper libraries (are you online?). Press Return to close."; exit 1
  fi
  echo "Offline? Using the libraries already installed."
fi

exec "$VPY" server.py --open "$@"
