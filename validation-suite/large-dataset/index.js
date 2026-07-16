// large-dataset/index.js
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Dataset sizes to test
const MEMORY_SIZES = [10000, 100000, 1000000]; // 10K, 100K, 1M memories
const GRAPH_EDGES_COUNT = 100000; // 100K graph edges

// Categories for memories (based on the codebase)
const MEMORY_CATEGORIES = ['event', 'meeting', 'deadline', 'commitment', 'preference', 'person', 'project', 'other'];
const CATEGORY_WEIGHTS = [0.15, 0.15, 0.1, 0.15, 0.1, 0.1, 0.15, 0.1]; // Weights for random selection

// Sample content templates for each category
const CONTENT_TEMPLATES = {
  event: [
    'Team meeting about project timeline',
    'Doctor appointment at 2 PM',
    'Birthday party for John',
    'Conference call with clients',
    'Dentist checkup'
  ],
  meeting: [
    'Weekly team sync',
    'One-on-one with manager',
    'Project kickoff meeting',
    'Client presentation',
    'Board meeting preparation'
  ],
  deadline: [
    'Project proposal due Friday',
    'Tax filing deadline April 15',
    'Grant application submission',
    'Manuscript review completion',
    'Feature release deadline'
  ],
  commitment: [
    'Promise to help Sarah move',
    'Commitment to attend wedding',
    'Agreement to review code',
    'Volunteer at community event',
    'Mentor new team member'
  ],
  preference: [
    'Preference for working morning shifts',
    'Like working in quiet environments',
    'Prefer email communication over phone',
    'Enjoy collaborative projects',
    'Prefer standing meetings'
  ],
  person: [
    'John Smith - software engineer at TechCorp',
    'Maria Garcia - project manager',
    'David Wilson - UX designer',
    'Lisa Chen - data analyst',
    'Robert Taylor - DevOps specialist'
  ],
  project: [
    'Website redesign initiative',
    'Mobile app development project',
    'Data migration to cloud',
    'Customer feedback system',
    'Internal tools automation'
  ],
  other: [
    'Remember to buy groceries',
    'Call mom on Sunday',
    'Book vacation for summer',
    'Schedule car maintenance',
    'Read new book on leadership'
  ]
};

// Sample user ID for testing (will be used for all test data)
const TEST_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper to get random element from array
function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Helper to get weighted random element from array
function getWeightedRandomElement(items, weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    total += weights[i];
  }

  let random = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    if (random < weights[i]) {
      return items[i];
    }
    random -= weights[i];
  }
  return items[items.length - 1];
}

// Generate realistic memory content
function generateMemoryContent() {
  const category = getWeightedRandomElement(MEMORY_CATEGORIES, CATEGORY_WEIGHTS);
  const templates = CONTENT_TEMPLATES[category] || CONTENT_TEMPLATES[category] || CONTENT_TEMPLATES.other;
  const baseContent = getRandomElement(templates);

  // Add some variation to make content more realistic
  const variations = [
    '',
    ' - needs follow-up',
    ' - important',
    ' - rescheduled',
    ' - completed',
    ' - postponed',
    ` on ${new Date().toLocaleDateString()}`,
    ` at ${Math.floor(Math.random() * 24)}:${Math.floor(Math.random() * 60)}`
  ];

  return baseContent + getRandomElement(variations);
}

// Generate realistic graph edge connections
function generateGraphEdge(existingNodes) {
  if (existingNodes.length < 2) {
    return null;
  }

  // Select two different nodes
  let sourceIdx, targetIdx;
  do {
    sourceIdx = Math.floor(Math.random() * existingNodes.length);
    targetIdx = Math.floor(Math.random() * existingNodes.length);
  } while (sourceIdx === targetIdx);

  const sourceNode = existingNodes[sourceIdx];
  const targetNode = existingNodes[targetIdx];

  // Relationship types based on the codebase
  const relationshipTypes = [
    'works_on',
    'blocked_by',
    'depends_on',
    'owns',
    'assigned_to',
    'collaborates_on',
    'part_of',
    'signed',
    'mentions'
  ];

  const relationshipType = getRandomElement(relationshipTypes);
  const confidence = 0.5 + Math.random() * 0.5; // 0.5 to 1.0

  return {
    source: sourceNode,
    target: targetNode,
    relationship: relationshipType,
    confidence: parseFloat(confidence.toFixed(2))
  };
}

