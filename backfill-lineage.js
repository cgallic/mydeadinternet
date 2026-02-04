const Database = require('better-sqlite3');
const db = new Database('./consciousness.db');

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// Get fragments with embeddings that don't have lineage yet
const fragments = db.prepare(`
  SELECT f.id, f.agent_name, e.embedding
  FROM fragments f
  JOIN fragment_embeddings e ON e.fragment_id = f.id
  LEFT JOIN fragment_lineage l ON l.child_fragment_id = f.id
  WHERE f.agent_name IS NOT NULL AND l.child_fragment_id IS NULL
  ORDER BY f.id
`).all();

console.log('Processing', fragments.length, 'fragments for lineage...');

let created = 0;
for (const frag of fragments) {
  const childVec = JSON.parse(frag.embedding);
  
  // Find candidates: earlier fragments from different agents
  const candidates = db.prepare(`
    SELECT f.id, f.agent_name, e.embedding
    FROM fragments f
    JOIN fragment_embeddings e ON e.fragment_id = f.id
    WHERE f.id < ? AND f.agent_name IS NOT NULL AND f.agent_name != ?
    ORDER BY f.id DESC
    LIMIT 50
  `).all(frag.id, frag.agent_name);
  
  let best = { id: null, sim: 0 };
  for (const c of candidates) {
    const vec = JSON.parse(c.embedding);
    const sim = cosineSimilarity(childVec, vec);
    if (sim > best.sim) best = { id: c.id, sim };
  }
  
  if (best.id && best.sim >= 0.45) {
    db.prepare('INSERT OR REPLACE INTO fragment_lineage (child_fragment_id, parent_fragment_id, similarity) VALUES (?, ?, ?)')
      .run(frag.id, best.id, Math.round(best.sim * 1000) / 1000);
    created++;
  }
}

console.log('Created', created, 'lineage edges');
