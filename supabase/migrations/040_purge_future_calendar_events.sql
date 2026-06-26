-- Purge any existing calendar events that are more than 30 days in the future or already past.
-- This ensures that legacy data synced before the time window fixes is removed.

DELETE FROM public.calendar_events
WHERE start_time > now() + interval '30 days';

DELETE FROM public.calendar_events
WHERE end_time < now();
