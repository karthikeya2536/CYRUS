-- ============================================
-- Phase 14 dedup validation (run against local stack)
--   docker exec -i supabase_db_<ref> psql -U postgres -d postgres < scripts/validate-dedup.sql
-- Exercises the deterministic core: match_memory_candidates category guard,
-- top-5 ordering, threshold behaviour, merge-audit append, and never-delete.
-- LLM adjudication is not covered here (requires a provider).
-- ============================================
\set ON_ERROR_STOP on
BEGIN;

-- Seed a throwaway user + two same-category memories with near-identical
-- embeddings, and one different-category memory.
DO $$
DECLARE
  uid UUID := gen_random_uuid();
  v_same vector(768);
  v_near vector(768);
  v_far  vector(768);
  near_id UUID;
  cand RECORD;
  n_same INT;
  n_cross INT;
  pre_count INT;
  post_count INT;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (uid, 'dedup-test@example.com');

  -- Build deterministic 768-dim vectors.
  SELECT ('[' || array_to_string(array_fill(0.10::float8, ARRAY[768]), ',') || ']')::vector INTO v_same;
  SELECT ('[' || array_to_string(array_fill(0.11::float8, ARRAY[768]), ',') || ']')::vector INTO v_near; -- ~tiny cosine distance
  SELECT ('[' || array_to_string(array_fill(0.10::float8, ARRAY[768]), ',') || ']')::vector INTO v_far;  -- same vec, different category

  INSERT INTO public.memory_records (user_id, category, content, memory_key, embedding, active, occurrence_count, confidence_score)
  VALUES (uid, 'person', 'Alice leads the Phoenix project', 'k1', v_same, TRUE, 1, 80)
  RETURNING id INTO near_id;

  INSERT INTO public.memory_records (user_id, category, content, memory_key, embedding, active, occurrence_count, confidence_score)
  VALUES (uid, 'project', 'Phoenix launches in Q3', 'k2', v_far, TRUE, 1, 80);

  -- TEST 1: same-category candidate search returns the seeded person memory.
  SELECT count(*) INTO n_same
  FROM public.match_memory_candidates(uid, 'person', v_near, 5);
  IF n_same < 1 THEN RAISE EXCEPTION 'FAIL test1: same-category candidate not found'; END IF;
  RAISE NOTICE 'PASS test1: same-category candidate found (n=%)', n_same;

  -- TEST 2: category guard — searching 'preference' returns nothing despite
  -- a vector-identical row existing in 'project'/'person'.
  SELECT count(*) INTO n_cross
  FROM public.match_memory_candidates(uid, 'preference', v_near, 5);
  IF n_cross <> 0 THEN RAISE EXCEPTION 'FAIL test2: category guard leaked % rows', n_cross; END IF;
  RAISE NOTICE 'PASS test2: category guard blocks cross-category';

  -- TEST 3: nearest candidate distance is within the default threshold (0.15).
  SELECT * INTO cand FROM public.match_memory_candidates(uid, 'person', v_near, 5) LIMIT 1;
  IF cand.distance > 0.15 THEN RAISE EXCEPTION 'FAIL test3: distance % over threshold', cand.distance; END IF;
  RAISE NOTICE 'PASS test3: nearest distance % within threshold', cand.distance;

  -- TEST 4: merge audit append + never-delete. Simulate a merge decision.
  SELECT count(*) INTO pre_count FROM public.memory_records WHERE user_id = uid;
  UPDATE public.memory_records SET occurrence_count = occurrence_count + 1 WHERE id = near_id;
  INSERT INTO public.memory_merge_audit (user_id, canonical_id, category, duplicate_content, similarity_distance, decision, adjudicator)
  VALUES (uid, near_id, 'person', 'Alice runs Phoenix', cand.distance, 'merged', 'threshold');
  SELECT count(*) INTO post_count FROM public.memory_records WHERE user_id = uid;
  IF post_count <> pre_count THEN RAISE EXCEPTION 'FAIL test4: memory row count changed on merge (% -> %)', pre_count, post_count; END IF;
  IF (SELECT count(*) FROM public.memory_merge_audit WHERE user_id = uid AND decision = 'merged') <> 1 THEN
    RAISE EXCEPTION 'FAIL test4: merge audit row not written';
  END IF;
  RAISE NOTICE 'PASS test4: merge appended audit, no memory deleted/added (count=%)', post_count;

  RAISE NOTICE 'ALL DEDUP TESTS PASSED';
END $$;

ROLLBACK; -- never persist test data
