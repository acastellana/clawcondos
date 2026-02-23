/**
 * Plan Parser - Parse PM plans from markdown into tasks
 * Extracts tasks from tables and lists with agent assignments
 */

/**
 * Agent name patterns mapped to role identifiers
 * Supports emoji variants and common aliases
 */
const AGENT_MAPPINGS = {
  // Frontend agent
  'félix': 'frontend',
  'felix': 'frontend',
  'félix 🎨': 'frontend',
  'felix 🎨': 'frontend',
  '🎨 félix': 'frontend',
  '🎨 felix': 'frontend',
  'frontend': 'frontend',
  'front': 'frontend',
  
  // Backend agent
  'blake': 'backend',
  'blake 🔧': 'backend',
  '🔧 blake': 'backend',
  'backend': 'backend',
  'back': 'backend',
  
  // Designer agent
  'dana': 'designer',
  'dana ✨': 'designer',
  '✨ dana': 'designer',
  'designer': 'designer',
  'design': 'designer',
  
  // QA/Tester agent
  'quinn': 'tester',
  'quinn 🧪': 'tester',
  '🧪 quinn': 'tester',
  'qa': 'tester',
  'tester': 'tester',
  'test': 'tester',
  
  // DevOps agent
  'devon': 'devops',
  'devon 🚀': 'devops',
  '🚀 devon': 'devops',
  'devops': 'devops',
  'ops': 'devops',
  'infra': 'devops',
  
  // PM agent (Claudia)
  'claudia': 'pm',
  'claudia 📋': 'pm',
  '📋 claudia': 'pm',
  'pm': 'pm',
  'project manager': 'pm',
};

/**
 * Normalize agent name to a role identifier
 * @param {string} agentName - Raw agent name from plan
 * @returns {string|null} Role identifier or null if not found
 */
export function normalizeAgentToRole(agentName) {
  if (!agentName || typeof agentName !== 'string') {
    return null;
  }
  
  const normalized = agentName.trim().toLowerCase();
  
  // Direct lookup
  if (AGENT_MAPPINGS[normalized]) {
    return AGENT_MAPPINGS[normalized];
  }
  
  // Partial match - check if the normalized name contains any key
  for (const [key, role] of Object.entries(AGENT_MAPPINGS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return role;
    }
  }
  
  // Return as-is if no mapping found (could be a custom role)
  return agentName.trim() || null;
}

/**
 * Parse tasks from a markdown table
 * Expected formats:
 * | # | Task | Agent | Time |
 * | 1 | Do something | Félix 🎨 | 2h |
 * 
 * @param {string} content - Markdown content
 * @returns {Array<{text: string, agent: string|null, time: string|null, description: string}>}
 */
export function parseTasksFromTable(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  const tasks = [];
  const lines = content.split('\n');
  
  // Find table headers to determine column mapping
  let headerIndices = { task: -1, agent: -1, time: -1, description: -1 };
  let inTable = false;
  let headerProcessed = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) {
      inTable = false;
      headerProcessed = false;
      continue;
    }
    
    // Check if this is a table row (starts and ends with |)
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      inTable = false;
      headerProcessed = false;
      continue;
    }
    
    // Parse columns
    const columns = trimmed.split('|').map(c => c.trim()).filter(c => c !== '');
    
    // Skip separator rows (----)
    if (columns.every(c => /^[-:]+$/.test(c))) {
      continue;
    }
    
    // Process header row
    if (!headerProcessed) {
      columns.forEach((col, idx) => {
        const lc = col.toLowerCase();
        if (lc.includes('task') || lc.includes('tarea') || lc.includes('action')) {
          headerIndices.task = idx;
        } else if (lc.includes('agent') || lc.includes('agente') || lc.includes('assignee') || lc.includes('owner') || lc.includes('who') || lc.includes('role')) {
          headerIndices.agent = idx;
        } else if (lc.includes('time') || lc.includes('tiempo') || lc.includes('estimate') || lc.includes('duration') || lc.includes('est.')) {
          headerIndices.time = idx;
        } else if (lc.includes('description') || lc.includes('descripción') || lc.includes('detail') || lc.includes('notes')) {
          headerIndices.description = idx;
        }
      });
      headerProcessed = true;
      inTable = true;
      continue;
    }
    
    // Process data row
    if (inTable && headerIndices.task >= 0) {
      const taskText = columns[headerIndices.task];
      
      // Skip if task text is a number (just the row number column)
      if (!taskText || /^\d+$/.test(taskText)) {
        // Try to find task in other columns if first was just a number
        const fallbackTask = columns.find(c => c && !/^\d+$/.test(c) && c.length > 3);
        if (fallbackTask) {
          tasks.push({
            text: fallbackTask,
            agent: headerIndices.agent >= 0 ? normalizeAgentToRole(columns[headerIndices.agent]) : null,
            time: headerIndices.time >= 0 ? columns[headerIndices.time] || null : null,
            description: headerIndices.description >= 0 ? columns[headerIndices.description] || '' : '',
          });
        }
        continue;
      }
      
      tasks.push({
        text: taskText,
        agent: headerIndices.agent >= 0 ? normalizeAgentToRole(columns[headerIndices.agent]) : null,
        time: headerIndices.time >= 0 ? columns[headerIndices.time] || null : null,
        description: headerIndices.description >= 0 ? columns[headerIndices.description] || '' : '',
      });
    }
  }
  
  return tasks;
}

