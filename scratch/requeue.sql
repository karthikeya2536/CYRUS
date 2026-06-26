INSERT INTO public.llm_jobs (user_id, job_type, priority, payload, status)
SELECT 
  user_id, 
  'graph_construction', 
  4, 
  jsonb_build_object(
    'memory_id', id,
    'content', content,
    'expires_at', expires_at
  ),
  'pending'
FROM public.memory_records;
