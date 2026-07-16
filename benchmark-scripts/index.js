// benchmark-scripts/index.js
import path from 'path';
import fs from 'fs';

console.log('Benchmark script starting...');

// Benchmark configuration
const BENCHMARK_CONFIG = {
  OUTPUT_DIR: path.join(process.cwd(), 'validation-suite', 'results'),
  REPORT_NAME: 'cyrus-v2-production-report',
  LOAD_TEST: true,
  DATABASE_VALIDATION: true,
  LARGE_DATASET: true,
  FAILURE_INJECTION: true,
  SOAK_TEST: true
};

class BenchmarkRunner {
  constructor() {
    this.results = {
      benchmarkInfo: {
        startTime: new Date().toISOString(),
        endTime: null,
        durationSeconds: 0,
        durationMinutes: 0,
        baseUrl: process.env.BASE_URL || 'http://localhost:8000'
      },
      testResults: {},
      summary: {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        successRate: 0
      },
      recommendations: []
    };
  }

  /**
   * Run the load test suite
   */
  async runLoadTest() {
    console.log('🚀 Running Load Test Suite...');
    const startTime = Date.now();

    try {
      // Import and run the load test
      const { runLoadTests } = await import('../validation-suite/load-test/index.js');
      const results = await runLoadTests();

      const endTime = Date.now();
      this.results.testResults.loadTest = {
        success: true,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        output: `Load test completed with ${results.length} configurations tested`,
        details: results
      };

      console.log('✅ Load Test Suite completed successfully\n');
    } catch (error) {
      const endTime = Date.now();
      this.results.testResults.loadTest = {
        success: false,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        error: error.message,
        output: error.stack
      };

      console.log('❌ Load Test Suite failed:', error.message);
    }
  }

  /**
   * Run the database validation suite
   */
  async runDatabaseValidation() {
    console.log('🔍 Running Database Validation Suite...');
    const startTime = Date.now();

    try {
      // Import and run the database validation
      const { runExplainAnalyze } = await import('../validation-suite/database/index.js');
      const passed = await runExplainAnalyze();

      const endTime = Date.now();
      this.results.testResults.databaseValidation = {
        success: passed,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        output: passed ? 'All database RPCs passed execution time thresholds' : 'Some database RPCs exceeded execution time thresholds'
      };

      console.log(passed ? '✅ Database Validation Suite completed successfully\n' : '❌ Database Validation Suite failed\n');
    } catch (error) {
      const endTime = Date.now();
      this.results.testResults.databaseValidation = {
        success: false,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        error: error.message,
        output: error.stack
      };

      console.log('❌ Database Validation Suite failed:', error.message);
    }
  }

  /**
   * Run the large dataset validation suite
   */
  async runLargeDatasetValidation() {
    console.log('📊 Running Large Dataset Validation Suite...');
    const startTime = Date.now();

    try {
      // Import and run the large dataset validation
      const { runLargeDatasetValidation } = await import('../validation-suite/large-dataset/index.js');
      const success = await runLargeDatasetValidation();

      const endTime = Date.now();
      this.results.testResults.largeDataset = {
        success: success,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        output: success ? 'Large dataset validation completed successfully' : 'Large dataset validation failed'
      };

      console.log(success ? '✅ Large Dataset Validation Suite completed successfully\n' : '❌ Large Dataset Validation Suite failed\n');
    } catch (error) {
      const endTime = Date.now();
      this.results.testResults.largeDataset = {
        success: false,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        error: error.message,
        output: error.stack
      };

      console.log('❌ Large Dataset Validation Suite failed:', error.message);
    }
  }

  /**
   * Run the failure injection suite
   */
  async runFailureInjection() {
    console.log('💥 Running Failure Injection Suite...');
    const startTime = Date.now();

    try {
      // Import and run the failure injection test
      const { runFailureInjectionTests } = await import('../validation-suite/failure-injection/index.js');
      const passed = await runFailureInjectionTests();

      const endTime = Date.now();
      this.results.testResults.failureInjection = {
        success: passed,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        output: passed ? 'Failure injection tests completed successfully' : 'Failure injection tests completed with failures'
      };

      console.log(passed ? '✅ Failure Injection Suite completed successfully\n' : '❌ Failure Injection Suite completed with failures\n');
    } catch (error) {
      const endTime = Date.now();
      this.results.testResults.failureInjection = {
        success: false,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        error: error.message,
        output: error.stack
      };

      console.log('❌ Failure Injection Suite failed:', error.message);
    }
  }

