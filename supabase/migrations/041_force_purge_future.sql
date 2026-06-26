DELETE FROM calendar_events WHERE start_time > now() + interval '30 days';
