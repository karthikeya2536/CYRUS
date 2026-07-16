import subprocess
import json
import sys
import math
import time

def run_sql(sql, timeout=60):
    cmd = ['supabase', 'db', 'query', '--linked', sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            print(f"SQL error: {result.stderr[:200]}", file=sys.stderr)
            return None
        text = result.stdout.strip()
        start = text.find('{')
        end = text.rfind('}')
        if start == -1 or end == -1:
            print("Could not find JSON in output", file=sys.stderr)
            return None
        json_str = text[start:end+1]
        data = json.loads(json_str)
        return data.get('rows', [])
    except subprocess.TimeoutExpired:
        print(f"SQL timeout after {timeout}s", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Exception: {e}", file=sys.stderr)
        return None

def main():
    sql = """
    SELECT user_id, source_node_id, target_node_id, relationship_type
    FROM graph_edges
    WHERE user_id IS NOT NULL
    ORDER BY random()
    LIMIT 5
    """
    rows = run_sql(sql, timeout=30)
    if rows is None:
        print("Failed to fetch edges")
        return
    print(f"Fetched {len(rows)} edges")
    
    total = 0
    hit5 = 0
    hit10 = 0
    hit100 = 0
    rr_sum = 0.0
    ndcg_sum = 0.0
    generic_in_top5 = 0
    dep_correct_first = 0
    dep_queries = 0
    
    generic_types = {'associated_with','regarding','involved_in','mentioned','interested_in'}
    dependency_types = {'blocked_by','requires','depends_on'}
    
    for idx, r in enumerate(rows):
        print(f"\n--- Edge {idx+1}/{len(rows)} ---")
        user_id = r['user_id']
        src = r['source_node_id']
        tgt = r['target_node_id']
        expected_type = r['relationship_type']
        total += 1
        
        # General intent with limit=100
        sql_gen = f"""
        SELECT source_node, relationship_type, target_node, score
        FROM graph_render_relations(
            '{user_id}'::uuid,
            ARRAY['{src}'::uuid],
            2, 100, 'general'
        )
        ORDER BY score DESC
        """
        rows_gen = run_sql(sql_gen, timeout=30)
        if rows_gen is None:
            time.sleep(2)
            continue
        
        retrieved = [(g['relationship_type'], g['target_node'], g['score']) for g in rows_gen]
        print(f"Number of results returned: {len(retrieved)}")
        if len(retrieved) > 0:
            print("Top 5 results:")
            for i, (rt, tn, sc) in enumerate(retrieved[:5]):
                print(f"  {i+1}: {rt} -> {tn} (score={sc:.4f})")
        
        found = False
        rank = None
        for i, (rt, tn, sc) in enumerate(retrieved, start=1):
            if tn == tgt and rt == expected_type:
                found = True
                rank = i
                print(f"Exact match found at rank {rank} with score {sc:.4f}")
                break
        if not found:
            print("Exact match NOT found in top 100.")
        if found:
            if rank <= 5:
                hit5 += 1
            if rank <= 10:
                hit10 += 1
            if rank <= 100:
                hit100 += 1
            if rank:
                rr_sum += 1.0 / rank
        
        # nDCG@10 (using top 10)
        dcg = 0.0
        for i, (rt, tn, sc) in enumerate(retrieved[:10], start=1):
            rel = 1.0 if (tn == tgt and rt == expected_type) else 0.0
            if i == 1:
                dcg += rel
            else:
                dcg += rel / math.log2(i)
        idcg = 1.0
        if idcg > 0:
            ndcg_sum += dcg / idcg
        
        # Generic ratio in top5
        top5_types = [rt for (rt, tn, _) in retrieved[:5]]
        generic_in_top5 += sum(1 for t in top5_types if t in generic_types)
        
        # Dependency intent (limit=1)
        sql_dep = f"""
        SELECT relationship_type
        FROM graph_render_relations(
            '{user_id}'::uuid,
            ARRAY['{src}'::uuid],
            2, 10, 'dependency'
        )
        ORDER BY score DESC
        LIMIT 1
        """
        row_dep = run_sql(sql_dep, timeout=30)
        if row_dep and len(row_dep) > 0:
            dep_queries += 1
            if row_dep[0]['relationship_type'] in dependency_types:
                dep_correct_first += 1
        
        time.sleep(2)
    
    if total == 0:
        print("No valid queries")
        return
    
    print("\n=== Summary ===")
    print(f"Evaluated {total} edges.")
    print(f"Recall@5 (exact match): {hit5/total:.3f}")
    print(f"Recall@10 (exact match): {hit10/total:.3f}")
    print(f"Recall@100 (exact match): {hit100/total:.3f}")
    print(f"MRR: {rr_sum/total:.3f}")
    print(f"nDCG@10: {ndcg_sum/total:.3f}")
    print(f"Average generic relations in top 5: {generic_in_top5/(total*5):.3f}")
    print(f"Accuracy of first result for dependency intent: {dep_correct_first/dep_queries if dep_queries else 0:.3f}")

if __name__ == '__main__':
    main()
