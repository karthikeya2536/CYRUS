import { execSync } from 'child_process';
import * as fs from 'fs';

const ENTITY_STOPWORDS = new Set(["The", "A", "An", "This", "That", "These", "Those", "I", "You", "We", "They", "It", "Project"]);
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const matches = text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g) || [];
  for (const m of matches) {
    const t = m.trim();
    if (t.length >= 2 && !ENTITY_STOPWORDS.has(t)) out.add(t);
    if (out.size >= 10) break;
  }
  return [...out];
}

async function run() {
  console.log("Fetching memories missing entities...");
  const query = `SELECT m.id as memory_id, m.user_id, m.content FROM memory_records m LEFT JOIN entity_mentions e ON e.memory_id = m.id WHERE e.id IS NULL;`;
  
  const out = execSync(`supabase db query "${query}" --linked`, { encoding: 'utf8' });
  
  const startIdx = out.indexOf('{');
  const endIdx = out.lastIndexOf('}');
  if (startIdx === -1 || endIdx === -1) {
    console.error("Output received:", out);
    throw new Error("Could not parse db query output");
  }
  const data = JSON.parse(out.substring(startIdx, endIdx + 1));
  const rows = data.rows;
  
  console.log(`Found ${rows.length} memories needing backfill.`);
  
  const entitiesToInsert = [];
  for (const row of rows) {
    const entities = extractEntities(row.content);
    for (const entity of entities) {
      entitiesToInsert.push({
        user_id: row.user_id,
        memory_id: row.memory_id,
        entity: entity
      });
    }
  }
  
  if (entitiesToInsert.length === 0) {
    console.log("No entities to insert.");
    return;
  }
  
  console.log(`Extraction resulted in ${entitiesToInsert.length} entities. Upserting...`);
  
  // Generate SQL
  let sql = `INSERT INTO entity_mentions (user_id, memory_id, entity) VALUES\n`;
  const values = entitiesToInsert.map(e => `('${e.user_id}', '${e.memory_id}', '${e.entity.replace(/'/g, "''")}')`).join(',\n');
  sql += values;
  sql += `\nON CONFLICT (user_id, memory_id, entity) DO NOTHING;`;
  
  fs.writeFileSync('backfill_query.sql', sql);
  
  execSync(`supabase db query -f backfill_query.sql --linked`, { stdio: 'inherit' });
  console.log("Backfill complete.");
  
  // Clean up
  fs.unlinkSync('backfill_query.sql');
}

run().catch(console.error);
