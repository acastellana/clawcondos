# Contributing to Sharp

Thanks for your interest in contributing! 🎯

## Getting Started

1. Fork the repo
2. Clone your fork
3. Make changes
4. Test locally (see below)
5. Submit a PR

## Local Development

No build step required! Sharp is vanilla HTML/CSS/JS.

```bash
# Serve files
python -m http.server 9000

# Or with Caddy
caddy file-server --listen :9000
```

## Testing

Manual testing checklist:
- [ ] Dashboard loads without errors
- [ ] Sessions list populates (requires backend)
- [ ] Chat send/receive works
- [ ] Apps section shows registered apps
- [ ] Mobile responsive layout works
- [ ] Login modal appears when auth fails

## Code Style

- Vanilla JS (no frameworks)
- CSS variables for theming
- `escapeHtml()` for all user-generated content in templates
- Descriptive function names

## Submitting Changes

1. Create a feature branch
2. Make focused, atomic commits
3. Update docs if needed
4. Open a PR with a clear description

## Reporting Issues

Please include:
- Browser and version
- Steps to reproduce
- Expected vs actual behavior
- Console errors (if any)

## License

By contributing, you agree that your contributions will be licensed under MIT.
