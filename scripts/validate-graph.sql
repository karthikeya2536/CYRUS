-- Phase 16 graph retrieval validation (run against local stack).
-- Verifies entity-shared traversal, hop limit, seed exclusion, result cap.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  uid UUID := gen_random_uuid();
  mA UUID; mB UUID; mC UUID; mD UUID;
  n_hops1 INT;
  n_all INT;
  has_seed INT;
  maxhop INT;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (uid, 'graph-test@example.com');

  -- A -(Alice)- B -(Phoenix)- C ; D is unrelated.
  INSERT INTO memory_records (user_id, category, content, memory_key, active) VALUES (uid,'person','m A','ka',TRUE) RETURNING id INTO mA;
  INSERT INTO memory_records (user_id, category, content, memory_key, active) VALUES (uid,'person','m B','kb',TRUE) RETURNING id INTO mB;
  INSERT INTO memory_records (user_id, category, content, memory_key, active) VALUES (uid,'project','m C','kc',TRUE) RETURNING id INTO mC;
  INSERT INTO memory_records (user_id, category, content, memory_key, active) VALUES (uid,'person','m D','kd',TRUE) RETURNING id INTO mD;

  INSERT INTO entity_mentions (user_id, memory_id, entity) VALUES
    (uid,mA,'Alice'), (uid,mB,'Alice'),
    (uid,mB,'Phoenix'), (uid,mC,'Phoenix'),
    (uid,mD,'Zelda');

  -- TEST 1: from seed A, hop limit 1 reaches B only (not C which is 2 hops).
  SELECT count(*) INTO n_hops1 FROM graph_expand_memories(uid, ARRAY[mA], 1, 25);
  IF n_hops1 <> 1 THEN RAISE EXCEPTION 'FAIL test1: expected 1 at hop1, got %', n_hops1; END IF;
  RAISE NOTICE 'PASS test1: hop-1 reaches only direct neighbor';

  -- TEST 2: from seed A, hop limit 2 reaches B and C (not D, not A).
  SELECT count(*) INTO n_all FROM graph_expand_memories(uid, ARRAY[mA], 2, 25);
  IF n_all <> 2 THEN RAISE EXCEPTION 'FAIL test2: expected 2 at hop2, got %', n_all; END IF;
  SELECT count(*) INTO has_seed FROM graph_expand_memories(uid, ARRAY[mA], 2, 25) WHERE id = mA;
  IF has_seed <> 0 THEN RAISE EXCEPTION 'FAIL test2: seed leaked into expansion'; END IF;
  RAISE NOTICE 'PASS test2: hop-2 reaches B+C, excludes seed and unrelated D';

  -- TEST 3: max hop value never exceeds the requested limit.
  SELECT max(hops) INTO maxhop FROM graph_expand_memories(uid, ARRAY[mA], 2, 25);
  IF maxhop > 2 THEN RAISE EXCEPTION 'FAIL test3: hop % exceeds MAX_HOPS', maxhop; END IF;
  RAISE NOTICE 'PASS test3: hop cap respected (max=%)', maxhop;

  -- TEST 4: result cap honored.
  IF (SELECT count(*) FROM graph_expand_memories(uid, ARRAY[mA], 2, 1)) > 1 THEN
    RAISE EXCEPTION 'FAIL test4: result cap not honored';
  END IF;
  RAISE NOTICE 'PASS test4: result cap honored';

  RAISE NOTICE 'ALL GRAPH TESTS PASSED';
END $$;
ROLLBACK;
