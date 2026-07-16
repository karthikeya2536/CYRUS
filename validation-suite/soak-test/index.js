// soak-test/index.js
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { performance } = require('perf_hooks');
const os = require('os');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration from environment
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const RETRIEVE_CONTEXT_PATH = '/functions/v1/retrieve-context';
const GMAIL_SYNC_PATH = '/functions/v1/gmail-sync';
const CALENDAR_SYNC_PATH = '/functions/v1/calendar-sync';
const LLM_WORKER_PATH = '/functions/v1/llm-worker';
const WORKER_SECRET = process.env.WORKER_SECRET;
const USER_JWT = process.env.USER_JWT;

// Test configuration
const DEFAULT_DURATION_HOURS = parseInt(process.env.SOAK_DURATION_HOURS) || 1; // Default 1 hour
const DEFAULT_CONCURRENCY = parseInt(process.env.SOAK_CONCURRENCY) || 10; // Default 10 users
const SAMPLE_INTERVAL_MS = 60000; // Sample metrics every minute

// Metrics collection
let metrics = [];
let startTime;
let isRunning = false;

// System metrics collection
function collectSystemMetrics() {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();

  return {
    timestamp: new Date().toISOString(),
    elapsedSeconds: Math.floor((Date.now() - startTime) / 1000),
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    },
    memory: {
      rss: memoryUsage.rss, // Resident Set Size - physical memory used
      heapTotal: memoryUsage.heapTotal, // Total size of the allocated heap
      heapUsed: memoryUsage.heapUsed // Actual memory used during execution
    },
    loadAverage: os.loadavg()
  };
}

// Request function
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

// Test endpoint function
async function testEndpoint(path, method = 'POST', payload = null, useSystemAuth = false, useUserAuth = false) {
  const url = new URL(BASE_URL + path);
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (useSystemAuth && WORKER_SECRET) {
    options.headers['x-worker-secret'] = WORKER_SECRET;
  } else if (useUserAuth && USER_JWT) {
    options.headers['Authorization'] = `Bearer ${USER_JWT}`;
  }

  const start = performance.now();
  try {
    const response = await makeRequest(options, payload);
    const end = performance.now();
    return {
      success: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      latency: end - start,
      error: null
    };
  } catch (err) {
    const end = performance.now();
    return {
      success: false,
      statusCode: 0,
      latency: end - start,
      error: err.message
    };
  }
}

// Worker process functions
async function startWorkerProcess() {
  // In a real implementation, we would start the worker process
  // For this implementation, we'll assume it's already running via the scheduler
  // We'll monitor the llm_jobs table for processing jobs
  return { pid: 0 }; // Placeholder
}

async function stopWorkerProcess(pid) {
  // In a real implementation, we would stop the worker process
  // For this implementation, we'll just return
  return true;
}

// Queue depth monitoring
async function getQueueDepth() {
  // This would query the database for pending jobs
  // For now, we'll return a placeholder
  // In a real implementation, we would:
  // 1. Connect to the database
  // 2. Query: SELECT COUNT(*) FROM llm_jobs WHERE status = 'pending'
  // 3. Return the count

  // Since we don't have database access in this context, return a placeholder
  return 0; // Placeholder
}

