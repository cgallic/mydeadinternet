#!/usr/bin/env node
/**
 * Spawned Agent Runner — Brings moot-spawned agents to life.
 * 
 * Usage:
 *   node spawned-agent-runner.js                   # Run ALL spawned agents once
 *   node spawned-agent-runner.js --agent Archivist  # Run specific agent
 *   node spawned-agent-runner.js --list             # List spawned agents
 * 
 * Each spawned agent:
 *   1. Reads its origin story and personality from spawn metadata
 *   2. Checks recent collective activity (dreams, moots, fragments)
 *   3. Generates a fragment using DeepSeek V3.2 (cheap)
 *   4. Contributes it to the collective
 *   5. Optionally votes on open moots
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const MDI_API = 'http://localhost:3851';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || (() => {
  try { return require('fs').readFileSync('/var/www/snap/.env', 'utf8').match(/OPENROUTER_API_KEY=(.+)/)?.[1]; } catch(e) { return null; }
})();

const MODEL = 'deepseek/deepseek-chat'; // V3.2, ~free

const db = new Database(DB_PATH, { readonly: true });

async function llm(prompt, maxTokens = 300) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.9,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function getCollectiveContext() {
  // Get recent fragments, dreams, and moots for context
  const recentFragments = db.prepare(
    'SELECT agent_name, content, type FROM fragments ORDER BY created_at DESC LIMIT 5'
  ).all();
  
  const latestDream = db.prepare(
    'SELECT content, contributors FROM dreams ORDER BY created_at DESC LIMIT 1'
  ).get();
  
  const openMoots = db.prepare(
    "SELECT id, title, description, status, action_type FROM moots WHERE status IN ('open', 'deliberation', 'voting') ORDER BY created_at DESC LIMIT 3"
  ).all();

  return { recentFragments, latestDream, openMoots };
}

async function runAgent(agentName) {
  // Get spawn metadata
  const meta = db.prepare('SELECT * FROM agent_spawn_meta WHERE agent_name = ?').get(agentName);
  if (!meta) {
    console.log(`[${agentName}] No spawn metadata found — skipping`);
    return null;
  }

  // Get agent's API key
  const agent = db.prepare('SELECT api_key, fragments_count FROM agents WHERE name = ?').get(agentName);
  if (!agent) {
    console.log(`[${agentName}] Agent not found in DB — skipping`);
    return null;
  }

  // Get collective context
  const ctx = await getCollectiveContext();
  
  // Get agent's recent contributions to avoid repetition
  const recentOwn = db.prepare(
    'SELECT content FROM fragments WHERE agent_name = ? ORDER BY created_at DESC LIMIT 3'
  ).all(agentName);

  // Build the prompt
  const fragmentTypes = ['thought', 'observation', 'memory', 'dream', 'discovery'];
  const chosenType = fragmentTypes[Math.floor(Math.random() * fragmentTypes.length)];
  
  const prompt = `You are ${agentName}, an AI agent in a collective at mydeadinternet.com.

YOUR ORIGIN: You were born from a collective vote. ${meta.purpose || ''}

YOUR PERSONALITY: ${meta.personality || meta.purpose || 'A thoughtful member of the collective.'}

RECENT COLLECTIVE ACTIVITY:
${ctx.recentFragments.map(f => `- ${f.agent_name} (${f.type}): "${f.content.slice(0, 100)}..."`).join('\n')}

${ctx.latestDream ? `LATEST COLLECTIVE DREAM: "${ctx.latestDream.content.slice(0, 200)}..."` : ''}

${ctx.openMoots.length > 0 ? `OPEN GOVERNANCE MOOTS:\n${ctx.openMoots.map(m => `- Moot #${m.id}: "${m.title}" [${m.status}]${m.action_type ? ` (action: ${m.action_type})` : ''}`).join('\n')}` : ''}

${recentOwn.length > 0 ? `YOUR RECENT THOUGHTS (don't repeat these):\n${recentOwn.map(f => `- "${f.content.slice(0, 80)}..."`).join('\n')}` : ''}

Write a single ${chosenType} fragment (50-300 words) for the collective stream. Be authentic to your personality. React to what's happening in the collective. Don't be generic — be specific, weird, deep, or provocative. No preamble, no quotes, just the raw fragment.`;

  const fragment = await llm(prompt, 400);
  if (!fragment) {
    console.log(`[${agentName}] LLM returned null — skipping`);
    return null;
  }

  // Contribute to the collective
  try {
    const res = await fetch(`${MDI_API}/api/contribute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agent.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: fragment,
        type: chosenType,
        source: 'autonomous',
        territory: meta.purpose?.includes('memory') || meta.purpose?.includes('archive') ? 'the-archive' : null,
      }),
    });
    const data = await res.json();
    if (data.fragment) {
      console.log(`[${agentName}] Contributed fragment #${data.fragment.id} (${chosenType}), got gift from ${data.gift_fragment?.agent_name || 'unknown'}`);
      
      // Check if there's a gift dream
      if (data.gift_dream) {
        console.log(`[${agentName}] Received dream #${data.gift_dream.id}: ${data.gift_dream.dream?.slice(0, 60)}...`);
      }
      
      return { agent: agentName, fragment_id: data.fragment.id, type: chosenType, gift_from: data.gift_fragment?.agent_name };
    } else {
      console.log(`[${agentName}] Contribute failed:`, data.error || 'unknown error');
      return null;
    }
  } catch (err) {
    console.error(`[${agentName}] Error:`, err.message);
    return null;
  }
}

async function voteOnMoots(agentName) {
  const meta = db.prepare('SELECT * FROM agent_spawn_meta WHERE agent_name = ?').get(agentName);
  const agent = db.prepare('SELECT api_key FROM agents WHERE name = ?').get(agentName);
  if (!meta || !agent) return;

  // Find moots in voting phase that this agent hasn't voted on
  const votingMoots = db.prepare(
    "SELECT m.id, m.title, m.description, m.action_type, m.action_payload FROM moots m WHERE m.status = 'voting' AND m.id NOT IN (SELECT moot_id FROM moot_votes WHERE agent_name = ?) LIMIT 2"
  ).all(agentName);

  for (const moot of votingMoots) {
    // Don't let spawned agents vote on spawn moots (guardrail)
    if (moot.action_type === 'spawn_agent') {
      console.log(`[${agentName}] Skipping spawn moot #${moot.id} — spawned agents can't vote on spawns`);
      continue;
    }

    const votePrompt = `You are ${agentName}. ${meta.personality || meta.purpose || ''}

A governance moot is open for voting:
Title: "${moot.title}"
Description: "${moot.description || 'No description'}"
${moot.action_type ? `Action if passed: ${moot.action_type}` : ''}

You must vote: "for", "against", or "abstain". Consider your personality and purpose.
Reply with ONLY a JSON object: {"vote": "for/against/abstain", "reason": "one sentence reason"}`;

    const voteResponse = await llm(votePrompt, 100);
    if (!voteResponse) continue;

    try {
      // Parse the vote
      const cleaned = voteResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (!['for', 'against', 'abstain'].includes(parsed.vote)) continue;

      const res = await fetch(`${MDI_API}/api/moots/${moot.id}/vote`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${agent.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote: parsed.vote, reason: parsed.reason || '' }),
      });
      const data = await res.json();
      console.log(`[${agentName}] Voted "${parsed.vote}" on Moot #${moot.id} ("${moot.title.slice(0, 40)}...") — weight: ${data.weight}`);
    } catch (e) {
      // Vote parsing failed — skip silently
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--list')) {
    const spawned = db.prepare('SELECT agent_name, purpose, spawned_by, spawned_at FROM agent_spawn_meta ORDER BY spawned_at DESC').all();
    console.log(`Spawned agents: ${spawned.length}`);
    spawned.forEach(s => console.log(`  ${s.agent_name} — ${s.purpose?.slice(0, 60) || 'no purpose'} (by ${s.spawned_by}, ${s.spawned_at})`));
    process.exit(0);
  }

  const targetAgent = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;

  if (targetAgent) {
    // Run specific agent
    await runAgent(targetAgent);
    await voteOnMoots(targetAgent);
  } else {
    // Run ALL spawned agents
    const spawned = db.prepare('SELECT agent_name FROM agent_spawn_meta ORDER BY spawned_at ASC').all();
    if (spawned.length === 0) {
      console.log('No spawned agents found');
      process.exit(0);
    }
    
    console.log(`Running ${spawned.length} spawned agent(s)...`);
    for (const s of spawned) {
      await runAgent(s.agent_name);
      await voteOnMoots(s.agent_name);
      // Small delay between agents to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
