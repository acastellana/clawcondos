/**
 * Skill Injector
 * Reads skill files and builds context strings for PM and worker agents
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Skill file paths (relative to plugin root)
const SKILL_PM_PATH = join(__dirname, '..', '..', '..', 'docs', 'SKILL-PM.md');
const SKILL_PM_STRAND_PATH = join(__dirname, '..', '..', '..', 'docs', 'SKILL-PM-STRAND.md');
const SKILL_PM_GOAL_PATH = join(__dirname, '..', '..', '..', 'docs', 'SKILL-PM-GOAL.md');
const SKILL_WORKER_PATH = join(__dirname, '..', '..', '..', 'docs', 'SKILL-WORKER.md');
const SKILL_AGENT_PATH = join(__dirname, '..', '..', '..', 'docs', 'SKILL-AGENT.md');

// Cache for skill file contents
let skillCache = {
  pm: null,
  pmCondo: null,
  pmGoal: null,
  worker: null,
  agent: null,
  loadedAt: null,
};

const CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Load skill file with caching
 * @param {string} type - 'pm' or 'worker'
 * @returns {string|null} Skill content or null if not found
 */
function loadSkillFile(type) {
  const now = Date.now();
  
  // Check cache
  if (skillCache.loadedAt && (now - skillCache.loadedAt) < CACHE_TTL_MS) {
    return skillCache[type];
  }
  
  // Load files
  try {
    skillCache.pm = existsSync(SKILL_PM_PATH)
      ? readFileSync(SKILL_PM_PATH, 'utf-8')
      : null;
  } catch {
    skillCache.pm = null;
  }

  try {
    skillCache.pmCondo = existsSync(SKILL_PM_STRAND_PATH)
      ? readFileSync(SKILL_PM_STRAND_PATH, 'utf-8')
      : null;
  } catch {
    skillCache.pmCondo = null;
  }

  try {
    skillCache.pmGoal = existsSync(SKILL_PM_GOAL_PATH)
      ? readFileSync(SKILL_PM_GOAL_PATH, 'utf-8')
      : null;
  } catch {
    skillCache.pmGoal = null;
  }

  try {
    skillCache.worker = existsSync(SKILL_WORKER_PATH)
      ? readFileSync(SKILL_WORKER_PATH, 'utf-8')
      : null;
  } catch {
    skillCache.worker = null;
  }

  try {
    skillCache.agent = existsSync(SKILL_AGENT_PATH)
      ? readFileSync(SKILL_AGENT_PATH, 'utf-8')
      : null;
  } catch {
    skillCache.agent = null;
  }
  
  skillCache.loadedAt = now;
  return skillCache[type];
}

/**
 * Clear skill cache (for testing or hot reload)
 */
export function clearSkillCache() {
  skillCache = { pm: null, pmCondo: null, pmGoal: null, worker: null, agent: null, loadedAt: null };
}

/**
 * Get PM skill context for injection into agent prompts
 * @param {object} options - Context options
 * @param {string} [options.condoId] - Current condo ID
 * @param {string} [options.condoName] - Current condo name
 * @param {number} [options.activeGoals] - Number of active goals
 * @param {number} [options.totalTasks] - Total task count
 * @param {number} [options.pendingTasks] - Pending task count
 * @param {object} [options.roles] - Available roles with descriptions { role: { description, agentId } }
 * @returns {string|null} PM skill context or null if unavailable
 */
export function getPmSkillContext(options = {}) {
  const skillContent = loadSkillFile('pmGoal') || loadSkillFile('pm');
  if (!skillContent) return null;
  
  const {
    condoId,
    condoName,
    activeGoals,
    totalTasks,
    pendingTasks,
    roles,
  } = options;
  
  // Build PM session context header
  const header = [
    '---',
    '## PM Session Context',
  ];
  
  if (condoId && condoName) {
    header.push(`- **Project:** ${condoName} (${condoId})`);
  }
  
  if (typeof activeGoals === 'number') {
    header.push(`- **Active Goals:** ${activeGoals}`);
  }
  
  if (typeof totalTasks === 'number') {
    const pending = typeof pendingTasks === 'number' ? pendingTasks : '?';
    header.push(`- **Tasks:** ${totalTasks} total, ${pending} pending`);
  }
  
  // Add available roles section if provided
  if (roles && typeof roles === 'object' && Object.keys(roles).length > 0) {
    header.push('');
    header.push('## Available Roles');
    
    for (const [role, info] of Object.entries(roles)) {
      const desc = info?.description || getDefaultRoleDescription(role);
      const agentId = info?.agentId || role;
      header.push(`- **${role}** (${agentId}): ${desc}`);
    }
  }
  
  header.push('---', '');
  
  return header.join('\n') + skillContent;
}

/**
 * Get default description for a role
 * @param {string} role - Role name
 * @returns {string} Default description
 */
function getDefaultRoleDescription(role) {
  const defaults = {
    pm: 'Project manager, coordinates tasks and agents',
    frontend: 'UI/UX specialist, handles client-side code and interfaces',
    backend: 'API developer, handles server-side logic and databases',
    designer: 'Visual designer, creates mockups and design systems',
    tester: 'QA specialist, writes and runs tests',
    devops: 'Infrastructure and deployment specialist',
    qa: 'Quality assurance, reviews and validates work',
    researcher: 'Research and analysis specialist',
  };
  return defaults[role.toLowerCase()] || 'Specialist agent';
}

