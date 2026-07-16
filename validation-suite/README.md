# Cyrus V2 Production Validation Suite

This directory contains tooling for validating the production readiness of Cyrus V2.

## Directory Structure

- `load-test/`: Scripts for load testing various endpoints at different concurrency levels.
- `soak-test/`: Scripts for running tests over extended periods to check for leaks and degradation.
- `failure-injection/`: Scripts for simulating various failure scenarios and verifying recovery.
- `database/`: Scripts for validating database performance and usage of indexes.
- `large-dataset/`: Scripts for testing with large volumes of data.
- `benchmark-scripts/`: Simple benchmark scripts for quick performance checks.
- `PRODUCTION_DEPLOYMENT_CHECKLIST.md`: Checklist for deploying to production.
- `DISASTER_RECOVERY_CHECKLIST.md`: Checklist for responding to and recovering from incidents.
- `GO_NO_GO_RECOMMENDATION.md`: Template for documenting the go/no-go decision based on test results.

## Prerequisites

- Node.js (v16 or later)
- npm (comes with Node)
- Environment variables set for testing:
  - `DATABASE_URL`: PostgreSQL connection string for the Supabase database
  - `BASE_URL`: Base URL for the edge functions (e.g., `http://localhost:8000` for local, or the production URL)
  - `WORKER_SECRET`: The shared secret for system-to-system calls (if testing system endpoints)
  - `USER_JWT`: A valid JWT for a user (if testing user endpoints)
  - Other variables as needed by specific tests

## Installation

From the `validation-suite` directory:

```bash
npm install
```

## Usage

### Load Testing

To run the load test at various concurrency levels:

```bash
npm run load-test
```

This will test the endpoints at 1, 10, 50, 100, 250, and 500 concurrent users (configurable in the script).

### Soak Testing

To run a soak test (edit the duration in `soak-test/index.js`):

```bash
npm run soak-test
```

### Failure Injection

To run failure injection tests (see `failure-injection/index.js` for available scenarios):

```bash
npm run failure-injection
```

### Database Validation

To run EXPLAIN ANALYZE on production RPCs (edit `database/index.js` to specify the RPCs and parameters):

```bash
npm run database
```

### Large Dataset Validation

To test with large datasets (edit `large-dataset/index.js` to specify the sizes):

```bash
npm run large-dataset
```

### Benchmark Scripts

For quick benchmarks:

```bash
node benchmark-scripts/index.js
```

## Customizing the Tests

Each test script can be modified to suit your specific environment and testing needs. Look for the "TODO" comments or configuration sections in each file.

## Important Notes

- These scripts are meant to be run in a staging environment that closely mirrors production.
- Do not run load tests or large dataset generation against a production environment without explicit permission.
- Always back up your data before running tests that modify the database.
- The failure injection tests may cause temporary service degradation; ensure they are run in a controlled environment.

## Extending the Suite

To add new tests:
1. Create a new directory under `validation-suite` for the test type.
2. Add an `index.js` file that exports the test logic.
3. Update the `scripts` section in `package.json` if you want to add a new npm script.
4. Document any new environment variables or configuration options.

## License

ISC