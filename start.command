#!/bin/bash
# Double-click to run Lights locally (a web server is required: the page reads images and
# runs the audio analyzer in a Web Worker, which browsers block on file:// URLs).
cd "$(dirname "$0")"
PORT=8000
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
( sleep 1; open "http://localhost:$PORT/" ) &
echo "Close this window to stop Lights."
python3 serve.py $PORT
