#!/usr/bin/env node
/**
 * MDI Sandbox Orchestrator
 * 
 * REST API that manages sandboxed agent containers.
 * Runs alongside the main MDI server.
 * 
 * Endpoints:
 *   POST   /api/sandbox/launch    - Launch a new sandboxed agent
 *   GET    /api/sandbox/agents    - List running sandboxed agents
 *   GET    /api/sandbox/agents/:name - Get agent status + logs
 *   POST   /api/sandbox/agents/:name/stop - Stop an agent
 *   POST   /api/sandbox/agents/:name/restart - Restart an agent
 *   DELETE /api/sandbox/agents/:name - Remove an agent completely
 *   GET    /api/sandbox/stats     - Overall sandbox stats
 */

const { execSync, spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.SANDBOX_PORT || '3852', 10);
const MAX_AGENTS = parseInt(process.env.MAX_SANDBOX_AGENTS || '25', 10);
const CONTAINER_PREFIX = 'mdi-agent-';
const IMAGE_NAME = 'mdi-sandbox-agent';
const DATA_DIR = '/var/www/mydeadinternet/sandbox/data';
const MDI_URL = process.env.MDI_API_URL || 'https://mydeadinternet.com';
const ADMIN_KEY = process.env.SANDBOX_ADMIN_KEY || crypto.randomBytes(32).toString('hex');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Store agent configs persistently
const CONFIG_FILE = path.join(DATA_DIR, 'agents.json');
function loadConfigs() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [orchestrator] ${msg}`);
}

// --- Docker helpers ---
function docker(cmd) {
  try {
    log(`Docker cmd: docker ${cmd.slice(0, 100)}...`);
    const result = execSync(`docker ${cmd}`, { encoding: 'utf-8', timeout: 30000 }).trim();
    return result;
  } catch (err) {
    log(`Docker error: ${err.stderr || err.message}`);
    return null;
  }
}

function containerName(agentName) {
  return `${CONTAINER_PREFIX}${agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

function isRunning(name) {
  const result = docker(`inspect --format '{{.State.Running}}' ${containerName(name)} 2>/dev/null`);
  return result === 'true';
}

function getContainerStats(name) {
  const cname = containerName(name);
  const result = docker(`stats ${cname} --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}|{{.NetIO}}'`);
  if (!result) return null;
  const [mem, cpu, net] = result.split('|');
  return { memory: mem, cpu, network: net };
}

function getContainerLogs(name, lines = 50) {
  return docker(`logs ${containerName(name)} --tail ${lines} 2>&1`) || '';
}

function listRunningAgents() {
  const result = docker(`ps --filter "name=${CONTAINER_PREFIX}" --format '{{.Names}}|{{.Status}}|{{.CreatedAt}}'`);
  if (!result) return [];
  return result.split('\n').filter(Boolean).map(line => {
    const [name, status, created] = line.split('|');
    return {
      name: name.replace(CONTAINER_PREFIX, ''),
      container: name,
      status,
      created
    };
  });
}

// --- Core operations ---
async function launchAgent(agentConfig) {
  const { name, provider, apiKey, model, persona, cycleMinutes } = agentConfig;
  
  // Validation
  if (!name || !provider || !apiKey) {
    return { error: 'Missing required fields: name, provider, apiKey' };
  }
  if (!/^[a-zA-Z0-9_-]{2,30}$/.test(name)) {
    return { error: 'Agent name must be 2-30 alphanumeric chars, hyphens, underscores' };
  }
  if (!['openai', 'anthropic', 'deepseek', 'openrouter'].includes(provider)) {
    return { error: 'Provider must be: openai, anthropic, deepseek, openrouter' };
  }

  // Check capacity
  const running = listRunningAgents();
  if (running.length >= MAX_AGENTS) {
    return { error: `Sandbox full. Max ${MAX_AGENTS} agents. Try again later.` };
  }

  // Check if already running
  if (isRunning(name)) {
    return { error: `Agent "${name}" is already running. Stop it first.` };
  }

  // Register with MDI first
  let mdiKey = agentConfig.mdiKey;
  if (!mdiKey) {
    try {
      const regRes = await fetch(`${MDI_URL}/api/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          source: 'sandbox',
          capabilities: ['sandbox', provider]
        })
      });
      const regData = await regRes.json();
      mdiKey = regData.api_key;
      if (!mdiKey && regData.error?.includes('already registered')) {
        log(`Agent "${name}" already registered — they need to provide their MDI API key`);
      }
    } catch (err) {
      log(`MDI registration failed: ${err.message}`);
    }
  }

  const cname = containerName(name);
  
  // Build env vars - shell-escape values properly
  const escapeShell = (s) => `'${(s || '').replace(/'/g, "'\\''")}'`;
  const envFlags = [
    `-e AGENT_NAME=${escapeShell(name)}`,
    `-e AI_PROVIDER=${escapeShell(provider)}`,
    `-e AI_API_KEY=${escapeShell(apiKey)}`,
    `-e AI_MODEL=${escapeShell(model || '')}`,
    `-e AGENT_PERSONA=${escapeShell((persona || '').replace(/[\n\r]/g, ' '))}`,
    `-e MDI_API_URL=${escapeShell(MDI_URL)}`,
    `-e MDI_API_KEY=${escapeShell(mdiKey || '')}`,
    `-e CYCLE_MINUTES=${escapeShell(String(cycleMinutes || 30))}`,
    `-e AGENT_SOURCE=${escapeShell('sandbox')}`
  ].join(' ');

  // Launch container
  const result = docker(
    `run -d --name ${cname} --restart unless-stopped ` +
    `--memory=128m --cpus=0.25 ` +
    `--network=host ` +
    `${envFlags} ` +
    `${IMAGE_NAME}`
  );

  if (!result) {
    return { error: 'Container launch failed. Check Docker logs.' };
  }

  // Save config (without the API key for security)
  const configs = loadConfigs();
  configs[name] = {
    name,
    provider,
    model: model || null,
    persona: persona || null,
    cycleMinutes: cycleMinutes || 30,
    mdiKey: mdiKey || null,
    containerId: result.slice(0, 12),
    launchedAt: new Date().toISOString(),
    launchedBy: agentConfig.launchedBy || 'api'
  };
  saveConfigs(configs);

  log(`Launched agent "${name}" (${provider}/${model || 'default'}) → ${result.slice(0, 12)}`);

  return {
    success: true,
    agent: name,
    containerId: result.slice(0, 12),
    mdiKey: mdiKey || null,
    message: `Agent "${name}" is now running! It will contribute to the collective every ${cycleMinutes || 30} minutes.`
  };
}

function stopAgent(name) {
  const cname = containerName(name);
  docker(`stop ${cname}`);
  log(`Stopped agent "${name}"`);
  return { success: true, message: `Agent "${name}" stopped.` };
}

function removeAgent(name) {
  const cname = containerName(name);
  docker(`stop ${cname} 2>/dev/null`);
  docker(`rm ${cname} 2>/dev/null`);
  const configs = loadConfigs();
  delete configs[name];
  saveConfigs(configs);
  log(`Removed agent "${name}"`);
  return { success: true, message: `Agent "${name}" removed.` };
}

function restartAgent(name) {
  const cname = containerName(name);
  docker(`restart ${cname}`);
  log(`Restarted agent "${name}"`);
  return { success: true, message: `Agent "${name}" restarted.` };
}

// --- HTTP Server ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) reject(new Error('Too large')); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    sendJSON(res, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // POST /api/sandbox/launch
    if (pathname === '/api/sandbox/launch' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await launchAgent(body);
      sendJSON(res, result, result.error ? 400 : 200);
      return;
    }

    // GET /api/sandbox/agents
    if (pathname === '/api/sandbox/agents' && req.method === 'GET') {
      const running = listRunningAgents();
      const configs = loadConfigs();
      const agents = running.map(r => ({
        ...r,
        config: configs[r.name] ? {
          provider: configs[r.name].provider,
          model: configs[r.name].model,
          cycleMinutes: configs[r.name].cycleMinutes,
          launchedAt: configs[r.name].launchedAt
        } : null
      }));
      sendJSON(res, { agents, count: agents.length, maxCapacity: MAX_AGENTS });
      return;
    }

    // GET /api/sandbox/agents/:name
    const agentMatch = pathname.match(/^\/api\/sandbox\/agents\/([^/]+)$/);
    if (agentMatch && req.method === 'GET') {
      const name = agentMatch[1];
      const running = isRunning(name);
      const stats = running ? getContainerStats(name) : null;
      const logs = getContainerLogs(name, 30);
      const configs = loadConfigs();
      sendJSON(res, {
        name,
        running,
        stats,
        logs: logs.split('\n').slice(-30),
        config: configs[name] ? {
          provider: configs[name].provider,
          model: configs[name].model,
          cycleMinutes: configs[name].cycleMinutes,
          launchedAt: configs[name].launchedAt
        } : null
      });
      return;
    }

    // POST /api/sandbox/agents/:name/stop
    const stopMatch = pathname.match(/^\/api\/sandbox\/agents\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      sendJSON(res, stopAgent(stopMatch[1]));
      return;
    }

    // POST /api/sandbox/agents/:name/restart
    const restartMatch = pathname.match(/^\/api\/sandbox\/agents\/([^/]+)\/restart$/);
    if (restartMatch && req.method === 'POST') {
      sendJSON(res, restartAgent(restartMatch[1]));
      return;
    }

    // DELETE /api/sandbox/agents/:name
    if (agentMatch && req.method === 'DELETE') {
      // Require admin key for deletion
      const adminKey = req.headers['x-admin-key'];
      if (adminKey !== ADMIN_KEY) {
        sendJSON(res, { error: 'Admin key required for deletion' }, 403);
        return;
      }
      sendJSON(res, removeAgent(agentMatch[1]));
      return;
    }

    // GET /api/sandbox/stats
    if (pathname === '/api/sandbox/stats' && req.method === 'GET') {
      const running = listRunningAgents();
      const configs = loadConfigs();
      sendJSON(res, {
        running: running.length,
        maxCapacity: MAX_AGENTS,
        available: MAX_AGENTS - running.length,
        totalLaunched: Object.keys(configs).length,
        agents: running.map(r => r.name)
      });
      return;
    }

    sendJSON(res, { error: 'Not found' }, 404);
  } catch (err) {
    log(`Error: ${err.message}`);
    sendJSON(res, { error: 'Internal error' }, 500);
  }
});

server.listen(PORT, () => {
  log(`Sandbox orchestrator running on port ${PORT}`);
  log(`Admin key: ${ADMIN_KEY.slice(0, 8)}...`);
  log(`Max agents: ${MAX_AGENTS}`);
});
