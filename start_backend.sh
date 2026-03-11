#!/bin/bash

# Navigate to script directory
cd "$(dirname "$0")"

echo "Checking for Python Virtual Environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate
pip install flask flask-cors requests playwright
playwright install chromium

echo "Checking for cloudflared..."
if ! command -v cloudflared &> /dev/null; then
    echo "Downloading cloudflared for Mac x64..."
    curl -L 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz' | tar xz
    mv cloudflared /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
fi

echo "Cleaning up any old server processes..."
lsof -ti:5000 | xargs kill -9 2>/dev/null

echo "Starting Flask Backend (Server at http://0.0.0.0:5000)..."
python app.py &

echo "Waiting for Flask server to initialize..."
sleep 3

echo "Starting Cloudflared Tunnel..."
echo "COPY the .trycloudflare.com URL below to your React Native App!"
cloudflared tunnel --url http://localhost:5000
