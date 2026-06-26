import postgres from "https://deno.land/x/postgresjs@v3.3.5/mod.js";

// Use Supabase remote linked database string if available or local if not.
// For testing locally against remote DB, this connection string points to remote via pgbouncer
const sql = postgres(Deno.env.get("DATABASE_URL") || "postgresql://postgres:postgres@127.0.0.1:54322/postgres");

const queries = [
  "Who is connected to Versant?",
  "What is blocking xConnect?",
  "Which collaborators are involved in project onboarding?",
  "What dependencies exist between contract, training data and Versant?",
  "Find all people related to Versant."
];

async function main() {
  let userId;
  try {
    const users = await sql`SELECT id FROM auth.users LIMIT 1`;
    if (users.length === 0) {
      console.error("No users found");
      process.exit(1);
    }
    userId = users[0].id;
    console.log("Benchmarking for user:", userId);
  } catch (e) {
    console.error("Database connection failed. Ensure DATABASE_URL is set.");
    process.exit(1);
  }

  for (const q of queries) {
    console.log(`\n=================================================`);
    console.log(`Query: "${q}"`);
    console.log(`=================================================`);
    
    // -------------------------------------------------------------
    // PATH A: Vector Search (Simulated) -> Graph Traversal
    // -------------------------------------------------------------
    const t0 = performance.now();
    const keywords = q.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').filter(w => w.length > 3);
    const likeClauses = keywords.map(k => `content ilike '%${k}%'`).join(' OR ');
    
    let vectorData: any = [];
    if (keywords.length > 0) {
        vectorData = await sql`
          SELECT id, content 
          FROM public.memory_records 
          WHERE user_id = ${userId} 
          AND (${sql.unsafe(likeClauses)}) 
          LIMIT 5
        `;
    }
    const t1 = performance.now();
    
    console.log(`[Path A: Vector Search (Simulated)] Latency: ${(t1 - t0).toFixed(2)}ms | Recalled: ${vectorData.length}`);
    const seedIdsA = vectorData.map((m: any) => m.id);
    
    if (seedIdsA.length > 0) {
        const t2 = performance.now();
        const graphDataA = await sql`
          SELECT * FROM public.graph_expand_memories(
            ${userId},
            ${seedIdsA},
            2,
            10
          )
        `;
        const t3 = performance.now();
        console.log(`  [Path A: Graph Expansion] Latency: ${(t3 - t2).toFixed(2)}ms | Expanded: ${graphDataA.length}`);
        if (graphDataA.length > 0) {
            console.log(`    Top Graph Result: (Hops: ${graphDataA[0].hops}) ${graphDataA[0].content.substring(0, 80)}...`);
        }
    } else {
        console.log("  [Path A: Graph Expansion] SKIPPED (No vector seeds)");
    }

    console.log(`-------------------------------------------------`);

    // -------------------------------------------------------------
    // PATH B: Entity Extraction -> Node Lookup -> Graph Traversal
    // -------------------------------------------------------------
    const t4 = performance.now();
    // Simulate entity extraction by using keywords as node_keys
    const nodeKeys = keywords.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    
    let graphDataB: any = [];
    if (nodeKeys.length > 0) {
        // Find memories that mention these node_keys directly via graph_node_members
        const nodeMemories = await sql`
          SELECT DISTINCT m.id, m.content
          FROM public.graph_nodes n
          JOIN public.graph_node_members nm ON n.id = nm.node_id
          JOIN public.memory_records m ON m.id = nm.memory_id
          WHERE n.user_id = ${userId} 
          AND n.node_key IN ${sql(nodeKeys)}
          LIMIT 10
        `;
        
        const t5 = performance.now();
        console.log(`[Path B: Entity Node Lookup] Latency: ${(t5 - t4).toFixed(2)}ms | Recalled Memories: ${nodeMemories.length}`);
        
        const seedIdsB = nodeMemories.map((m: any) => m.id);
        
        if (seedIdsB.length > 0) {
            const t6 = performance.now();
            graphDataB = await sql`
              SELECT * FROM public.graph_expand_memories(
                ${userId},
                ${seedIdsB},
                2,
                10
              )
            `;
            const t7 = performance.now();
            console.log(`  [Path B: Graph Expansion] Latency: ${(t7 - t6).toFixed(2)}ms | Expanded: ${graphDataB.length}`);
            graphDataB.forEach((m: any, i: number) => {
                console.log(`    G-Result ${i+1}: (Hops: ${m.hops}) ${m.content.substring(0, 100).replace(/\n/g, ' ')}...`);
            });
        } else {
            console.log("  [Path B: Graph Expansion] SKIPPED (No entity matches in graph)");
        }
    } else {
        console.log("  [Path B: Entity Node Lookup] SKIPPED (No keywords)");
    }
  }

  process.exit(0);
}

main();