  /**
   * Run the soak test suite
   */
  async runSoakTest() {
    console.log('🔥 Running Soak Test Suite...');
    const startTime = Date.now();

    try {
      // Import and run the soak test
      const { runSoakTest } = await import('../validation-suite/soak-test/index.js');
      const passed = await runSoakTest();

      const endTime = Date.now();
      this.results.testResults.soakTest = {
        success: passed,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        output: passed ? 'Soak test completed successfully - no significant memory leaks or error accumulation detected' : 'Soak test failed - potential memory leaks or excessive error rates detected'
      };

      console.log(passed ? '✅ Soak Test Suite completed successfully\n' : '❌ Soak Test Suite failed\n');
    } catch (error) {
      const endTime = Date.now();
      this.results.testResults.soakTest = {
        success: false,
        durationSeconds: Math.floor((endTime - startTime) / 1000),
        error: error.message,
        output: error.stack
      };

      console.log('❌ Soak Test Suite failed:', error.message);
    }
  }

  /**
   * Generate the final report
   */
  generateReport() {
    // Calculate benchmark info
    const endTime = Date.now();
    this.results.benchmarkInfo.endTime = new Date(endTime).toISOString();
    this.results.benchmarkInfo.durationSeconds = Math.floor((endTime - new Date(this.results.benchmarkInfo.startTime)) / 1000);
    this.results.benchmarkInfo.durationMinutes = Math.floor(this.results.benchmarkInfo.durationSeconds / 60);
    this.results.benchmarkInfo.durationSeconds = this.results.benchmarkInfo.durationSeconds % 60;

    // Calculate summary
    const testResults = this.results.testResults;
    const totalTests = Object.keys(testResults).length;
    const passedTests = Object.values(testResults).filter(result => result.success).length;

    this.results.summary.totalTests = totalTests;
    this.results.summary.passedTests = passedTests;
    this.results.summary.failedTests = totalTests - passedTests;
    this.results.summary.successRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;

    // Generate recommendations based on results
    this.results.recommendations = this.generateRecommendations();

    return this.results;
  }

  /**
   * Generate recommendations based on test results
   */
  generateRecommendations() {
    const recommendations = [];
    const testResults = this.results.testResults;

    // Load test recommendations
    if (testResults.loadTest && !testResults.loadTest.success) {
      recommendations.push({
        category: 'Performance',
        priority: 'High',
        issue: 'Load testing failed - system may not handle expected traffic loads',
        suggestion: 'Review edge function performance, database connection pooling, and consider horizontal scaling'
      });
    }

    // Database validation recommendations
    if (testResults.databaseValidation && !testResults.databaseValidation.success) {
      recommendations.push({
        category: 'Database',
        priority: 'High',
        issue: 'Database queries exceeding performance thresholds',
        suggestion: 'Review query execution plans, add missing indexes, consider query optimization'
      });
    }

    // Large dataset recommendations
    if (testResults.largeDataset && !testResults.largeDataset.success) {
      recommendations.push({
        category: 'Scalability',
        priority: 'Medium',
        issue: 'Large dataset validation failed - system may not scale to expected data volumes',
        suggestion: 'Review indexing strategies, consider partitioning, optimize memory extraction processes'
      });
    }

    // Failure injection recommendations
    if (testResults.failureInjection && !testResults.failureInjection.success) {
      recommendations.push({
        category: 'Resilience',
        priority: 'High',
        issue: 'Failure injection tests failed - system may not recover properly from failures',
        suggestion: 'Review retry mechanisms, circuit breaker patterns, and error handling in all edge functions'
      });
    }

    // Soak test recommendations
    if (testResults.soakTest && !testResults.soakTest.success) {
      recommendations.push({
        category: 'Stability',
        priority: 'Medium',
        issue: 'Soak test failed - potential memory leaks or resource accumulation',
        suggestion: 'Monitor memory usage over time and check for unclosed connections or unresolved promises'
      });
    }

    // If all tests passed
    if (Object.values(testResults).every(r => r.success)) {
      recommendations.push({
        category: 'Overall',
        priority: 'Info',
        issue: 'All validation tests passed',
        suggestion: 'System appears ready for production deployment under tested conditions'
      });
    }

    return recommendations;
  }

