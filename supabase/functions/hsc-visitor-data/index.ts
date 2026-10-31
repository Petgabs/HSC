const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store'
};

const projectUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const repository = 'Petgabs/HSC';
const activeWindowMs = 2 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function requireUuid(value: unknown, field: string) {
  const text = String(value || '').trim();
  if (!uuidPattern.test(text)) throw new Error(`Invalid ${field}.`);
  return text;
}

async function database(path: string, options: RequestInit = {}) {
  if (!projectUrl || !serviceKey) throw new Error('Visitor service is not configured.');
  const headers = new Headers(options.headers || {});
  headers.set('apikey', serviceKey);
  headers.set('Authorization', `Bearer ${serviceKey}`);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${projectUrl}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  if (!response.ok) {
    // Never include submitted names or credentials in responses or logs.
    throw new Error(`Visitor database request failed (${response.status}).`);
  }
  if (!text) return { response, data: null };
  try {
    return { response, data: JSON.parse(text) };
  } catch {
    throw new Error('Visitor database returned invalid JSON.');
  }
}

function exactCount(response: Response) {
  const total = response.headers.get('content-range')?.split('/').at(-1) || '0';
  return Number.isSafeInteger(Number(total)) ? Number(total) : 0;
}

async function activeUserCount() {
  const cutoff = new Date(Date.now() - activeWindowMs).toISOString();
  const query = new URLSearchParams({ select: 'session_id', last_seen_at: `gt.${cutoff}` });
  const { response } = await database(`hsc_active_sessions?${query}`, {
    headers: { Prefer: 'count=exact', Range: '0-0' }
  });
  return exactCount(response);
}

async function totalVisitorCount() {
  const { response } = await database('hsc_visits?select=id', {
    headers: { Prefer: 'count=exact', Range: '0-0' }
  });
  return exactCount(response);
}

async function dailyVisitRows(limit = 30) {
  const query = new URLSearchParams({
    select: 'day,visits',
    order: 'day.desc',
    limit: String(limit)
  });
  const { data } = await database(`hsc_daily_visits?${query}`);
  return Array.isArray(data) ? data : [];
}

async function publicStats() {
  const [activeUsers, rows, totalVisitors] = await Promise.all([activeUserCount(), dailyVisitRows(), totalVisitorCount()]);
  const today = new Date().toISOString().slice(0, 10);
  const todayVisitors = Number(rows.find(row => row.day === today)?.visits) || 0;
  const daily = rows.slice(0, 30).reverse().map(row => ({ day: row.day, visits: Number(row.visits) || 0 }));
  return { active_users: activeUsers, today_visitors: todayVisitors, total_visitors: totalVisitors, daily_visits: daily };
}

async function verifyRepositoryWriter(token: unknown) {
  const githubToken = String(token || '').trim();
  if (!githubToken || githubToken.length > 500) return false;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      cache: 'no-store'
    });
    if (!response.ok) return false;
    const info = await response.json();
    return String(info?.full_name || '').toLowerCase() === repository.toLowerCase()
      && (!info?.permissions || info.permissions.push === true);
  } catch {
    return false;
  }
}

