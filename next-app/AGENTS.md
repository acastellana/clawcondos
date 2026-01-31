# AGENTS.md - Sharp Development

## Project Overview

Sharp is the **unified control panel** for the Clawdbot ecosystem. It combines:
- Agent session management (chat, monitor, control)
- Knowledge base (Second Brain - docs, journal, wiki-links)
- Relationship tracking (people, organizations)
- Task & project management

## Architecture

**Current:** Vanilla HTML/JS  
**Target:** Next.js 14+ with App Router

```
sharp/
├── src/
│   ├── app/              # Next.js routes
│   │   ├── (dashboard)/  # Main dashboard layout
│   │   ├── sessions/     # Agent sessions
│   │   ├── kb/           # Knowledge base
│   │   ├── journal/      # Daily journal
│   │   └── api/          # API routes
│   ├── components/
│   │   ├── chat/         # Chat interface
│   │   ├── sidebar/      # Navigation
│   │   ├── kb/           # Knowledge base components
│   │   └── ui/           # Shared UI primitives
│   ├── lib/
│   │   ├── gateway.ts    # WebSocket client
│   │   ├── kb.ts         # Knowledge base functions
│   │   └── store.ts      # State management
│   └── hooks/
├── kb/                   # Knowledge base folder (Markdown)
└── public/
```

## Code Style

### TypeScript
- Strict mode enabled
- Explicit return types on functions
- Use `type` over `interface` unless extending

### React
- Functional components only
- Use React Server Components by default
- Client components marked with `'use client'`
- Hooks in `src/hooks/`

### Naming
- Components: PascalCase (`ChatMessage.tsx`)
- Files: kebab-case for non-components (`use-keyboard-nav.ts`)
- Variables: camelCase
- Constants: SCREAMING_SNAKE_CASE

### CSS
- Tailwind CSS only (no CSS modules)
- Use CSS variables for theming
- Dark mode via `dark:` variants

### File Organization
- One component per file
- Index files for barrel exports
- Colocate tests with source (`Component.test.tsx`)

## Running the App

### Development
```bash
cd ~/clawd/projects/sharp/next-app
pnpm dev --port 3001
```
Then open: **http://localhost:3001**

### Routes
| Route | Description |
|-------|-------------|
| `/` | Dashboard home |
| `/sessions` | Agent session management |
| `/kb` | Knowledge base browser |
| `/kb/:slug` | Individual document view |

### Within Sharp Ecosystem
The next-app is registered in Sharp's app registry (`.registry/apps.json`).
To run alongside the main Sharp dashboard:

1. Start the next-app: `cd next-app && pnpm dev --port 3001`
2. Start Sharp: `python3 -m http.server 9000` (from sharp root)
3. Access via Sharp's app viewer: `http://localhost:9000/app.html?id=kb`

Or access directly: `http://localhost:3001/kb`

## Commands

```bash
pnpm dev          # Development server (default port 3000)
pnpm dev --port 3001  # Run on port 3001 (recommended for Sharp)
pnpm build        # Production build
pnpm lint         # ESLint
pnpm test         # Run tests
pnpm typecheck    # TypeScript check
```

## Key Decisions

1. **Local-first knowledge base** — `kb/` folder is source of truth
2. **WebSocket for real-time** — Connect to Clawdbot gateway
3. **SQLite for search** — FTS5 for fast full-text search
4. **Git-friendly docs** — Markdown with YAML frontmatter

## Contributing

1. Check GitHub issues for the backlog
2. Create feature branch from `main`
3. Follow code style in this file
4. Run `pnpm build` before PR
5. Request code review

## Links

- GitHub: https://github.com/acastellana/sharp-claw-app
- Clawdbot: https://github.com/clawdbot/clawdbot
