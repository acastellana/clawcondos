#!/bin/bash
# Example startup script for ClawCondos with Caddy
# Copy to start.sh and customize for your environment

DIR="$(cd "$(dirname "$0")" && pwd)"
CADDY="caddy"  # or path like ~/.local/bin/caddy
PIDFILE="/tmp/clawcondos-caddy.pid"

# Kill existing
if [ -f "$PIDFILE" ]; then
    kill $(cat "$PIDFILE") 2>/dev/null
    rm -f "$PIDFILE"
fi

echo "Starting ClawCondos on port 9000..."
cd "$DIR"
nohup "$CADDY" run --config Caddyfile > /tmp/clawcondos-caddy.log 2>&1 &
echo $! > "$PIDFILE"

sleep 2
if curl -s http://localhost:9000 > /dev/null 2>&1; then
    echo "✓ ClawCondos running at http://localhost:9000"
    
    # Optional: Set up Tailscale HTTPS
    # tailscale serve --bg --https=443 http://localhost:9000
    # echo "✓ Also available at https://$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')/"
else
    echo "✗ Failed to start. Check /tmp/clawcondos-caddy.log"
    tail -20 /tmp/clawcondos-caddy.log
fi
