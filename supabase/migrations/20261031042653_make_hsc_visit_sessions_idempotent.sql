-- A browser session creates at most one visit row; retried submissions resolve to the same record.
CREATE UNIQUE INDEX hsc_visits_session_id_key ON public.hsc_visits (session_id);