/**
 * Parse tasks from markdown lists
 * Expected formats:
 * - Task name (agent)
 * - Task name — agent
 * - [ ] Task name (agent)
 * - **Task name** (agent) — description
 * 
 * @param {string} content - Markdown content
 * @returns {Array<{text: string, agent: string|null, description: string}>}
 */
export function parseTasksFromLists(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  const tasks = [];
  const lines = content.split('\n');
  
  // Patterns for list items with agent assignment
  const patterns = [
    // - Task name (Agent)
    /^[-*]\s+(?:\[[ xX]?\]\s+)?(.+?)\s*\(([^)]+)\)\s*$/,
    // - Task name — Agent
    /^[-*]\s+(?:\[[ xX]?\]\s+)?(.+?)\s*[—–-]\s*([^—–\-]+?)\s*$/,
    // - **Task name** (Agent)
    /^[-*]\s+(?:\[[ xX]?\]\s+)?\*\*(.+?)\*\*\s*\(([^)]+)\)\s*$/,
    // - Task name (Agent) — Description
    /^[-*]\s+(?:\[[ xX]?\]\s+)?(.+?)\s*\(([^)]+)\)\s*[—–-]\s*(.+?)\s*$/,
    // Numbered: 1. Task name (Agent)
    /^\d+\.\s+(.+?)\s*\(([^)]+)\)\s*$/,
    // Numbered: 1. Task name — Agent
    /^\d+\.\s+(.+?)\s*[—–-]\s*([^—–\-]+?)\s*$/,
  ];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip non-list items
    if (!trimmed.match(/^[-*\d]/)) {
      continue;
    }
    
    // Try each pattern
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const [, taskText, agent, description] = match;
        
        // Clean up task text (remove markdown formatting)
        const cleanText = taskText.replace(/\*\*/g, '').replace(/`/g, '').trim();
        
        // Skip very short tasks (likely not real tasks)
        if (cleanText.length < 3) {
          continue;
        }
        
        tasks.push({
          text: cleanText,
          agent: normalizeAgentToRole(agent),
          description: description?.trim() || '',
        });
        break;
      }
    }
    
    // Also try to parse simple list items without agent
    if (tasks.length === 0 || !patterns.some(p => trimmed.match(p))) {
      const simpleMatch = trimmed.match(/^[-*]\s+(?:\[[ xX]?\]\s+)?(.{10,})$/);
      if (simpleMatch && !simpleMatch[1].includes('|')) {
        // Don't add duplicates
        const text = simpleMatch[1].replace(/\*\*/g, '').replace(/`/g, '').trim();
        if (!tasks.find(t => t.text === text)) {
          // Only add if it looks like a task (not a header or generic text)
          const looksLikeTask = text.match(/^(create|implement|add|fix|update|build|design|test|review|write|setup|configure|deploy|refactor)/i) ||
                               text.match(/\d+h?$/) || // Has time estimate
                               text.length > 15;
          if (looksLikeTask) {
            // This is a standalone task without agent - skip for now as we want assigned tasks
          }
        }
      }
    }
  }
  
  return tasks;
}

