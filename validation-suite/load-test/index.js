// load-test/index.js
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration from environment
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

// Endpoints to test
const ENDPOINTS = [
  { path: '/functions/v1/retrieve-context', method: 'POST', body: { query: 'test query' }, useUserAuth: true, weight: 0.4 },
  { path: '/functions/v1/gmail-sync', method: 'POST', body: {}, useSystemAuth: true, weight: 0.2 },
  { path: '/functions/v1/calendar-sync', method: 'POST', body: {}, useSystemAuth: true, weight: 0.2 },
  { path: '/functions/v1/llm-worker', method: 'POST', body: {}, useSystemAuth: true, weight: 0.1 },
  { path: '/functions/v1/generate-briefing', method: 'POST', body: {}, useSystemAuth: true, weight: 0.1 }
];

// Sample queries for randomization
const SAMPLE_QUERIES = [
  'What did John say about the project?',
  'When is the next team meeting?',
  'Show me emails from Sarah last week',
  'What are my deadlines for this month?',
  'Summarize the action items from the meeting',
  'Find documents related to the budget',
  'What did we decide in the sprint planning?',
  'Show me the calendar for next week',
  'Search for information about the client presentation',
  'What are the key points from the quarterly report?'
];

// Helper to get random element from array
function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Multiple JWT users (if provided)
const USER_JWTS = process.env.USER_JWTS
  ? process.env.USER_JWTS.split(',').map(jwt => jwt.trim())
  : (process.env.USER_JWT ? [process.env.USER_JWT] : []);

// Multiple worker secrets (if provided)
const WORKER_SECRETS = process.env.WORKER_SECRETS
  ? process.env.WORKER_SECRETS.split(',').map(secret => secret.trim())
  : (process.env.WORKER_SECRET ? [process.env.WORKER_SECRET] : []);

// Test configuration
const DEFAULT_DURATION_SECONDS = parseInt(process.env.LOAD_TEST_DURATION) || 30;
const SAMPLE_INTERVAL_MS = parseInt(process.env.LOAD_SAMPLE_INTERVAL) || 1000;

// Traffic patterns
const TRAFFIC_PATTERNS = {
  CONSTANT: 'constant',
  RAMP_UP: 'ramp_up',
  RAMP_DOWN: 'ramp_down',
  BURST: 'burst'
};

// Default test configuration
const DEFAULT_CONFIG = {
  pattern: TRAFFIC_PATTERNS.CONSTANT,
  concurrency: 10,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  rampUpTime: 0, // seconds
  rampDownTime: 0, // seconds
  burstInterval: 0, // seconds
  burstIntensity: 1 // multiplier
};

// Results storage
let results = [];
let detailedMetrics = [];