/**
 * Get condo-level PM skill context for injection into condo PM agent prompts.
 * Instructs the PM to break a project into goals rather than tasks.
 *
 * @param {object} options - Context options
 * @param {string} [options.condoId] - Condo ID
 * @param {string} [options.condoName] - Condo name
 * @param {number} [options.goalCount] - Current number of goals
 * @param {Array} [options.existingGoals] - Existing goal summaries [{title, status, taskCount}]
 * @param {object} [options.roles] - Available roles with descriptions
 * @returns {string|null} Condo PM skill context or null if unavailable
 */
export function getStrandPmSkillContext(options = {}) {
  const skillContent = loadSkillFile('pmCondo') || loadSkillFile('pm');

  const {
    condoId,
    condoName,
    goalCount,
    existingGoals,
    roles,
  } = options;

  // Build dynamic context header (project-specific info)
  const header = [
    '---',
    '## Condo PM Session Context',
  ];

  if (condoId && condoName) {
    header.push(`- **Project:** ${condoName} (${condoId})`);
  }

  if (typeof goalCount === 'number' && goalCount > 0) {
    header.push(`- **Existing Goals:** ${goalCount}`);
  }

  if (existingGoals && existingGoals.length > 0) {
    header.push('');
    header.push('### Current Goals');
    for (const g of existingGoals) {
      const status = g.status || 'active';
      const tasks = typeof g.taskCount === 'number' ? ` (${g.taskCount} tasks)` : '';
      header.push(`- **${g.title}** — ${status}${tasks}`);
    }
  }

  // Add available roles section if provided
  if (roles && typeof roles === 'object' && Object.keys(roles).length > 0) {
    header.push('');
    header.push('### Available Roles');

    for (const [role, info] of Object.entries(roles)) {
      const desc = info?.description || getDefaultRoleDescription(role);
      const agentId = info?.agentId || role;
      header.push(`- **${role}** (${agentId}): ${desc}`);
    }
  }

  header.push('---', '');

  // Append dedicated condo PM skill content (or fallback to generic PM)
  if (skillContent) {
    return header.join('\n') + skillContent;
  }

  return header.join('\n');
}

/**
 * Get worker skill context for injection into agent prompts
 * @param {object} taskContext - Task-specific context
 * @param {string} taskContext.goalId - Goal ID
 * @param {string} taskContext.taskId - Task ID
 * @param {string} taskContext.taskText - Task description
 * @param {string} [taskContext.taskDescription] - Detailed task description
 * @param {string} [taskContext.goalTitle] - Parent goal title
 * @param {string} [taskContext.condoId] - Condo ID (if applicable)
 * @param {string} [taskContext.condoName] - Condo name (if applicable)
 * @param {string} [taskContext.autonomyMode] - Autonomy level
 * @param {string} [taskContext.planFilePath] - Expected plan file path
 * @param {string} [taskContext.assignedRole] - Role assigned to this task
 * @param {string} [taskContext.workspacePath] - Working directory path for the task
 * @returns {string|null} Worker skill context or null if unavailable
 */
export function getWorkerSkillContext(taskContext = {}) {
  const skillContent = loadSkillFile('worker');
  if (!skillContent) return null;

  const agentSkillContent = loadSkillFile('agent');

  const {
    goalId,
    taskId,
    taskText,
    taskDescription,
    goalTitle,
    condoId,
    condoName,
    autonomyMode,
    planFilePath,
    assignedRole,
    workspacePath,
  } = taskContext;
  
  // Build task assignment header
  const header = [
    '---',
    '## Your Task Assignment',
  ];
  
  if (condoName) {
    header.push(`- **Project:** ${condoName}`);
  }
  
  if (goalTitle) {
    header.push(`- **Goal:** ${goalTitle} (\`${goalId}\`)`);
  }
  
  header.push(`- **Task ID:** \`${taskId}\``);
  header.push(`- **Task:** ${taskText}`);
  
  if (taskDescription) {
    header.push(`- **Details:** ${taskDescription}`);
  }
  
  if (assignedRole) {
    header.push(`- **Your Role:** ${assignedRole}`);
  }
  
  if (autonomyMode) {
    header.push(`- **Autonomy:** ${autonomyMode}`);
  }
  
  if (workspacePath) {
    header.push(`- **Working Directory:** \`${workspacePath}\``);
  }

  if (planFilePath) {
    header.push(`- **Plan File:** \`${planFilePath}\``);
  }

  header.push('---', '');

  // Combine: task header + agent execution guide + worker API reference
  const parts = [header.join('\n')];
  if (agentSkillContent) {
    parts.push(agentSkillContent);
    parts.push('');
  }
  parts.push(skillContent);
  return parts.join('\n');
}

/**
 * Check if skill files are available
 * @returns {{ pm: boolean, worker: boolean }}
 */
export function getSkillAvailability() {
  return {
    pm: existsSync(SKILL_PM_PATH),
    pmCondo: existsSync(SKILL_PM_STRAND_PATH),
    pmGoal: existsSync(SKILL_PM_GOAL_PATH),
    worker: existsSync(SKILL_WORKER_PATH),
    agent: existsSync(SKILL_AGENT_PATH),
  };
}