/**
 * Detect if content contains a plan
 * Looks for common plan patterns
 * 
 * @param {string} content - Content to check
 * @returns {boolean} True if content appears to contain a plan
 */
export function detectPlan(content) {
  if (!content || typeof content !== 'string') {
    return false;
  }
  
  const lowerContent = content.toLowerCase();
  
  // Check for explicit plan headers
  const planHeaders = [
    '## plan',
    '## tasks',
    '## task breakdown',
    '## implementation plan',
    '## development plan',
    '## execution plan',
    '### plan',
    '### tasks',
    '# plan',
    '**plan:**',
    '**tasks:**',
    '**task breakdown:**',
  ];
  
  for (const header of planHeaders) {
    if (lowerContent.includes(header)) {
      return true;
    }
  }
  
  // Check for approval markers
  const approvalMarkers = [
    'awaiting approval',
    'awaiting_approval',
    'pending approval',
    'please approve',
    'ready for approval',
    'approval requested',
    '⏳ awaiting',
    'status: awaiting',
  ];
  
  for (const marker of approvalMarkers) {
    if (lowerContent.includes(marker)) {
      return true;
    }
  }
  
  // Check for task tables (| Task | Agent | or similar)
  const tablePatterns = [
    /\|\s*#?\s*\|\s*task/i,
    /\|\s*task\s*\|/i,
    /\|\s*tarea\s*\|/i,
    /\|\s*agent\s*\|/i,
    /\|\s*agente\s*\|/i,
    /\|\s*assignee\s*\|/i,
    /\|\s*role\s*\|/i,
  ];
  
  for (const pattern of tablePatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }
  
  // Check for numbered tasks with agents
  const taskWithAgentPattern = /^\s*\d+\.\s+.+\s*\(.*(félix|felix|blake|dana|quinn|devon|claudia|frontend|backend|designer|tester|devops|pm)/im;
  if (taskWithAgentPattern.test(content)) {
    return true;
  }
  
  // Check for list items with agent assignments
  const listWithAgentPattern = /^[-*]\s+(?:\[[ xX]?\]\s+)?.+\s*\(.*(félix|felix|blake|dana|quinn|devon|frontend|backend|designer)/im;
  if (listWithAgentPattern.test(content)) {
    return true;
  }
  
  return false;
}

/**
 * Parse all tasks from a plan (tables + lists)
 * Prefers table tasks — if a table produced results, list parsing is skipped
 * to avoid picking up descriptive bullet points as extra tasks.
 *
 * @param {string} content - Plan markdown content
 * @returns {{tasks: Array<{text: string, agent: string|null, time: string|null, description: string}>, hasPlan: boolean}}
 */
export function parseTasksFromPlan(content) {
  if (!content || typeof content !== 'string') {
    return { tasks: [], hasPlan: false };
  }

  const hasPlan = detectPlan(content);

  // Prefer table tasks — they're structured and authoritative
  const tableTasks = parseTasksFromTable(content);

  // Only fall back to list parsing if no table tasks were found
  if (tableTasks.length > 0) {
    return { tasks: tableTasks, hasPlan };
  }

  // No table found — try parsing from lists
  const listTasks = parseTasksFromLists(content);

  // Dedupe
  const seenTexts = new Set();
  const tasks = [];

  for (const task of listTasks) {
    const normalizedText = task.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seenTexts.has(normalizedText)) {
      seenTexts.add(normalizedText);
      tasks.push(task);
    }
  }

  return { tasks, hasPlan };
}

/**
 * Detect if content contains a condo-level plan (goals breakdown)
 * Looks for goal-level plan markers like goal tables, milestone headers, etc.
 * Falls back to general plan detection.
 *
 * @param {string} content - Content to check
 * @returns {boolean} True if content appears to contain a goals plan
 */
export function detectCondoPlan(content) {
  if (!content || typeof content !== 'string') {
    return false;
  }

  const lowerContent = content.toLowerCase();

  // Check for goal-level headers
  const goalHeaders = [
    '## goals',
    '## milestones',
    '## objectives',
    '### goals',
    '### milestones',
    '### objectives',
    '# goals',
    '**goals:**',
    '**milestones:**',
    '**objectives:**',
    '## proposed goals',
    '## goal breakdown',
  ];

  for (const header of goalHeaders) {
    if (lowerContent.includes(header)) {
      return true;
    }
  }

  // Check for goal tables (| Goal | or | Milestone | or | Objective |)
  const goalTablePatterns = [
    /\|\s*#?\s*\|\s*goal/i,
    /\|\s*goal\s*\|/i,
    /\|\s*milestone\s*\|/i,
    /\|\s*objective\s*\|/i,
  ];

  for (const pattern of goalTablePatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  // Fall back to general plan detection
  return detectPlan(content);
}

/**
 * Parse goals from a condo-level plan markdown.
 * Extracts goals from tables and/or section headers, with optional embedded tasks.
 *
 * Supported formats:
 * 1. Goals table: | # | Goal | Description | Priority |
 * 2. Per-goal sections: #### 1. Goal Title  followed by task lists
 *
 * @param {string} content - Plan markdown content
 * @returns {{ goals: Array<{title: string, description: string, priority: string|null, tasks: Array<{text: string, agent: string|null}>}>, hasPlan: boolean }}
 */
export function parseGoalsFromPlan(content) {
  if (!content || typeof content !== 'string') {
    return { goals: [], hasPlan: false };
  }

  const hasPlan = detectCondoPlan(content);
  const goals = [];

  // Step 1: Try to parse goals from a table
  const tableGoals = parseGoalsFromTable(content);
  if (tableGoals.length > 0) {
    goals.push(...tableGoals);
  }

  // Step 2: Parse per-goal task sections
  // Look for patterns like: #### 1. Goal Title  or  ### Goal: Title
  const goalSections = parseGoalSections(content);

  // Merge: if we got goals from table, attach tasks from matching sections
  if (goals.length > 0 && goalSections.length > 0) {
    for (const goal of goals) {
      // Try to match section by title similarity
      const matchingSection = goalSections.find(s =>
        s.title.toLowerCase().includes(goal.title.toLowerCase()) ||
        goal.title.toLowerCase().includes(s.title.toLowerCase())
      );
      if (matchingSection && matchingSection.tasks.length > 0) {
        goal.tasks = matchingSection.tasks;
      }
    }
  } else if (goals.length === 0 && goalSections.length > 0) {
    // No table found — use sections as goals
    goals.push(...goalSections);
  }

  return { goals, hasPlan };
}

/**
 * Parse goals from a markdown table
 * @param {string} content - Markdown content
 * @returns {Array<{title: string, description: string, priority: string|null, tasks: Array}>}
 */
function parseGoalsFromTable(content) {
  const goals = [];
  const lines = content.split('\n');

  let headerIndices = { goal: -1, description: -1, priority: -1, phase: -1 };
  let headerProcessed = false;
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      inTable = false;
      headerProcessed = false;
      continue;
    }

    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      inTable = false;
      headerProcessed = false;
      continue;
    }

    const columns = trimmed.split('|').map(c => c.trim()).filter(c => c !== '');

    // Skip separator rows
    if (columns.every(c => /^[-:]+$/.test(c))) {
      continue;
    }

    // Process header row
    if (!headerProcessed) {
      columns.forEach((col, idx) => {
        const lc = col.toLowerCase();
        if (lc.includes('goal') || lc.includes('milestone') || lc.includes('objective')) {
          headerIndices.goal = idx;
        } else if (lc.includes('description') || lc.includes('detail') || lc.includes('scope')) {
          headerIndices.description = idx;
        } else if (lc.includes('priority') || lc.includes('importance') || lc.includes('order')) {
          headerIndices.priority = idx;
        } else if (lc.includes('phase') || lc.includes('wave') || lc.includes('stage')) {
          headerIndices.phase = idx;
        }
      });
      headerProcessed = true;
      inTable = true;
      continue;
    }

    // Process data row
    if (inTable && headerIndices.goal >= 0) {
      let title = columns[headerIndices.goal];

      // Skip if title is just a number (row index column)
      if (!title || /^\d+$/.test(title)) {
        // Try to find a text column
        title = columns.find(c => c && !/^\d+$/.test(c) && c.length > 3);
        if (!title) continue;
      }

      // Clean up markdown formatting
      title = title.replace(/\*\*/g, '').replace(/`/g, '').trim();

      // Parse phase value
      let phase = null;
      if (headerIndices.phase >= 0) {
        const rawPhase = (columns[headerIndices.phase] || '').trim();
        const parsed = parseInt(rawPhase, 10);
        if (!isNaN(parsed) && parsed > 0) {
          phase = parsed;
        }
      }

      goals.push({
        title,
        description: headerIndices.description >= 0 ? (columns[headerIndices.description] || '').replace(/\*\*/g, '').trim() : '',
        priority: headerIndices.priority >= 0 ? (columns[headerIndices.priority] || '').trim() || null : null,
        phase,
        tasks: [],
      });
    }
  }

  return goals;
}

/**
 * Parse goal sections with embedded tasks from markdown
 * Looks for headings like #### 1. Goal Title followed by task lists
 * @param {string} content - Markdown content
 * @returns {Array<{title: string, description: string, priority: string|null, tasks: Array<{text: string, agent: string|null}>}>}
 */
function parseGoalSections(content) {
  const goals = [];
  const lines = content.split('\n');

  // Match headings like: #### 1. Goal Title  or  ### Goal: Title  or  **1. Goal Title**
  const headingPattern = /^#{2,5}\s+(?:\d+\.\s*)?(.+)$/;

  let currentGoal = null;
  let currentTaskBlock = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const headingMatch = trimmed.match(headingPattern);
    if (headingMatch) {
      // Save previous goal
      if (currentGoal) {
        if (currentTaskBlock.length > 0) {
          currentGoal.tasks = parseTasksFromLists(currentTaskBlock.join('\n'));
        }
        goals.push(currentGoal);
      }

      const title = headingMatch[1].replace(/\*\*/g, '').trim();

      // Skip headers that are clearly not goal titles
      const skipHeaders = ['goals', 'milestones', 'objectives', 'plan', 'tasks', 'task breakdown',
        'overview', 'summary', 'introduction', 'proposed goals', 'goal breakdown',
        'available roles', 'pm session context', 'implementation plan', 'development plan',
        'execution plan'];
      if (skipHeaders.includes(title.toLowerCase())) {
        currentGoal = null;
        currentTaskBlock = [];
        continue;
      }

      currentGoal = {
        title,
        description: '',
        priority: null,
        tasks: [],
      };
      currentTaskBlock = [];
      continue;
    }

    // Collect lines under a goal heading for task extraction
    if (currentGoal) {
      currentTaskBlock.push(line);
    }
  }

  // Save last goal
  if (currentGoal) {
    if (currentTaskBlock.length > 0) {
      currentGoal.tasks = parseTasksFromLists(currentTaskBlock.join('\n'));
    }
    goals.push(currentGoal);
  }

  return goals;
}

/**
 * Convert phase numbers on goals into dependsOn arrays.
 * Goals in phase N depend on ALL goals in phase N-1, creating wave-based execution.
 *
 * @param {Array<{phase?: number|null, id?: string}>} goals - Parsed goals with optional phase and id
 * @returns {Array} The same goals array, mutated with dependsOn set
 */
export function convertPhasesToDependsOn(goals) {
  if (!Array.isArray(goals) || goals.length === 0) return goals;

  // Group goals by phase
  const byPhase = new Map();
  for (const goal of goals) {
    const p = goal.phase || null;
    if (p == null) continue;
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p).push(goal);
  }

  // Sort phases ascending
  const phases = [...byPhase.keys()].sort((a, b) => a - b);

  // For each phase > first, depend on all goals from the previous phase
  for (let i = 1; i < phases.length; i++) {
    const prevPhaseGoals = byPhase.get(phases[i - 1]);
    const prevIds = prevPhaseGoals.map(g => g.id).filter(Boolean);
    if (prevIds.length === 0) continue;

    for (const goal of byPhase.get(phases[i])) {
      goal.dependsOn = prevIds;
    }
  }

  return goals;
}

/**
 * Get all supported agent roles
 * @returns {string[]} List of role identifiers
 */
export function getSupportedRoles() {
  return [...new Set(Object.values(AGENT_MAPPINGS))];
}
