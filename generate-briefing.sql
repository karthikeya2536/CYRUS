INSERT INTO public.llm_jobs (user_id, job_type, priority, status, payload)
SELECT ca.user_id, 'briefing_generation', 1, 'pending', jsonb_build_object('source', 'manual')
FROM public.connected_accounts ca
WHERE ca.provider = 'google'
  AND ca.status = 'active';