async function adminData(token: unknown) {
  if (!await verifyRepositoryWriter(token)) return json({ error: 'Admin authorization failed. Reconnect a repository-write GitHub token.' }, 403);
  const visitsQuery = new URLSearchParams({
    select: 'id,student_name,class_name,consented,skipped,visited_at,visit_day',
    order: 'visited_at.desc',
    limit: '300'
  });
  const activitiesQuery = new URLSearchParams({
    select: 'visit_id,activity_type,resource_title,occurred_at',
    order: 'occurred_at.desc',
    limit: '2000'
  });
  const [visitsResult, activitiesResult, summary] = await Promise.all([
    database(`hsc_visits?${visitsQuery}`),
    database(`hsc_visit_activities?${activitiesQuery}`),
    publicStats()
  ]);
  const activities = Array.isArray(activitiesResult.data) ? activitiesResult.data : [];
  const grouped = new Map<string, unknown[]>();
  for (const activity of activities) {
    const group = grouped.get(activity.visit_id) || [];
    if (group.length < 30) group.push({
      type: activity.activity_type,
      resource_title: activity.resource_title,
      occurred_at: activity.occurred_at
    });
    grouped.set(activity.visit_id, group);
  }
  const visits = (Array.isArray(visitsResult.data) ? visitsResult.data : []).map(visit => ({
    id: visit.id,
    student_name: visit.student_name,
    class_name: visit.class_name,
    consented: Boolean(visit.consented),
    skipped: Boolean(visit.skipped),
    visited_at: visit.visited_at,
    visit_day: visit.visit_day,
    activities: grouped.get(visit.id) || []
  }));
  return json({ ...summary, visits });
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 12_000) return json({ error: 'Request is too large.' }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);
  } catch {
    return json({ error: 'Invalid JSON request.' }, 400);
  }

  try {
    switch (body.action) {
      case 'heartbeat': {
        const sessionId = requireUuid(body.session_id, 'session id');
        await database('hsc_active_sessions?on_conflict=session_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ session_id: sessionId, last_seen_at: new Date().toISOString() })
        });
        return json(await publicStats());
      }
      case 'visit': {
        const sessionId = requireUuid(body.session_id, 'session id');
        const consented = body.consented === true;
        const skipped = !consented;
        const name = consented ? cleanText(body.student_name, 80) : '';
        const className = consented ? cleanText(body.class_name, 48) : '';
        if (consented && (!name || !className)) return json({ error: 'Enter your English name and class, or choose Skip.' }, 400);
        const { data } = await database('hsc_visits?on_conflict=session_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            session_id: sessionId,
            student_name: name || null,
            class_name: className || null,
            consented,
            skipped
          })
        });
        const visitId = Array.isArray(data) ? data[0]?.id : null;
        await database('hsc_active_sessions?on_conflict=session_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ session_id: sessionId, last_seen_at: new Date().toISOString() })
        });
        return json({ visit_id: visitId, ...(await publicStats()) });
      }
      case 'activity': {
        const sessionId = requireUuid(body.session_id, 'session id');
        const visitId = requireUuid(body.visit_id, 'visit id');
        const eventId = requireUuid(body.event_id, 'event id');
        const activityType = body.activity_type === 'video_watch' ? 'video_watch' : body.activity_type === 'download' ? 'download' : '';
        if (!activityType) return json({ error: 'Unsupported activity.' }, 400);
        const { data: visits } = await database(`hsc_visits?${new URLSearchParams({
          select: 'id,consented',
          id: `eq.${visitId}`,
          session_id: `eq.${sessionId}`,
          limit: '1'
        })}`);
        if (!Array.isArray(visits) || visits.length !== 1 || visits[0].consented !== true) return json({ stored: false });
        const resourceId = cleanText(body.resource_id, 240);
        const title = cleanText(body.resource_title, 200);
        const path = cleanText(body.resource_path, 500);
        if (!resourceId || !title) return json({ error: 'Resource details are required.' }, 400);
        await database('hsc_visit_activities?on_conflict=event_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            event_id: eventId,
            visit_id: visitId,
            session_id: sessionId,
            activity_type: activityType,
            resource_id: resourceId,
            resource_title: title,
            resource_path: path || null
          })
        });
        return json({ stored: true });
      }
      case 'public_stats':
        return json(await publicStats());
      case 'admin_list':
        return adminData(body.github_token);
      case 'admin_reset': {
        if (!await verifyRepositoryWriter(body.github_token)) return json({ error: 'Admin authorization failed. Reconnect a repository-write GitHub token.' }, 403);
        await database('rpc/hsc_reset_visitor_records', { method: 'POST', body: '{}' });
        return json({ ok: true, ...(await publicStats()) });
      }
      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } catch (error) {
    // The function log contains only a generic error message, never student data or tokens.
    console.error('HSC visitor action failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ error: error instanceof Error ? error.message : 'Visitor service failed.' }, 503);
  }
});
