// database/index.js
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// List of RPCs to test (from the codebase)
const RPCS = [
  {
    name: 'hybrid_search_memories',
    sql: 'SELECT * FROM hyperspace.memories_match($1, $2, $3, $4)',
    params: [
      '00000000-0000-0000-0000-000000000000', // user_id (uuid)
      'test query', // query_text (text)
      '[]', // query_embedding (vector) - empty array as placeholder
      10 // match_count (integer)
    ]
  },
  {
    name: 'hybrid_search_emails',
    sql: 'SELECT * FROM hyperspace.emails_match($1, $2, $3, $4)',
    params: [
      '00000000-0000-0000-0000-000000000000', // user_id (uuid)
      'test query', // query_text (text)
      '[]', // query_embedding (vector) - empty array as placeholder
      10 // match_count (integer)
    ]
  },
  {
    name: 'hybrid_search_events',
    sql: 'SELECT * FROM hyperspace.events_match($1, $2, $3, $4)',
    params: [
      '00000000-0000-0000-0000-000000000000', // user_id (uuid)
      'test query', // query_text (text)
      '[]', // query_embedding (vector) - empty array as placeholder
      10 // match_count (integer)
    ]
  },
  {
    name: 'resolve_nodes_for_memories',
    sql: 'SELECT * FROM graph.resolve_nodes_for_memories($1, $2)',
    params: [
      '00000000-0000-0000-0000-000000000000', // p_user_id (uuid)
      '["00000000-0000-0000-0000-000000000001","00000000-0000-0000-0000-000000000002"]' // p_memory_ids (text) - comma-separated UUIDs
    ]
  },
  {
    name: 'graph_render_relations',
    sql: 'SELECT * FROM graph.render_relations($1, $2, $3, $4, $5, $6)',
    params: [
      '00000000-0000-0000-0000-000000000000', // p_user_id (uuid)
      '00000000-0000-0000-0000-000000000001', // p_start_node_ids (uuid) - single UUID for simplicity
      2, // p_max_hops (integer)
      5, // p_limit (integer)
      'general', // p_graph_intent (text)
      false // p_include_weights (boolean)
    ]
  },
  {
    name: 'match_memory_candidates',
    sql: 'SELECT * FROM hyperspace.match_memory_candidates($1, $2, $3, $4)',
    params: [
      '00000000-0000-0000-0000-000000000000', // p_user_id (uuid)
      'memory', // p_category (text)
      '[]', // query_embedding (vector) - empty array as placeholder
      5 // match_count (integer)
    ]
  },
  {
    name: 'record_memory_retrievals',
    sql: 'SELECT * FROM memory.record_memory_retrievals($1, $2)',
    params: [
      '00000000-0000-0000-0000-000000000000', // p_user_id (uuid)
      '00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002' // ids (text) - comma-separated UUIDs
    ]
  },
  {
    name: 'increment_usage',
    sql: 'SELECT * FROM usage.increment_usage($1, $2, $3)',
    params: [
      '00000000-0000-0000-0000-000000000000', // user_id (uuid)
      'ai_queries', // metric (text)
      'free' // plan (text)
    ]
  }
];

// Thresholds
const EXECUTION_TIME_THRESHOLD_MS = 100; // Fail if execution time exceeds this

