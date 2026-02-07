# ClawCondos Skill

Goals-first dashboard for AI agents. Use this skill when setting up ClawCondos or working with goals.

## Setup (run once)

```bash
# 1. Clone and install
git clone https://github.com/acastellana/clawcondos.git
cd clawcondos && npm install

# 2. Create env file (~/.config/clawcondos.env)
cat > ~/.config/clawcondos.env << 'EOF'
GATEWAY_HTTP_HOST=127.0.0.1
GATEWAY_WS_URL=ws://127.0.0.1:18789/ws
GATEWAY_AUTH=your-gateway-token
EOF
chmod 600 ~/.config/clawcondos.env

# 3. Create systemd service (~/.config/systemd/user/clawcondos.service)
cat > ~/.config/systemd/user/clawcondos.service << 'EOF'
[Unit]
Description=ClawCondos Dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/clawcondos
ExecStart=/usr/bin/node serve.js 9011
Restart=always
EnvironmentFile=%h/.config/clawcondos.env

[Install]
WantedBy=default.target
EOF

# 4. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now clawcondos
```

Replace `/path/to/clawcondos` with actual path and `your-gateway-token` with your OpenClaw gateway token.

## Operations

```bash
systemctl --user restart clawcondos  # restart
systemctl --user status clawcondos   # check status
journalctl --user -u clawcondos -f   # view logs
```

## Working with Goals

When goal context is injected (`# Goal:` in your prompt):

```javascript
// Start task
goal_update({ taskId: "task_xxx", status: "in-progress" })

// Complete task
goal_update({ taskId: "task_xxx", status: "done", summary: "What you did" })

// Add tasks
goal_update({ addTasks: [{ text: "New task" }] })

// Complete goal
goal_update({ goalStatus: "done" })
```

## Links

- Setup Guide: https://github.com/acastellana/clawcondos/blob/master/docs/SETUP.md
- API Reference: https://github.com/acastellana/clawcondos/blob/master/docs/BACKEND-API.md
- GitHub: https://github.com/acastellana/clawcondos
