CREATE TABLE public.hsc_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  student_name text,
  class_name text,
  consented boolean NOT NULL DEFAULT false,
  skipped boolean NOT NULL DEFAULT true,
  visited_at timestamptz NOT NULL DEFAULT now(),
  visit_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  CONSTRAINT hsc_visit_name_length CHECK (student_name IS NULL OR char_length(student_name) BETWEEN 1 AND 80),
  CONSTRAINT hsc_visit_class_length CHECK (class_name IS NULL OR char_length(class_name) BETWEEN 1 AND 48),
  CONSTRAINT hsc_visit_consent_shape CHECK (
    (consented = true AND skipped = false AND student_name IS NOT NULL AND class_name IS NOT NULL)
    OR (consented = false AND skipped = true AND student_name IS NULL AND class_name IS NULL)
  )
);
CREATE INDEX hsc_visits_visited_at_idx ON public.hsc_visits (visited_at DESC);
CREATE INDEX hsc_visits_day_idx ON public.hsc_visits (visit_day DESC);

CREATE TABLE public.hsc_visit_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  visit_id uuid NOT NULL REFERENCES public.hsc_visits(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('download', 'video_watch')),
  resource_id text NOT NULL CHECK (char_length(resource_id) <= 240),
  resource_title text NOT NULL CHECK (char_length(resource_title) <= 200),
  resource_path text CHECK (resource_path IS NULL OR char_length(resource_path) <= 500),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hsc_visit_activities_visit_idx ON public.hsc_visit_activities (visit_id, occurred_at DESC);
CREATE INDEX hsc_visit_activities_time_idx ON public.hsc_visit_activities (occurred_at DESC);

CREATE TABLE public.hsc_active_sessions (
  session_id uuid PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hsc_active_sessions_last_seen_idx ON public.hsc_active_sessions (last_seen_at DESC);

CREATE TABLE public.hsc_daily_visits (
  day date PRIMARY KEY,
  visits bigint NOT NULL DEFAULT 0 CHECK (visits >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.hsc_record_daily_visit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.hsc_daily_visits (day, visits, updated_at)
  VALUES (NEW.visit_day, 1, now())
  ON CONFLICT (day) DO UPDATE
  SET visits = public.hsc_daily_visits.visits + 1,
      updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER hsc_visits_daily_count_trigger
AFTER INSERT ON public.hsc_visits
FOR EACH ROW EXECUTE FUNCTION public.hsc_record_daily_visit();

CREATE OR REPLACE FUNCTION public.hsc_reset_visitor_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.hsc_active_sessions;
  DELETE FROM public.hsc_visits; -- activities cascade
  DELETE FROM public.hsc_daily_visits;
END;
$$;

ALTER TABLE public.hsc_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hsc_visit_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hsc_active_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hsc_daily_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hsc_visits, public.hsc_visit_activities, public.hsc_active_sessions, public.hsc_daily_visits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hsc_record_daily_visit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hsc_reset_visitor_records() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hsc_reset_visitor_records() TO service_role;