async function runExplainAnalyze() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: Please set DATABASE_URL environment variable');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    console.log('Starting database validation for Cyrus V2 RPCs...');
    console.log(`Testing ${RPCS.length} RPCs with execution time threshold: ${EXECUTION_TIME_THRESHOLD_MS}ms\n`);

    const results = [];
    let failedCount = 0;

    for (const rpc of RPCS) {
      console.log(`Testing ${rpc.name}...`);

      try {
        // Execute EXPLAIN ANALYZE
        const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${rpc.sql}`;
        const res = await pool.query(explainSql, rpc.params);

        // Parse the EXPLAIN output
        const explainResult = res.rows[0][0];
        const plan = explainResult[0].Plan;

        // Extract metrics
        const executionTimeMs = plan['Actual Total Time']; // in milliseconds
        const planningTimeMs = explainResult[0]['Planning Time'] || 0; // Planning time is in the outer JSON

        // Check for sequential scans
        let hasSequentialScan = false;
        let hasHashJoin = false;
        let hasIndexScan = false;
        let hasIndexOnlyScan = false;
        let hasBitmapIndexScan = false;

        function checkNode(node) {
          if (node['Node Type'] === 'Seq Scan') {
            hasSequentialScan = true;
          } else if (node['Node Type'] === 'Index Scan' || node['Node Type'] === 'Index Only Scan') {
            hasIndexScan = true;
            if (node['Node Type'] === 'Index Only Scan') {
              hasIndexOnlyScan = true;
            }
          } else if (node['Node Type'] === 'Bitmap Index Scan') {
            hasBitmapIndexScan = true;
          } else if (node['Node Type'] === 'Hash Join') {
            hasHashJoin = true;
          }

          if (node.Plans) {
            for (const subNode of node.Plans) {
              checkNode(subNode);
            }
          }
        }

        checkNode(plan);

        // Determine if HNSW or GIN indexes are used
        // This is approximate - we're looking for index scans that might be using these indexes
        const usesHns = hasIndexScan || hasIndexOnlyScan || hasBitmapIndexScan; // Simplified check
        const usesGin = hasIndexScan || hasIndexOnlyScan || hasBitmapIndexScan; // Simplified check

        // Determine if test passes
        const passes = executionTimeMs <= EXECUTION_TIME_THRESHOLD_MS;
        if (!passes) {
          failedCount++;
        }

        // Store result
        results.push({
          rpcName: rpc.name,
          executionTimeMs: parseFloat(executionTimeMs.toFixed(2)),
          planningTimeMs: parseFloat(planningTimeMs.toFixed(2)),
          totalTimeMs: parseFloat((executionTimeMs + planningTimeMs).toFixed(2)),
          passesThreshold: passes,
          hasSequentialScan: hasSequentialScan,
          hasIndexScan: hasIndexScan,
          hasIndexOnlyScan: hasIndexOnlyScan,
          hasBitmapIndexScan: hasBitmapIndexScan,
          hasHashJoin: hasHashJoin,
          usesHnsIndex: usesHns, // Approximation
          usesGinIndex: usesGin, // Approximation
          explanation: explainResult
        });

        // Log result
        console.log(`  Execution Time: ${executionTimeMs.toFixed(2)}ms ${passes ? '✓ PASS' : '✗ FAIL'}`);
        console.log(`  Planning Time: ${planningTimeMs.toFixed(2)}ms`);
        console.log(`  Sequential Scan: ${hasSequentialScan ? 'YES' : 'NO'}`);
        console.log(`  Index Scan: ${hasIndexScan ? 'YES' : 'NO'}`);
        console.log(`  Uses HNSW Index (approx): ${usesHns ? 'YES' : 'NO'}`);
        console.log(`  Uses GIN Index (approx): ${usesGin ? 'YES' : 'NO'}`);
        console.log('');
      } catch (err) {
        console.error(`  ERROR testing ${rpc.name}: ${err.message}`);
        failedCount++;

        results.push({
          rpcName: rpc.name,
          error: err.message,
          passesThreshold: false
        });
      }
    }

    // Summary
    console.log('=== Database Validation Summary ===');
    console.log(`Total RPCs tested: ${RPCS.length}`);
    console.log(`Passed: ${RPCS.length - failedCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Pass Rate: ${((RPCS.length - failedCount) / RPCS.length * 100).toFixed(2)}%`);

    // Save results to files
    const resultsDir = path.join(__dirname, '..', 'results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(resultsDir, `database-validation-${timestamp}.json`);
    const mdPath = path.join(resultsDir, `database-validation-${timestamp}.md`);

    // Create detailed JSON report
    const jsonReport = {
      testSuite: 'Database Validation',
      timestamp: new Date().toISOString(),
      thresholdMs: EXECUTION_TIME_THRESHOLD_MS,
      totalRpcs: RPCS.length,
      passed: RPCS.length - failedCount,
      failed: failedCount,
      passRate: ((RPCS.length - failedCount) / RPCS.length) * 100,
      results: results
    };

    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));

    // Create Markdow report
    let mdContent = `# Database Validation Report\n\n`;
    mdContent += `**Timestamp:** ${new Date().toISOString()}\n\n`;
    mdContent += `**Execution Time Threshold:** ${EXECUTION_TIME_THRESHOLD_MS}ms\n\n`;
    mdContent += `**Summary:**\n`;
    mdContent += `- Total RPCs Tested: ${RPCS.length}\n`;
    mdContent += `- Passed: ${RPCS.length - failedCount}\n`;
    mdContent += `- Failed: ${failedCount}\n`;
    mdContent += `- Pass Rate: ${((RPCS.length - failedCount) / RPCS.length * 100).toFixed(2)}%\n\n`;
    mdContent += '## Detailed Results\n\n';
    mdContent += '| RPC Name | Execution Time (ms) | Planning Time (ms) | Total Time (ms) | Passes Threshold | Sequential Scan | Index Scan | Uses HNSW (approx) | Uses GIN (approx) |\n';
    mdContent += '|----------|-------------------|-------------------|----------------|------------------|-----------------|------------|-------------------|------------------|\n';

    for (const result of results) {
      if (result.error) {
        mdContent += `| ${result.rpcName} | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |\n`;
        mdContent += `| | *Error: ${result.error}* | | | | | | | |\n`;
      } else {
        mdContent += `| ${result.rpcName} | ${result.executionTimeMs} | ${result.planningTimeMs} | ${result.totalTimeMs} | ${result.passesThreshold ? 'YES' : 'NO'} | ${result.hasSequentialScan ? 'YES' : 'NO'} | ${result.hasIndexScan ? 'YES' : 'NO'} | ${result.usesHnsIndex ? 'YES' : 'NO'} | ${result.usesGinIndex ? 'YES' : 'NO'} |\n`;
      }
    }

    fs.writeFileSync(mdPath, mdContent);

    console.log(`\nReports saved to:`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Markdown: ${mdPath}`);

    // Determine overall result
    const overallPassed = failedCount === 0;
    console.log(`\nOverall Result: ${overallPassed ? 'PASS' : 'FAIL'}`);

    if (!overallPassed) {
      console.log(`\nFailed RPCs:`);
      for (const result of results) {
        if (!result.passesThreshold) {
          console.log(`  - ${result.rpcName}: ${result.executionTimeMs}ms (threshold: ${EXECUTION_TIME_THRESHOLD_MS}ms)`);
        }
      }
    }

    return overallPassed;
  } catch (err) {
    console.error('Database validation failed with error:', err);
    return false;
  } finally {
    await pool.end();
  }
}

// Run the validation if this script is executed directly
if (require.main === module) {
  runExplainAnalyze()
    .then(passed => {
      process.exit(passed ? 0 : 1);
    })
    .catch(err => {
      console.error('Database validation failed with error:', err);
      process.exit(1);
    });
}

module.exports = { runExplainAnalyze };