// Main soak test function
async function runSoakTest() {
  console.log('Starting soak test for Cyrus V2...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Duration: ${DEFAULT_DURATION_HOURS} hour(s)`);
  console.log(`Concurrency: ${DEFAULT_CONCURRENCY} users`);
  console.log(`Sampling interval: ${SAMPLE_INTERVAL_MS / 1000} seconds`);

  startTime = Date.now();
  isRunning = true;

  const endTime = startTime + (DEFAULT_DURATION_HOURS * 60 * 60 * 1000);
  let requestCount = 0;
  let errorCount = 0;
  const latencies = [];

  // Start worker process monitoring
  const workerInfo = await startWorkerProcess();

  // Function to be run by each virtual user
  async function user(userId) {
    while (Date.now() < endTime && isRunning) {
      // We'll test the retrieve-context endpoint as an example
      const payload = { query: `test query ${userId} ${Date.now()}` };
      const result = await testEndpoint(RETRIEVE_CONTEXT_PATH, 'POST', payload, false, true); // user auth

      if (result.success) {
        requestCount++;
        latencies.push(result.latency);
      } else {
        errorCount++;
      }

      // Think time: wait a bit between requests to simulate user think time
      await new Promise(resolve => setTimeout(resolve, 100)); // 100ms think time
    }
  }

  // Start concurrent users
  const users = [];
  for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
    users.push(user(i));
  }

  // Start system metrics collection
  const metricsInterval = setInterval(() => {
    if (!isRunning) {
      clearInterval(metricsInterval);
      return;
    }

    const systemMetrics = collectSystemMetrics();
    metrics.push(systemMetrics);

    // Calculate and log hourly statistics
    if (metrics.length % (60 * 60 / (SAMPLE_INTERVAL_MS / 1000)) === 0) { // Every hour
      const hour = Math.floor(metrics.length / (60 * 60 / (SAMPLE_INTERVAL_MS / 1000)));
      console.log(`[Hour ${hour}] Processed ${requestCount} requests, ${errorCount} errors`);
    }
  }, SAMPLE_INTERVAL_MS);

  // Wait for all users to finish or timeout
  await Promise.all(users);

  isRunning = false;
  clearInterval(metricsInterval);

  // Stop worker process monitoring
  await stopWorkerProcess(workerInfo.pid);

  // Calculate final metrics
  const totalTime = Date.now() - startTime;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;
  const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(0.95 * latencies.length)] || 0;
  const p99Latency = latencies.sort((a, b) => a - b)[Math.floor(0.99 * latencies.length)] || 0;
  const throughput = requestCount / (totalTime / 1000); // requests per second

  // Memory leak detection
  const initialMemory = metrics[0] ? metrics[0].memory.heapUsed : 0;
  const finalMemory = metrics[metrics.length - 1] ? metrics[metrics.length - 1].memory.heapUsed : 0;
  const memoryGrowth = finalMemory - initialMemory;
  const memoryGrowthRate = memoryGrowth / (DEFAULT_DURATION_HOURS * 60); // MB per hour

  // Prepare results
  const results = {
    testConfig: {
      durationHours: DEFAULT_DURATION_HOURS,
      concurrency: DEFAULT_CONCURRENCY,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      baseUrl: BASE_URL
    },
    summary: {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(Date.now()).toISOString(),
      totalDurationSeconds: Math.floor(totalTime / 1000),
      totalRequests: requestCount,
      totalErrors: errorCount,
      errorRate: errorCount / requestCount || 0,
      requestsPerSecond: throughput,
      averageLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      p99LatencyMs: p99Latency,
      memoryGrowthBytes: memoryGrowth,
      memoryGrowthRateBytesPerHour: memoryGrowthRate
    },
    systemMetrics: metrics
  };

  // Save results to files
  const resultsDir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(resultsDir, `soak-test-${timestamp}.json`);
  const csvPath = path.join(resultsDir, `soak-test-${timestamp}.csv`);

  // Write JSON report
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Write CSV report
  let csvContent = 'Timestamp,ElapsedSeconds,CPU_User,CPU_System,Memory_RSS,Memory_HeapTotal,Memory_HeapUsed,Load_1m,Load_5m,Load_15m\n';
  metrics.forEach(m => {
    csvContent += `${m.timestamp},${m.elapsedSeconds},${m.cpu.user},${m.cpu.system},${m.memory.rss},${m.memory.heapTotal},${m.memory.heapUsed},${m.loadAverage[0]},${m.loadAverage[1]},${m.loadAverage[2]}\n`;
  });
  fs.writeFileSync(csvPath, csvContent);

  // Print summary
  console.log('\n=== Soak Test Summary ===');
  console.log(`Duration: ${results.summary.totalDurationSeconds} seconds`);
  console.log(`Total Requests: ${results.summary.totalRequests}`);
  console.log(`Total Errors: ${results.summary.totalErrors} (${(results.summary.errorRate * 100).toFixed(2)}%)`);
  console.log(`Requests/Second: ${results.summary.requestsPerSecond.toFixed(2)}`);
  console.log(`Average Latency: ${results.summary.averageLatencyMs.toFixed(2)} ms`);
  console.log(`P95 Latency: ${results.summary.p95LatencyMs.toFixed(2)} ms`);
  console.log(`P99 Latency: ${results.summary.p99LatencyMs.toFixed(2)} ms`);
  console.log(`Memory Growth: ${(results.summary.memoryGrowthBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Memory Growth Rate: ${(results.summary.memoryGrowthRateBytesPerHour / 1024 / 1024).toFixed(2)} MB/hour`);
  console.log(`Results saved to:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  CSV: ${csvPath}`);

  // Determine if test passed based on criteria
  const memoryLeakThreshold = 50 * 1024 * 1024; // 50 MB
  const passed =
    results.summary.errorRate < 0.01 && // Less than 1% error rate
    results.summary.memoryGrowthBytes < memoryLeakThreshold; // Less than 50 MB memory growth

  console.log(`\nTest Result: ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) {
    if (results.summary.errorRate >= 0.01) {
      console.log(`  FAIL Reason: Error rate too high (${(results.summary.errorRate * 100).toFixed(2)}%)`);
    }
    if (results.summary.memoryGrowthBytes >= memoryLeakThreshold) {
      console.log(`  FAIL Reason: Memory growth too high (${(results.summary.memoryGrowthBytes / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  return passed;
}

// Run the test if this script is executed directly
if (require.main === module) {
  runSoakTest()
    .then(passed => {
      process.exit(passed ? 0 : 1);
    })
    .catch(err => {
      console.error('Soak test failed with error:', err);
      process.exit(1);
    });
}

module.exports = { runSoakTest };