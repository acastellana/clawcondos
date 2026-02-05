# Building Apps for ClawCondos

ClawCondos can embed any web application and pair it with an AI assistant sidebar. This guide covers how to build, register, and deploy apps.

## What is a ClawCondos App?

A ClawCondos app is any web application that:

1. Runs on a local port (e.g., `localhost:8080`)
2. Is registered in `.registry/apps.json`
3. Gets displayed in an iframe at `/app?id=your-app-id`

The app itself can use any technology - Node.js, Python, React, plain HTML, anything. ClawCondos doesn't care about your stack. It just proxies HTTP requests to your app's port and wraps it in a page with an AI assistant panel.

## Quick Start

### 1. Create your app

Build any web app. Here's a minimal Node.js example:

```js
// my-app/index.js
import { createServer } from 'http';
import { readFileSync } from 'fs';

const PORT = 8080;

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head><title>My App</title></head>
    <body>
      <h1>Hello from My App</h1>
      <p>This is embedded in ClawCondos.</p>
    </body>
    </html>
  `);
}).listen(PORT, () => console.log(`Running on port ${PORT}`));
```

### 2. Register it

Copy `.registry/apps.example.json` to `.registry/apps.json` (if you haven't already), then add your app:

```json
{
  "apps": [
    {
      "id": "my-app",
      "name": "My App",
      "description": "A simple example app",
      "port": 8080,
      "path": "/absolute/path/to/my-app",
      "startCommand": "node index.js",
      "icon": "🚀"
    }
  ]
}
```

### 3. Start your app and ClawCondos

```bash
# Terminal 1: start your app
cd /path/to/my-app
node index.js

# Terminal 2: start ClawCondos
node serve.js
```

### 4. Open it

Visit `http://localhost:9000`. Your app appears in the Apps section of the dashboard. Click it to open the app viewer with the assistant sidebar.

## App Schema Reference

Each entry in `.registry/apps.json` has these fields:

### Required

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, used in URLs. Lowercase, no spaces (e.g., `"my-app"`) |
| `name` | string | Display name shown in the dashboard |
| `port` | number | Local port your app listens on |
| `path` | string | Absolute filesystem path to your app's source code |
| `startCommand` | string | Command to start the app (shown when app is offline) |

### Optional

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | `""` | Short description shown on the app card |
| `icon` | string | `"📦"` | Emoji shown on the app card |
| `stack` | string | `"Unknown"` | Technology description (e.g., `"Node.js, Express"`) |
| `files` | object | `null` | Key source files for assistant context (see below) |
| `logs` | string | `null` | Path to log file the assistant can check |
| `docs` | string | `null` | Relative path to a docs file (from `path`) |
| `basePath` | string | `null` | URL path prefix if your app uses one |
| `url` | string | `null` | Custom URL (for external apps not running locally) |
| `route` | string | `null` | Custom route path override |
| `allowExternal` | boolean | `false` | Allow loading external URLs in the iframe |

### The `files` field

The `files` field tells the AI assistant which source files matter most. It's an object mapping role names to filenames (relative to `path`):

```json
{
  "files": {
    "entry": "index.js",
    "config": "config.json",
    "routes": "src/routes.js",
    "database": "src/db.js"
  }
}
```

The assistant uses these as starting points when reading your app's code. The role names are freeform - use whatever makes sense for your app.

## How Routing Works

### Development (serve.js)

The ClawCondos dev server automatically proxies requests:

```
GET /my-app/          → localhost:8080/
GET /my-app/api/data  → localhost:8080/api/data
```

The `id` field in your app's registry entry becomes the URL prefix. No additional configuration needed.

If the app is offline, the server returns a 503 with the `startCommand` so you know how to start it.

### Production (Caddy)

For production, add proxy rules to your Caddyfile:

```
handle /my-app/* {
    uri strip_prefix /my-app
    reverse_proxy localhost:8080
}
handle /my-app {
    redir /my-app/ permanent
}
```

See [SETUP.md](SETUP.md) for full production deployment instructions.

## The AI Assistant

When a user opens your app in ClawCondos (`/app?id=my-app`), they see a split view:

- **Left**: Your app in an iframe
- **Right**: An AI assistant sidebar

The assistant automatically receives context about your app:

- App ID, name, description, port, path, stack
- Start command
- Key files (from the `files` field)
- Log file path (from the `logs` field)
- Documentation path (from the `docs` field)
- Any current errors (if the app failed to load)

The assistant can read and edit files in your app's `path`, check logs, and help debug issues. The more metadata you provide in your registry entry, the more helpful the assistant becomes.

### Enhancing assistant context

To get the most out of the assistant:

1. **Set `files`** - Point to your entry file, config, and key modules
2. **Set `logs`** - Point to your app's log file for debugging
3. **Set `docs`** - Point to your app's README or docs for context
4. **Set `stack`** - Tell the assistant what technologies you're using

Example with full metadata:

```json
{
  "id": "finances",
  "name": "Finances Tracker",
  "description": "Personal finance dashboard with charts and reports",
  "port": 3200,
  "path": "/home/user/apps/finances",
  "startCommand": "node server.js",
  "icon": "💰",
  "stack": "Node.js, Express, Chart.js",
  "files": {
    "entry": "server.js",
    "routes": "routes/api.js",
    "frontend": "public/index.html"
  },
  "logs": "/tmp/finances.log",
  "docs": "README.md"
}
```

## Health Checks

The dashboard checks whether each app is online by making a `HEAD` request to `/{appId}/`. If your app responds with any 2xx or 401 status, it shows as "active" (green dot). Otherwise it shows as "offline" (red dot).

Make sure your app responds to `HEAD /` requests. Most web frameworks handle this automatically.

## Tips

- **Pick unique ports** - Each app needs its own port. Use high ports (3000+) to avoid conflicts.
- **Use absolute paths** - The `path` field must be an absolute filesystem path, not relative.
- **Keep apps independent** - Each app should be a standalone project that works on its own. ClawCondos is just a wrapper.
- **Log to a file** - If you set the `logs` field, pipe your app's output to that file so the assistant can read it:
  ```bash
  node server.js > /tmp/my-app.log 2>&1
  ```
- **Respond to HEAD requests** - The dashboard health check uses HEAD. Most frameworks handle this by default, but if you have custom routing, make sure `HEAD /` returns a response.

## Example: Python Flask App

```python
# my-flask-app/app.py
from flask import Flask

app = Flask(__name__)

@app.route('/')
def index():
    return '<h1>Hello from Flask</h1>'

if __name__ == '__main__':
    app.run(port=5001)
```

Registry entry:

```json
{
  "id": "flask-demo",
  "name": "Flask Demo",
  "description": "Simple Python web app",
  "port": 5001,
  "path": "/home/user/apps/flask-demo",
  "startCommand": "python app.py",
  "icon": "🐍",
  "stack": "Python, Flask",
  "files": {
    "entry": "app.py"
  }
}
```
