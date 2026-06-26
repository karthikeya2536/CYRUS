import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

const envStr = fs.readFileSync(".env", "utf8");
const env: Record<string, string> = {};
envStr.split("\n").forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) env[match[1]] = match[2];
});

const supabaseUrl = process.env.SUPABASE_URL || env["SUPABASE_URL"];
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing credentials");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { error: err1 } = await supabase
    .from("graph_nodes")
    .update({ is_stop_entity: true })
    .in("node_key", [
      'user', 'users', 'person', 'people', 'professional', 'speaker', 'individual', 
      'contact', 'email', 'document', 'resource', 'project', 'task', 'event', 
      'meeting', 'communication', 'communication_thread', 'platform', 'organization', 
      'company', 'group', 'role', 'domain', 'technology', 'skill', 'date', 
      'artifact', 'location', 'application', 'process'
    ]);
    
  if (err1) console.error("Error 1", err1);

  const { data: nodes, error: err2 } = await supabase.from("graph_nodes").select("id");
  if (err2) {
    console.error("Error 2", err2);
    return;
  }
  
  if (nodes && nodes.length > 0) {
    const nodeIds = nodes.map(n => n.id);
    const { error: err3 } = await supabase.rpc("update_graph_node_scores", { node_ids: nodeIds });
    if (err3) console.error("Error 3", err3);
    else console.log(`Successfully backfilled scores for ${nodeIds.length} nodes.`);
  } else {
    console.log("No nodes found");
  }
}

main();
