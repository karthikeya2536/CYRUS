# Cyrus V2 Production Validation Suite

This repository contains a comprehensive suite of tools for validating the production readiness of the Cyrus V2 system.

The validation suite is located in the `validation-suite/` directory and includes:

- Load testing tools
- Soak testing tools
- Failure injection tools
- Database validation tools
- Large dataset validation tools
- Benchmark scripts
- Runtime dashboard queries (SQL)
- Production deployment checklist
- Disaster recovery checklist
- Go/No-Go recommendation template

## Getting Started

See the README in the `validation-suite/` directory for detailed instructions on how to use the tools.

## Purpose

This suite is designed to help Site Reliability Engineers (SREs) and platform teams assess whether the Cyrus V2 system is ready for production deployment by testing under realistic conditions, including:

- High concurrent load
- Extended operation periods
- Various failure scenarios
- Data scalability
- Database performance and indexing

## Usage

1. Navigate to the `validation-suite` directory
2. Review the prerequisites and installation instructions in `validation-suite/README.md`
3. Run the individual test suites as needed
4. Use the results to inform the go/no-go decision for production release

## Important Notes

- Always test in a staging environment that mirrors production as closely as possible
- Never run load tests or data generation scripts against a production environment without explicit authorization
- Ensure you have backups before running tests that modify data
- The tools provided are starting points and may need to be adapted to your specific environment and requirements

## License

See the individual files for license information.