  /**
   * Save the report to files
   */
  async saveReport() {
    // Ensure output directory exists
    if (!fs.existsSync(BENCHMARK_CONFIG.OUTPUT_DIR)) {
      fs.mkdirSync(BENCHMARK_CONFIG.OUTPUT_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(BENCHMARK_CONFIG.OUTPUT_DIR, `${BENCHMARK_CONFIG.REPORT_NAME}-${timestamp}.json`);
    const mdPath = path.join(BENCHMARK_CONFIG.OUTPUT_DIR, `${BENCHMARK_CONFIG.REPORT_NAME}-${timestamp}.md`);

    // Save JSON report
    fs.writeFileSync(jsonPath, JSON.stringify(this.results, null, 2));

    // Generate and save MarkDreport
    const markdownReport = this.generateMarkdownReport();
    fs.writeFileSync(mdPath, markdownReport);

    console.log(`\nReports saved to:`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Markdown: ${mdPath}`);

    return { jsonPath, mdPath };
  }

  /**
   * Generate a markdown report from the results
   */
  generateMarkdownReport() {
    const info = this.results.benchmarkInfo;
    const summary = this.results.summary;
    const testResults = this.results.testResults;
    const recommendations = this.results.recommendations || [];

    let md = `# Cyrus V2 Production Validation Report\n\n`;
    md += `**Generated:** ${new Date(info.startTime).toLocaleString()}\n`;
    md += `**Duration:** ${info.durationMinutes} minutes ${info.durationSeconds} seconds\n`;
    md += `**Target System:** ${info.baseUrl}\n\n`;

    md += `## Executive Summary\n\n`;
    md += `Overall Success Rate: ${summary.successRate}% (${summary.passedTests}/${summary.totalTests} tests passed)\n\n`;

    md += `## Test Results Summary\n\n`;
    md += `| Test Suite | Status | Duration | Notes |\n`;
    md += `|------------|--------|----------|-------|\n`;

    for (const [testName, result] of Object.entries(testResults)) {
      const status = result.success ? '✅ PASS' : '❌ FAIL';
      const duration = result.durationSeconds ? `${result.durationSeconds}s` : 'N/A';
      const notes = result.error ? `Error: ${result.error.substring(0, 50)}...` : result.output || 'Completed successfully';
      md += `| ${testName} | ${status} | ${duration} | ${notes} |\n`;
    }

    md += `\n`;

    // Detailed results for each test
    for (const [testName, result] of Object.entries(testResults)) {
      md += `## ${testName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())} Results\n\n`;

      if (result.success) {
        md += `✅ **Status:** PASSED\n\n`;
        if (result.output) {
          // Extract key metrics from output if possible
          const lines = result.output.split('\n');
          const relevantLines = lines.filter(line =>
            line.includes('Duration:') ||
            line.includes('Requests/Second:') ||
            line.includes('Average Latency:') ||
            line.includes('error rate') ||
            line.includes('PASS') ||
            line.includes('FAIL')
          ).slice(0, 10); // Limit to first 10 relevant lines

          if (relevantLines.length > 0) {
            md += `**Key Metrics:**\n\n`;
            for (const line of relevantLines) {
              md += `- ${line.trim()}\n`;
            }
            md += `\n`;
          }
        }
      } else {
        md += `❌ **Status:** FAILED\n\n`;
        if (result.error) {
          md += `**Error:** ${result.error}\n\n`;
        }
        if (result.output) {
          md += `**Output:**\n\n\`\`\`\n${result.output.substring(0, 500)}${result.output.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
        }
      }
    }

    // Recommendations section
    if (recommendations.length > 0) {
      md += `## Recommendations\n\n`;
      md += `| Category | Priority | Issue | Suggestion |\n`;
      md += `|----------|----------|-------|------------|\n`;

      for (const rec of recommendations) {
        md += `| ${rec.category} | ${rec.priority} | ${rec.issue} | ${rec.suggestion} |\n`;
      }

      md += `\n`;
    }

    md += `---\n*Report generated by Cyrus V2 Production Validation Suite*\n`;

    return md;
  }

  /**
   * Run the complete benchmark suite
   */
  async run() {
    console.log('🚀 Starting Cyrus V2 Production Validation Suite\n');
    console.log(`Target: ${process.env.BASE_URL || 'http://localhost:8000'}`);
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    // Run selected test suites
    if (BENCHMARK_CONFIG.LOAD_TEST) {
      await this.runLoadTest();
    }

    if (BENCHMARK_CONFIG.DATABASE_VALIDATION) {
      await this.runDatabaseValidation();
    }

    if (BENCHMARK_CONFIG.LARGE_DATASET) {
      await this.runLargeDatasetValidation();
    }

    if (BENCHMARK_CONFIG.FAILURE_INJECTION) {
      await this.runFailureInjection();
    }

    if (BENCHMARK_CONFIG.SOAK_TEST) {
      await this.runSoakTest();
    }

    // Generate and save report
    const report = this.generateReport();
    const files = await this.saveReport();

    // Print final summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 VALIDATION SUITE COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${report.summary.totalTests}`);
    console.log(`Passed: ${report.summary.passedTests}`);
    console.log(`Failed: ${report.summary.failedTests}`);
    console.log(`Success Rate: ${report.summary.successRate}%`);
    console.log(`Total Duration: ${report.benchmarkInfo.durationMinutes}m ${report.benchmarkInfo.durationSeconds}s`);
    console.log('\n📄 Reports generated:');
    console.log(`  - JSON: ${files.jsonPath}`);
    console.log(`  - Markdown: ${files.mdPath}`);
    console.log('='.repeat(60) + '\n');

    return report;
  }
}

// Run the benchmark suite if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new BenchmarkRunner();
  benchmark.run().catch(error => {
    console.error('Benchmark suite failed with error:', error);
    process.exit(1);
  });
}

// Export the class for potential use in other modules
export { BenchmarkRunner };