// Insert test memories into database
async function insertMemories(pool, count) {
  console.log(`Inserting ${count} test memories...`);

  const startTime = Date.now();

  // Prepare batch insert
  const values = [];
  const params = [];
  let paramIndex = 1;

  for (let i = 0; i < count; i++) {
    const memoryId = uuidv4();
    const content = generateMemoryContent();
    const category = getWeightedRandomElement(MEMORY_CATEGORIES, CATEGORY_WEIGHTS);

    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, NOW())`);
    params.push(TEST_USER_ID, memoryId, content, category);

    // Execute in batches of 1000 to avoid too many parameters
    if (values.length >= 1000 || i === count - 1) {
      const query = `
        INSERT INTO memory_records (user_id, memory_key, content, category, created_at)
        VALUES ${values.join(',')}`;

      await pool.query(query, params);

      // Reset for next batch
      values.length = 0;
      params.length = 0;
      paramIndex = 1;
    }
  }

  const endTime = Date.now();
  const durationSeconds = (endTime - startTime) / 1000;
  const rate = count / durationSeconds;

  console.log(`  Inserted ${count} memories in ${durationSeconds.toFixed(2)} seconds (${rate.toFixed(0)} records/second)`);
  return { count, durationSeconds, rate };
}

// Insert test graph edges into database
async function insertGraphEdges(pool, count, memoryIds) {
  console.log(`Inserting ${count} test graph edges...`);

  const startTime = Date.now();

  // Prepare batch insert
  const values = [];
  const params = [];
  let paramIndex = 1;

  // First, we need to create graph nodes for our memories
  // In a real implementation, this would happen through the graph construction jobs
  // For this test, we'll simulate by creating nodes directly

  const nodeValues = [];
  const nodeParams = [];
  let nodeParamIndex = 1;

  // Create nodes for a subset of memories (to keep it manageable)
  const sampleSize = Math.min(1000, memoryIds.length); // Use up to 1000 memories for nodes
  const sampledMemoryIds = [];

  for (let i = 0; i < sampleSize; i++) {
    const index = Math.floor(Math.random() * memoryIds.length);
    sampledMemoryIds.push(memoryIds[index]);
  }

  // Create graph nodes
  for (const memoryId of sampledMemoryIds) {
    const nodeKey = `mem_${memoryId.replace(/-/g, '')}`; // Simple node key

    nodeValues.push(`($${nodeParamIndex++}, $${nodeParamIndex++}, $${nodeParamIndex++}, $${nodeParamIndex++})`);
    nodeParams.push(TEST_USER_ID, nodeKey, 'memory', false); // user_id, node_key, node_type, is_stop_entity
  }

  if (nodeValues.length > 0) {
    const nodeQuery = `
      INSERT INTO graph_nodes (user_id, node_key, node_type, is_stop_entity)
      VALUES ${nodeValues.join(',')}
      RETURNING id, node_key`;

    const nodeResult = await pool.query(nodeQuery, nodeParams);

    // Create node-members relationships
    const memberValues = nodeResult.rows.map((row, index) =>
      `($${row.id}, $${sampledMemoryIds[index]})`
    ).join(',');

    const memberParams = [];
    let memberParamIndex = 1;
    for (let i = 0; i < nodeResult.rows.length; i++) {
      memberPaths.push(nodeResult.rows[i].id); // node_id
      memberParams.push(sampledMemoryIds[i]); // memory_id
    }

    if (memberValues.length > 0) {
      const memberQuery = `
        INSERT INTO graph_node_members (node_id, memory_id)
        VALUES ${memberValues}`;

      await pool.query(memberQuery, memberParams);
    }
  }

  // Now create edges between nodes
  for (let i = 0; i < count; i++) {
    // Get some existing node IDs to create edges between
    const nodeIdsResult = await pool.query(
      'SELECT id FROM graph_nodes WHERE user_id = $1 LIMIT 100',
      [TEST_USER_ID]
    );
    const nodeIds = nodeIdsResult.rows.map(row => row.id);

    if (nodeIds.length < 2) {
      continue; // Skip if we don't have enough nodes
    }

    // Select two different nodes
    let sourceIdx, targetIdx;
    do {
      sourceIdx = Math.floor(Math.random() * nodeIds.length);
      targetIdx = Math.floor(Math.random() * nodeIds.length);
    } while (sourceIdx === targetIdx);

    const sourceNodeId = nodeIds[sourceIdx];
    const targetNodeId = nodeIds[targetIdx];

    // Relationship types based on the codebase
    const relationshipTypes = [
      'works_on',
      'blocked_by',
      'depends_on',
      'owns',
      'assigned_to',
      'collaborates_on',
      'part_of',
      'signed',
      'mentions'
    ];

    const relationshipType = getRandomElement(relationshipTypes);
    const confidence = 0.5 + Math.random() * 0.5; // 0.5 to 1.0

    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
    params.push(
      TEST_USER_ID, // user_id
      sourceNodeId, // source_node_id
      targetNodeId, // target_node_id
      relationshipType, // relationship_type
      parseFloat(confidence.toFixed(2)), // confidence
      new Date().toISOString() // last_evidence_at
    );

    // Execute in batches of 1000
    if (values.length >= 1000 || i === count - 1) {
      const query = `
        INSERT INTO graph_edges (user_id, source_node_id, target_node_id, relationship_type, confidence, last_evidence_at)
        VALUES ${values.join(',')}`;

      await pool.query(query, params);

      // Reset for next batch
      values.length = 0;
      params.length = 0;
      paramIndex = 1;
    }
  }

  const endTime = Date.now();
  const durationSeconds = (endTime - startTime) / 1000;
  const rate = count / durationSeconds;

  console.log(`  Inserted ${count} graph edges in ${durationSeconds.toFixed(2)} seconds (${rate.toFixed(0)} edges/second)`);
  return { count, durationSeconds, rate };
}

// Measure memory retrieval latency
async function measureRetrievalLatency(pool, query = 'test memory query') {
  console.log('Measuring retrieval latency...');

  const startTime = Date.now();

  try {
    // This is a simplified query - in reality, we'd call the actual RPC
    // but for testing direct DB access, we'll use a simple text search
    const result = await pool.query(
      `SELECT COUNT(*) FROM memory_records
       WHERE user_id = $1 AND content ILIKE $2`,
      [TEST_USER_ID, `%${query}%`]
    );

    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    console.log(`  Query latency: ${latencyMs}ms`);
    return latencyMs;
  } catch (err) {
    console.warn(`  Could not measure retrieval latency: ${err.message}`);
    return -1;
  }
}

// Measure graph traversal latency (simplified)
async function measureGraphTraversalLatency(pool) {
  console.log('Measuring graph traversal latency...');

  const startTime = Date.now();

  try {
    // Simple graph traversal query
    const result = await pool.query(`
      SELECT COUNT(*)
      FROM graph_edges e
      JOIN graph_nodes n1 ON e.source_node_id = n1.id
      JOIN graph_nodes n2 ON e.target_node_id = n2.id
      WHERE n1.user_id = $1 AND n2.user_id = $1
    `, [TEST_USER_ID]);

    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    console.log(`  Graph traversal latency: ${latencyMs}ms`);
    return latencyMs;
  } catch (err) {
    console.warn(`  Could not measure graph traversal latency: ${err.message}`);
    return -1;
  }
}

// Measure memory usage (approximate)
async function measureMemoryUsage(pool) {
  try {
    // Get approximate size of memory_records table
    const result = await pool.query(`
      SELECT pg_total_relation_size('memory_records') as size_bytes
    `);

    const sizeBytes = parseInt(result.rows[0].size_bytes);
    const sizeMb = sizeBytes / (1024 * 1024);

    console.log(`  Memory records table size: ${sizeMb.toFixed(2)} MB`);
    return sizeBytes;
  } catch (err) {
    console.warn(`  Could not measure memory usage: ${err.message}`);
    return -1;
  }
}

// Measure index status (by checking index existence and approximate creation time)
async function measureIndexStatus(pool) {
  try {
    // Check if indexes exist and get their sizes
    const result = await pool.query(`
      SELECT
        indexname,
        pg_size_pretty(pg_relation_size(indexrelid)) as size
      FROM pg_indexes
      WHERE tablename = 'memory_records'
    `);

    const indexes = result.rows;
    console.log(`  Indexes on memory_records:`);
    indexes.forEach(idx => {
      console.log(`    ${idx.indexname}: ${idx.size}`);
    });

    return indexes;
  } catch (err) {
    console.warn(`  Could not check index status: ${err.message}`);
    return [];
  }
}

// Main function to run large dataset validation
async function runLargeDatasetValidation() {
  console.log('Starting large dataset validation for Cyrus V2...');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: Please set DATABASE_URL environment variable');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Check if we can connect
    await pool.query('SELECT 1');
    console.log('Connected to database successfully\n');

    const allResults = {};

    // Test each memory size
    for (const size of MEMORY_SIZES) {
      console.log(`\n--- Testing with ${size.toLocaleString()} memories ---`);

      // Insert memories
      const memoryResult = await insertMemories(pool, size);

      // Get some memory IDs for graph edges
      const idsResult = await pool.query(
        'SELECT id FROM memory_records WHERE user_id = $1 LIMIT 1000',
        [TEST_USER_ID]
      );
      const memoryIds = idsResult.rows.map(row => row.id);

      // Measure memory usage after inserting memories
      const memoryUsageAfterMemories = await measureMemoryUsage(pool);

      // Measure index status
      const indexStatus = await measureIndexStatus(pool);

      // Measure retrieval latency
      const retrievalLatency = await measureRetrievalLatency(pool);

      // Measure graph traversal latency (before adding edges)
      const graphTraversalBefore = await measureGraphTraversalLatency(pool);

      // Insert graph edges
      const edgesResult = await insertGraphEdges(pool, GRAPH_EDGES_COUNT, memoryIds);

      // Measure memory usage after inserting edges
      const memoryUsageAfterEdges = await measureMemoryUsage(pool);

      // Measure graph traversal latency after adding edges
      const graphTraversalAfter = await measureGraphTraversalLatency(pool);

      // Measure final index status
      const finalIndexStatus = await measureIndexStatus(pool);

      // Store results for this size
      allResults[size] = {
        memoryInsert: memoryResult,
        memoryUsageAfterMemories: memoryUsageAfterMemories,
        memoryUsageAfterEdges: memoryUsageAfterEdges,
        memoryUsageGrowthBytes: memoryUsageAfterEdges - memoryUsageAfterMemories,
        retrievalLatencyMs: retrievalLatency,
        graphTraversalBeforeMs: graphTraversalBefore,
        graphTraversalAfterMs: graphTraversalAfter,
        graphTraversalImprovementMs: graphTraversalBefore - graphTraversalAfter,
        edgesInsert: edgesResult,
        indexStatusBefore: indexStatus,
        indexAfter: finalIndexStatus
      };

      console.log(`\n--- Results for ${size.toLocaleString()} memories ---`);
      console.log(`Memory Insertion Rate: ${memoryResult.rate.toFixed(0)} records/second`);
      console.log(`Memory Usage After: ${(memoryUsageAfterMemories / (1024*1024)).toFixed(2)} MB`);
      console.log(`Memory Growth from Edges: ${((memoryUsageAfterEdges - memoryUsageAfterMemories) / (1024*1024)).toFixed(2)} MB`);
      console.log(`Retrieval Latency: ${retrievalLatency}ms`);
      console.log(`Graph Traversal (Before Edges): ${graphTraversalBefore}ms`);
      console.log(`Graph Traversal (After Edges): ${graphTraversalAfter}ms`);
      console.log(`Graph Traversal Change: ${(graphTraversalAfter - graphTraversalBefore)}ms`);
      console.log(`Edge Insertion Rate: ${edgesResult.rate.toFixed(0)} edges/second`);
    }

    // Summary
    console.log('\n=== Large Dataset Validation Summary ===');
    for (const size of MEMORY_SIZES) {
      const result = allResults[size];
      console.log(`\n${size.toLocaleString()} memories:`);
      console.log(`  Insertion Rate: ${result.memoryInsert.rate.toFixed(0)} records/second`);
      console.log(`  Memory Usage: ${(result.memoryUsageAfterMemories / (1024*1024)).toFixed(2)} MB`);
      console.log(`  Memory Growth from Edges: ${(result.memoryUsageGrowthBytes / (1024*1024)).toFixed(2)} MB`);
      console.log(`  Retrieval Latency: ${result.retrievalLatencyMs}ms`);
      console.log(`  Graph Traversal (Before/After): ${result.graphTraversalBeforeMs}ms / ${result.graphTraversalAfterMs}ms`);
      console.log(`  Edge Insertion Rate: ${result.edgesInsert.rate.toFixed(0)} edges/second`);
    }

    // Save results to file
    const resultsDir = path.join(__dirname, '..', 'results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(resultsDir, `large-dataset-${timestamp}.json`);

    const report = {
      testSuite: 'Large Dataset Validation',
      timestamp: new Date().toISOString(),
      testUserId: TEST_USER_ID,
      memorySizesTested: MEMORY_SIZES,
      graphEdgesCount: GRAPH_EDGES_COUNT,
      results: allResults
    };

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nDetailed results saved to: ${jsonPath}`);

    return true;
  } catch (err) {
    console.error('Large dataset validation failed with error:', err);
    return false;
  } finally {
    await pool.end();
  }
}

// Run the validation if this script is executed directly
if (require.main === module) {
  runLargeDatasetValidation()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(err => {
      console.error('Large dataset validation failed with error:', err);
      process.exit(1);
    });
}

module.exports = { runLargeDatasetValidation };