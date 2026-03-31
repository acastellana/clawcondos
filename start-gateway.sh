#!/bin/bash
# Start Clawdbot Apps Gateway (Caddy reverse proxy)

DIR="$(cd "$(dirname "$0")" && pwd)"
CADDY="${HOME}/.local/bin/caddy"
PIDFILE="/tmp/caddy-apps.pid"

# Kill existing
if [ -f "$PIDFILE" ]; then
    kill $(cat "$PIDFILE") 2>/dev/null
    rm -f "$PIDFILE"
fi

pkill -f "caddy run.*apps/Caddyfile" 2>/dev/null
sleep 1

echo "Starting Clawdbot Apps Gateway on port 9000..."
cd "$DIR"
nohup "$CADDY" run --config Caddyfile > /tmp/caddy-apps-stdout.log 2>&1 &
echo $! > "$PIDFILE"

sleep 2
if curl -s http://localhost:9000 > /dev/null 2>&1; then
    echo "✓ Caddy running on port 9000"
    
    # Set up Tailscale HTTPS proxy
    echo "Setting up Tailscale HTTPS..."
    tailscale serve --bg --https=443 http://localhost:9000 2>/dev/null
    
    echo "✓ Gateway ready at https://homebase.tail5e5154.ts.net/"
    echo "  Apps:"
    echo "    - https://homebase.tail5e5154.ts.net/sharp/"
    echo "    - https://homebase.tail5e5154.ts.net/subastas/"
    echo "    - https://homebase.tail5e5154.ts.net/dashboard"
else
    echo "✗ Failed to start. Check /tmp/caddy-apps-stdout.log"
    cat /tmp/caddy-apps-stdout.log | tail -20
fi
