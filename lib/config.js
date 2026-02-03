/**
 * ClawCondos Configuration
 * 
 * Configure ClawCondos by setting window.CLAWCONDOS_CONFIG before loading the dashboard,
 * or by creating a config.json file served at /config.json
 */

const DEFAULT_CONFIG = {
  // Gateway WebSocket URL (for chat, sessions)
  // Default: wss://{current hostname}/
  gatewayWsUrl: null,
  
  // Gateway HTTP URL (for API calls)
  // Default: https://{current hostname}
  gatewayHttpUrl: null,
  
  // Apps registry URL (returns JSON array of apps)
  // Default: /api/apps
  appsUrl: '/api/apps',
  
  // Branding
  branding: {
    name: 'ClawCondos',
    logo: '🏙️',
    tagline: 'Goals-First Dashboard'
  },
  
  // Session settings
  sessions: {
    pollInterval: 30000,  // Refresh sessions every 30s
    defaultLimit: 50      // Default number of sessions to load
  },
  
  // Features
  features: {
    showApps: true,       // Show apps section in sidebar
    showSubagents: true,  // Show sub-agents section
    showAgents: true,     // Show agents section (for multi-agent setups)

    // Rendering / safety
    formatUserMessages: false,  // If true, apply markdown-ish formatting to user messages (bold/italics/code/media)
    allowExternalMedia: false   // If true, allow http(s) media embeds (images/audio/links) from external hosts
  }
};

// Build smart defaults based on location
function buildDefaults() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  
  return {
    gatewayWsUrl: `${wsProtocol}//${hostname}/`,
    gatewayHttpUrl: `${protocol}//${hostname}`
  };
}

// Merge configs (deep merge for nested objects)
function mergeConfig(base, override) {
  const result = { ...base };
  
  for (const key of Object.keys(override)) {
    if (override[key] !== null && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = mergeConfig(result[key] || {}, override[key]);
    } else if (override[key] !== null && override[key] !== undefined) {
      result[key] = override[key];
    }
  }
  
  return result;
}

// Load config from window.CLAWCONDOS_CONFIG or fetch from /config.json
async function loadConfig() {
  let userConfig = {};
  
  // Check for inline config
  if (window.CLAWCONDOS_CONFIG) {
    userConfig = window.CLAWCONDOS_CONFIG;
  } else {
    // Try to fetch config.json (optional)
    try {
      const res = await fetch('/config.json');
      if (res.ok) {
        userConfig = await res.json();
      }
    } catch {
      // Config file not found, use defaults
    }
  }
  
  // Build final config
  const defaults = buildDefaults();
  const config = mergeConfig(DEFAULT_CONFIG, defaults);
  return mergeConfig(config, userConfig);
}

// Synchronous getter (uses cached config or defaults)
let _cachedConfig = null;

function getConfig() {
  if (_cachedConfig) return _cachedConfig;
  
  // Build synchronous defaults
  const defaults = buildDefaults();
  const config = mergeConfig(DEFAULT_CONFIG, defaults);
  
  // Merge inline config if available
  if (window.CLAWCONDOS_CONFIG) {
    return mergeConfig(config, window.CLAWCONDOS_CONFIG);
  }
  
  return config;
}

// Initialize config (call early, before using getConfig)
async function initConfig() {
  _cachedConfig = await loadConfig();
  return _cachedConfig;
}

// Export for both module and global use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getConfig, initConfig, loadConfig, DEFAULT_CONFIG };
} else {
  window.ClawCondosConfig = { getConfig, initConfig, loadConfig, DEFAULT_CONFIG };
}