// Helper function to make HTTP requests
async function makeRequest(options, payload = null) {
  return new Promise((resolve, reject) => {
    const req = (options.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

// Test endpoint function with enhanced capabilities
async function testEndpoint(config, userIndex = 0) {
  const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];

  // Select JWT if available
  const userJwt = USER_JWTS.length > 0
    ? USER_JWTS[userIndex % USER_JWTS.length]
    : process.env.USER_JWT;

  // Select worker secret if available
  const workerSecret = WORKER_SECRETS.length > 0
    ? WORKER_SECRETS[0] // Use first one for system auth
    : process.env.WORKER_SECRET;

  const url = new URL(BASE_URL + endpoint.path);
  const options = {
    method: endpoint.method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  // Add authentication
  if (endpoint.useSystemAuth && workerSecret) {
    options.headers['x-worker-secret'] = workerSecret;
  } else if (endpoint.useUserAuth && userJwt) {
    options.headers['Authorization'] = `Bearer ${userJwt}`;
  }

  // Prepare payload with potential randomization
  let payload = { ...endpoint.body };
  if (endpoint.path.includes('retrieve-context') && typeof payload.query === 'string') {
    // Randomize query for retrieve-context endpoint
    payload.query = getRandomElement(SAMPLE_QUERIES);
  }

  const start = performance.now();
  try {
    const response = await makeRequest(options, payload);
    const end = performance.now();

    const result = {
      success: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      latency: end - start,
      endpoint: endpoint.path,
      timestamp: new Date().toISOString(),
      error: null
    };

    // Store detailed metrics for percentile calculation
    detailedMetrics.push({
      timestamp: Date.now(),
      latency: result.latency,
      success: result.success,
      endpoint: endpoint.path
    });

    return result;
  } catch (err) {
    const end = performance.now();

    const result = {
      success: false,
      statusCode: 0,
      latency: end - start,
      endpoint: endpoint.path,
      timestamp: new Date().toISOString(),
      error: err.message
    };

    // Store detailed metrics even for failures
    detailedMetrics.push({
      timestamp: Date.now(),
      latency: result.latency,
      success: false,
      endpoint: endpoint.path,
      error: err.message
    });

    return result;
  }
}

// Calculate percentiles from latency data
function calculatePercentiles(latencies, percentiles) {
  if (latencies.length === 0) {
    return Object.fromEntries(percentiles.map(p => [`p${p}`, 0]));
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const result = {};

  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    const clampedIndex = Math.max(0, Math.min(index, sorted.length - 1));
    result[`p${p}`] = sorted[clampedIndex];
  }

  return result;
}

// Generate traffic load based on pattern
function getCurrentConcurrency(elapsedTime, config) {
  let concurrency = config.concurrency;

  switch (config.pattern) {
    case TRAFFIC_PATTERNS.RAMP_UP:
      if (elapsedTime < config.rampUpTime) {
        concurrency = Math.floor((elapsedTime / config.rampUpTime) * config.concurrency);
      }
      break;

    case TRAFFIC_PATTERNS.RAMP_DOWN:
      if (elapsedTime > (config.durationSeconds - config.rampDownTime)) {
        const timeInDropPhase = elapsedTime - (config.durationSeconds - config.rampDownTime);
        const progress = timeInDropPhase / config.rampDownTime;
        concurrency = Math.floor(config.concurrency * (1 - progress));
      }
      break;

    case TRAFFIC_PATTERNS.BURST:
      if (config.burstInterval > 0) {
        const cyclePosition = elapsedTime % config.burstInterval;
        if (cyclePosition < (config.burstInterval * 0.1)) { // 10% of cycle is burst
          concurrency = Math.floor(config.concurrency * config.burstIntensity);
        }
      }
      break;

    case TRAFFIC_PATTERNS.CONSTANT:
    default:
      // Constant load
      break;
  }

  return Math.max(1, concurrency); // Ensure at least 1 user
}

// Run a single load test with specified configuration
async function runLoadTestConfig(config) {
  console.log(`\n--- Starting Load Test ---`);
  console.log(`Pattern: ${config.pattern}`);
  console.log(`Base Concurrency: ${config.concurrency}`);
  console.log(`Duration: ${config.durationSeconds} seconds`);
  if (config.pattern === TRAFFIC_PATTERNS.RAMP_UP) {
    console.log(`Ramp Up Time: ${config.rampUpTime} seconds`);
  }
  if (config.pattern === TRAFFIC_PATTERNS.RAMP_DOWN) {
    console.log(`Ramp Down Time: ${config.rampDownTime} seconds`);
  }
  if (config.pattern === TRAFFIC_PATTERNS.BURST) {
    console.log(`Burst Interval: ${config.burstInterval} seconds`);
    console.log(`Burst Intensity: ${config.burstIntensity}x`);
  }
  console.log(`JWT Users Available: ${USER_JWTS.length}`);
  console.log(`Worker Secrets Available: ${WORKER_SECRETS.length}`);
  console.log('-----------------------------\n');

  const startTime = Date.now();
  const endTime = startTime + (config.durationSeconds * 1000);

  let requestCount = 0;
  let errorCount = 0;
  const latencies = [];
  const endpointCounts = {};
  const statusCodes = {};

  // Initialize counters
  ENDPOINTS.forEach(ep => {
    endpointCounts[ep.path] = 0;
  });

  // Track active virtual users
  const activeUsers = new Set();
  let userCounter = 0;

  // Function to be run by each virtual user
  async function user(userId) {
    const userKey = `user_${userId}`;
    activeUsers.add(userKey);

    try {
      while (Date.now() < endTime) {
        const result = await testEndpoint({ ...config }, userId);

        // Update metrics
        requestCount++;
        if (!result.success) {
          errorCount++;
        }
        latencies.push(result.latency);

        // Track endpoint usage
        endpointCounts[result.endpoint] = (endpointCounts[result.endpoint] || 0) + 1;

        // Track status codes
        statusCodes[result.statusCode] = (statusCodes[result.statusCode] || 0) + 1;

        // Think time: wait between requests
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms think time
      }
    } finally {
      activeUsers.delete(userKey);
    }
  }

  // Start timing for reports
  let lastReportTime = startTime;

  // Main load generation loop
  while (Date.now() < endTime) {
    const now = Date.now();
    const elapsedTime = (now - startTime) / 1000; // in seconds

    // Calculate current target concurrency based on pattern
    const targetConcurrency = getCurrentConcurrency(elapsedTime, config);

    // Adjust number of active users
    const currentUsers = activeUsers.size;

    if (currentUsers < targetConcurrency) {
      // Need to start more users
      const needed = targetConcurrency - currentUsers;
      for (let i = 0; i < needed; i++) {
        userCounter++;
        const userId = userCounter;
        // Fire and forget - we don't await these as they run independently
        user(userId).catch(err => {
          // Handle unexpected errors
          console.error(`User ${userId} encountered error:`, err.message);
        });
      }
    } else if (currentUsers > targetConcurrency) {
      // Need to stop some users (we'll let them finish naturally)
      // In a more sophisticated implementation, we'd signal them to stop
      // For now, we'll just let excess users complete their current iteration
    }

    // Report progress every 5 seconds
    if (now - lastReportTime >= 5000) {
      const elapsedSec = (now - startTime) / 1000;
      const currentRps = requestCount / (elapsedSec / 1000);

      process.stdout.write(`\rElapsed: ${Math.floor(elapsedSec)}s | ` +
        `Users: ${activeUsers.size}/${targetConcurrency} | ` +
        `Req: ${requestCount} | ` +
        `Err: ${errorCount} | ` +
        `RPS: ${currentRps.toFixed(2)}`);

      lastReportTime = now;
    }

    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  // Wait for all active users to finish
  console.log('\nWaiting for active users to complete...');
  // In a real implementation, we'd have a better way to track completion
  // For now, we'll just wait a bit
  await new Promise(resolve => setTimeout(resolve, 2000));

  const totalTime = Date.now() - startTime;

  // Calculate final metrics
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const percentiles = calculatePercentiles(latencies, [50, 95, 99]);
  const throughput = requestCount / (totalTime / 1000); // requests per second
  const errorRate = requestCount > 0 ? errorCount / requestCount : 0;

  // Build result object
  const result = {
    config: {
      ...config,
      patternName: config.pattern
    },
    summary: {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(Date.now()).toISOString(),
      durationSeconds: Math.floor(totalTime / 1000),
      totalRequests: requestCount,
      totalErrors: errorCount,
      errorRate: parseFloat((errorRate * 100).toFixed(2)),
      requestsPerSecond: parseFloat(throughput.toFixed(2)),
      averageLatencyMs: parseFloat(avgLatency.toFixed(2)),
      ...percentiles,
      p50LatencyMs: parseFloat(percentiles.p50.toFixed(2)),
      p95LatencyMs: parseFloat(percentiles.p95.toFixed(2)),
      p99LatencyMs: parseFloat(percentiles.p99.toFixed(2))
    },
    endpoints: endpointCounts,
    statusCodes: statusCodes,
    concurrentUsers: {
      target: config.concurrency,
      maxObserved: Array.from(activeUsers).length // Approximation
    }
  };

  results.push(result);

  // Print summary
  console.log('\n=== Load Test Results ===');
  console.log(`Duration: ${result.summary.durationSeconds} seconds`);
  console.log(`Total Requests: ${result.summary.totalRequests}`);
  console.log(`Total Errors: ${result.summary.totalErrors} (${result.summary.errorRate}%)`);
  console.log(`Requests/Second: ${result.summary.requestsPerSecond}`);
  console.log(`Average Latency: ${result.summary.averageLatencyMs} ms`);
  console.log(`50th Percentile: ${result.summary.p50LatencyMs} ms`);
  console.log(`95th Percentile: ${result.summary.p95LatencyMs} ms`);
  console.log(`99th Percentile: ${result.summary.p99LatencyMs} ms`);

  console.log('\nEndpoint Distribution:');
  for (const [endpoint, count] of Object.entries(result.endpoints)) {
    const percentage = ((count / result.summary.totalRequests) * 100).toFixed(1);
    console.log(`  ${endpoint}: ${count} (${percentage}%)`);
  }

  console.log('\nStatus Code Distribution:');
  for (const [code, count] of Object.entries(result.statusCodes)) {
    const percentage = ((count / result.summary.totalRequests) * 100).toFixed(1);
    console.log(`  ${code}: ${count} (${percentage}%)`);
  }

  // Save detailed metrics for analysis
  const resultsDir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Save summary as JSON
  const jsonPath = path.join(resultsDir, `load-test-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // Save detailed metrics as CSV
  const csvPath = path.join(resultsDir, `load-test-${timestamp}-details.csv`);
  let csvContent = 'Timestamp,LatencyMs,Success,Endpoint,Error\n';
  detailedMetrics.forEach(m => {
    csvContent += `${m.timestamp},${m.latency},${m.success},${m.endpoint},"${m.error || ''}"\n`;
  });
  fs.writeFileSync(csvPath, csvContent);

  console.log(`\nResults saved to:`);
  console.log(`  Summary: ${jsonPath}`);
  console.log(`  Details: ${csvPath}`);

  return result;
}

// Run multiple load test configurations
async function runLoadTests() {
  console.log('Starting comprehensive load tests for Cyrus V2...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Available JWT Users: ${USER_JWTS.length}`);
  console.log(`Available Worker Secrets: ${WORKER_SECRETS.length}`);

  // Test configurations
  const testConfigs = [
    // Constant load tests
    {
      pattern: TRAFFIC_PATTERNS.CONSTANT,
      concurrency: 1,
      durationSeconds: 10
    },
    {
      pattern: TRAFFIC_PATTERNS.CONSTANT,
      concurrency: 10,
      durationSeconds: 20
    },
    {
      pattern: TRAFFIC_PATTERNS.CONSTANT,
      concurrency: 50,
      durationSeconds: 30
    },
    // Ramp up test
    {
      pattern: TRAFFIC_PATTERNS.RAMP_UP,
      concurrency: 50,
      durationSeconds: 60,
      rampUpTime: 30
    },
    // Ramp down test
    {
      pattern: TRAFFIC_PATTERNS.RAMP_DOWN,
      concurrency: 50,
      durationSeconds: 60,
      rampDownTime: 30
    },
    // Burst test
    {
      pattern: TRAFFIC_PATTERNS.BURST,
      concurrency: 20,
      durationSeconds: 60,
      burstInterval: 20,
      burstIntensity: 3
    }
  ];

  // Run each test configuration
  for (const config of testConfigs) {
    await runLoadTestConfig(config);

    // Cool down between tests
    if (config !== testConfigs[testConfigs.length - 1]) {
      console.log('\nCooling down for 10 seconds before next test...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  // Generate combined report
  const resultsDir = path.join(__dirname, '..', 'results');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const combinedPath = path.join(resultsDir, `load-test-combined-${timestamp}.json`);

  const combinedReport = {
    testSuite: 'Enhanced Load Testing',
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    testConfigurations: testConfigs,
    results: results
  };

  fs.writeFileSync(combinedPath, JSON.stringify(combinedReport, null, 2));
  console.log(`\nCombined report saved to: ${combinedPath}`);

  return results;
}

// Run the tests if this script is executed directly
if (require.main === module) {
  runLoadTests()
    .then(results => {
      process.exit(0);
    })
    .catch(err => {
      console.error('Load tests failed with error:', err);
      process.exit(1);
    });
}

module.exports = { runLoadTests };