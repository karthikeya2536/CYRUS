# Database Validation Report

**Timestamp:** 2026-07-16T08:29:02.177Z

**Execution Time Threshold:** 100ms

**Summary:**
- Total RPCs Tested: 8
- Passed: 0
- Failed: 8
- Pass Rate: 0.00%

## Detailed Results

| RPC Name | Execution Time (ms) | Planning Time (ms) | Total Time (ms) | Passes Threshold | Sequential Scan | Index Scan | Uses HNSW (approx) | Uses GIN (approx) |
|----------|-------------------|-------------------|----------------|------------------|-----------------|------------|-------------------|------------------|
| hybrid_search_memories | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "hyperspace" does not exist* | | | | | | | |
| hybrid_search_emails | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "hyperspace" does not exist* | | | | | | | |
| hybrid_search_events | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "hyperspace" does not exist* | | | | | | | |
| resolve_nodes_for_memories | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "graph" does not exist* | | | | | | | |
| graph_render_relations | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "graph" does not exist* | | | | | | | |
| match_memory_candidates | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "hyperspace" does not exist* | | | | | | | |
| record_memory_retrievals | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "memory" does not exist* | | | | | | | |
| increment_usage | ERROR | ERROR | ERROR | NO | ERROR | ERROR | ERROR | ERROR |
| | *Error: schema "usage" does not exist* | | | | | | | |
