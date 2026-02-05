# ClawCondos Setup Guide

This guide covers deploying ClawCondos with a compatible backend.

## Prerequisites

- A static file server (Caddy, nginx, or any HTTP server)
- A WebSocket backend implementing the [Backend API](BACKEND-API.md)
- (Optional) Clawdbot Gateway for full agent functionality

## Quick Start (Development)

For local development without a full backend:

```bash
# Clone the repo
git clone https://github.com/acastellana/clawcondos.git
cd clawcondos

# Serve with Node.js
node serve.js
```

Open `http://localhost:9000` — you'll see the dashboard (without backend, sessions won't load).

## Production Deployment

### Option 1: With Caddy (Recommended)

1. **Copy the example Caddyfile:**
   ```bash
   cp Caddyfile.example Caddyfile
   ```

2. **Edit the Caddyfile:**
   - Replace `YOUR_GATEWAY_TOKEN` with your gateway's bearer token
   - Replace `/path/to/clawcondos` with the actual path
   - Update port numbers as needed

3. **Run Caddy:**
   ```bash
   caddy run --config Caddyfile
   ```

### Option 2: With nginx

```nginx
server {
    listen 9000;
    server_name localhost;
    
    # Static files
    location / {
        root /path/to/clawcondos;
        try_files $uri $uri/ /index.html;
    }
    
    # WebSocket proxy
    location /ws {
        proxy_pass http://localhost:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Authorization "Bearer YOUR_TOKEN";
    }
    
    # API proxy
    location /api/gateway/ {
        proxy_pass http://localhost:18789/;
        proxy_set_header Authorization "Bearer YOUR_TOKEN";
    }
    
    # Apps registry
    location /api/apps {
        alias /path/to/clawcondos/.registry/apps.json;
    }
}
```

### Option 3: Docker

```dockerfile
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY . /srv/clawcondos

EXPOSE 9000
```

```bash
docker build -t clawcondos .
docker run -p 9000:9000 clawcondos
```

## Configuration

### Method 1: Inline Configuration

Add before the closing `</body>` tag in `index.html`:

```html
<script>
  window.CLAWCONDOS_CONFIG = {
    gatewayWsUrl: 'wss://your-gateway.example.com/',
    branding: {
      name: 'My Dashboard',
      logo: '🎯'
    }
  };
</script>
```

### Method 2: Config File

Create `config.json` from the example:

```bash
cp config.example.json config.json
# Edit config.json with your settings
```

The config is loaded automatically at startup.

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `gatewayWsUrl` | Auto-detect | WebSocket URL for backend |
| `gatewayHttpUrl` | Auto-detect | HTTP URL for REST API |
| `appsUrl` | `/api/apps` | URL to fetch apps registry |
| `branding.name` | `"ClawCondos"` | Dashboard title |
| `branding.logo` | `"🏙️"` | Logo emoji or image URL |
| `sessions.pollInterval` | `30000` | Session refresh interval (ms) |
| `features.showApps` | `true` | Show apps section |
| `features.showSubagents` | `true` | Show sub-agents section |

## Adding Apps

Apps are defined in `.registry/apps.json`:

```json
{
  "apps": [
    {
      "id": "my-app",
      "name": "My Application",
      "description": "Description of my app",
      "port": 8080,
      "icon": "🎨",
      "path": "/path/to/app",
      "startCommand": "npm start"
    }
  ]
}
```

Then add a proxy rule in your Caddyfile:

```
handle /my-app/* {
    uri strip_prefix /my-app
    reverse_proxy localhost:8080
}
handle /my-app {
    redir /my-app/ permanent
}
```

## Backend Setup

### Using Clawdbot Gateway

1. Install Clawdbot:
   ```bash
   npm i -g clawdbot
   ```

2. Start the gateway:
   ```bash
   clawdbot gateway start
   ```

3. Get the gateway token from your config and add it to ClawCondos's Caddyfile.

See [Clawdbot documentation](https://docs.clawd.bot) for full setup.

### Custom Backend

Implement the [Backend API](BACKEND-API.md) protocol:
- WebSocket endpoint at `/ws`
- Required methods: `connect`, `chat.send`, `chat.history`, `chat.abort`, `sessions.list`

## Troubleshooting

### "Connection failed" error

- Check that your backend is running
- Verify the WebSocket URL is correct
- Check browser console for detailed errors
- Ensure CORS/proxy is configured correctly

### Sessions not loading

- Verify the `sessions.list` endpoint is working
- Check authentication token is valid
- Look for errors in browser Network tab

### Apps showing "offline"

- Verify the app is running on its configured port
- Check the proxy configuration
- Ensure the app responds to HEAD requests

## Security Notes

- **Never commit** `Caddyfile` or `config.json` with real tokens
- By default, ClawCondos **does not** apply markdown/media rendering to **user** messages. To enable it, set:
  - `features.formatUserMessages: true`
- By default, ClawCondos **blocks external http(s) media embeds** (images/audio/links) for safety. To allow external embeds, set:
  - `features.allowExternalMedia: true`

Recommended: keep both flags `false` when viewing chats that may include untrusted user content.
- Use environment variables for secrets in production
- Consider using Tailscale or similar for secure internal access
- The `.gitignore` excludes sensitive files by default
