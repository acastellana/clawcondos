# Contributing to ClawCondos

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/acastellana/clawcondos.git
cd clawcondos
npm install
cp config.example.json config.json
node serve.js
```

Open `http://localhost:9000` to see the dashboard.

## Development

No build step. ClawCondos is vanilla HTML/CSS/JS - edit files and refresh the browser.

- **`index.html`** - Main dashboard (HTML, CSS, and JS inline)
- **`app.html`** - App viewer with assistant panel
- **`serve.js`** - Node.js development server
- **`styles/main.css`** - CSS variables and theming

## Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests use [Vitest](https://vitest.dev/) and live in `tests/`. The test setup (`tests/setup.js`) mocks browser APIs since tests run in Node.

## Code Conventions

- **Vanilla JS (ES6+)** - No frameworks. Server uses ES modules; browser code uses globals.
- **`escapeHtml()`** - Must be used for all user-generated content rendered as HTML to prevent XSS.
- **CSS variables** - Use custom properties from `styles/main.css` for theming.
- **Naming** - Functions: camelCase. CSS classes/IDs: kebab-case.
- **Security** - Never introduce XSS, injection, or other OWASP vulnerabilities. Validate at boundaries.

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make focused, atomic commits
3. Run `npm test` to make sure tests pass
4. Update docs if your change affects user-facing behavior
5. Open a PR with a clear description of what and why

## Building Apps

Want to build an app that runs inside ClawCondos? See [docs/BUILDING-APPS.md](docs/BUILDING-APPS.md).

## Reporting Issues

Please include:

- Browser and version
- Steps to reproduce
- Expected vs. actual behavior
- Console errors (if any)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
