#!/usr/bin/env bash
# ==============================================================================
# CertiFlow Launcher — Automated Certificate Dispatch & Verification Hub
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "======================================================="
echo "  🚀 Starting CertiFlow Web Hub..."
echo "  🌐 URL: http://localhost:5050"
echo "======================================================="

# Check Python 3
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 is not installed or not in PATH."
    exit 1
fi

# Install dependencies if needed
python3 -c "import flask, flask_cors, pypdf, requests, PIL" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "📦 Installing required dependencies from requirements.txt..."
    python3 -m pip install -r requirements.txt
fi

# Check if port 5050 is in use
if lsof -Pi :5050 -sTCP:LISTEN -t >/dev/null ; then
    echo "⚡ Port 5050 is already active. Opening browser..."
else
    python3 "$DIR/server.py" &
    sleep 1.5
fi

# Open in browser on macOS or Linux
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:5050"
elif command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:5050"
fi
