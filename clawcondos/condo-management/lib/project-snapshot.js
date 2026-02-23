/**
 * Project Snapshot
 * Reads condo workspace to build a project overview for PM planning.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

/** Key config files to include in snapshots (checked in order) */
const KEY_FILES = [
  'package.json',
  'README.md',
  'CLAUDE.md',
  'tsconfig.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
  'requirements.txt',
  'Makefile',
  'docker-compose.yml',
  'Dockerfile',
  '.env.example',
];

/** Max characters to include from any single file */
const MAX_FILE_CHARS = 4000;

/** Max lines in the file tree output */
const MAX_TREE_LINES = 80;

/** Max depth for directory tree traversal */
const MAX_TREE_DEPTH = 3;

/**
 * Detect the project's tech stack from files present.
 * @param {string} workspacePath
 * @returns {string} Tech stack description
 */
function detectTechStack(workspacePath) {
  const indicators = [];

  const check = (file, label) => {
    if (existsSync(join(workspacePath, file))) indicators.push(label);
  };

  check('package.json', 'Node.js');
  check('tsconfig.json', 'TypeScript');
  check('Cargo.toml', 'Rust');
  check('pyproject.toml', 'Python');
  check('go.mod', 'Go');
  check('Gemfile', 'Ruby');
  check('requirements.txt', 'Python');
  check('pom.xml', 'Java (Maven)');
  check('build.gradle', 'Java (Gradle)');
  check('composer.json', 'PHP');
  check('Dockerfile', 'Docker');

  // Detect frameworks from package.json
  if (existsSync(join(workspacePath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.express) indicators.push('Express');
      if (allDeps.fastify) indicators.push('Fastify');
      if (allDeps.react) indicators.push('React');
      if (allDeps.vue) indicators.push('Vue');
      if (allDeps.next) indicators.push('Next.js');
      if (allDeps.svelte) indicators.push('Svelte');
      if (allDeps.vite) indicators.push('Vite');
      if (allDeps.vitest) indicators.push('Vitest');
      if (allDeps.jest) indicators.push('Jest');
    } catch { /* ignore parse errors */ }
  }

  return indicators.length > 0 ? indicators.join(', ') : 'Unknown';
}

/**
 * Get a directory tree using git ls-files or fallback to fs traversal.
 * @param {string} workspacePath
 * @returns {string} Tree output
 */
function getFileTree(workspacePath) {
  // Try git ls-files first (respects .gitignore)
  try {
    const files = execSync('git ls-files', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();

    if (files) {
      const lines = files.split('\n');
      if (lines.length <= MAX_TREE_LINES) return lines.join('\n');
      return lines.slice(0, MAX_TREE_LINES).join('\n') + `\n... (${lines.length - MAX_TREE_LINES} more files)`;
    }
  } catch { /* fallback below */ }

  // Fallback: manual traversal
  const result = [];
  function walk(dir, prefix, depth) {
    if (depth > MAX_TREE_DEPTH || result.length >= MAX_TREE_LINES) return;
    let entries;
    try {
      entries = readdirSync(dir).filter(e => !e.startsWith('.') && e !== 'node_modules' && e !== 'goals');
    } catch { return; }

    entries.sort();
    for (const entry of entries) {
      if (result.length >= MAX_TREE_LINES) {
        result.push(`${prefix}... (truncated)`);
        return;
      }
      const fullPath = join(dir, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        result.push(`${prefix}${entry}/`);
        walk(fullPath, prefix + '  ', depth + 1);
      } else {
        result.push(`${prefix}${entry}`);
      }
    }
  }

  walk(workspacePath, '', 0);
  return result.join('\n') || '(empty)';
}

/**
 * Read a key file with truncation.
 * @param {string} filePath
 * @returns {string|null} File content or null
 */
function readKeyFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    if (content.length <= MAX_FILE_CHARS) return content;
    return content.slice(0, MAX_FILE_CHARS) + '\n... (truncated)';
  } catch {
    return null;
  }
}

/**
 * Build a project snapshot from a condo workspace.
 * @param {string} workspacePath - Path to the condo workspace
 * @returns {{ snapshot: string|null, error?: string }}
 */
export function buildProjectSnapshot(workspacePath) {
  if (!workspacePath || !existsSync(workspacePath)) {
    return { snapshot: null, error: 'Workspace path does not exist' };
  }

  try {
    const parts = [];
    parts.push(`## Project Snapshot (workspace: ${workspacePath})`);

    // Tech stack
    const techStack = detectTechStack(workspacePath);
    parts.push(`### Tech Stack: ${techStack}`);

    // File tree
    const tree = getFileTree(workspacePath);
    const isEmpty = !tree || tree === '(empty)';

    if (isEmpty) {
      parts.push('### NEW PROJECT — Empty Workspace');
      parts.push('This is a brand-new project with no existing code.');
      parts.push('You MUST plan a Foundation goal (Phase 1) before any feature goals.');
      parts.push('');
    }

    parts.push('### File Tree');
    parts.push('```');
    parts.push(tree);
    parts.push('```');

    // Key files
    for (const fileName of KEY_FILES) {
      const content = readKeyFile(join(workspacePath, fileName));
      if (content) {
        parts.push(`### ${fileName}`);
        const ext = extname(fileName).slice(1) || 'text';
        parts.push(`\`\`\`${ext}`);
        parts.push(content);
        parts.push('```');
      }
    }

    const snapshot = parts.join('\n');
    return { snapshot };
  } catch (err) {
    return { snapshot: null, error: err.message };
  }
}
