import { describe, expect, it, vi } from 'vitest';
import { StudentVisitorClient } from '../assets/js/lib/studentVisitors.js';

const ok = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('StudentVisitorClient', () => {
  it('posts to the Edge Function with only the public key and action payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ active_users: 4 }));
    const client = new StudentVisitorClient({
      baseUrl: 'https://example.supabase.co/',
      publishableKey: 'sb_publishable_public',
      fetchImpl
    });

    await expect(client.request('heartbeat', { session_id: 'session-id', action: 'admin_reset' })).resolves.toEqual({ active_users: 4 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.supabase.co/functions/v1/hsc-visitor-data');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit' });
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      apikey: 'sb_publishable_public',
      'Content-Type': 'application/json'
    });
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ session_id: 'session-id', action: 'heartbeat' });
  });

  it('does not accept unsupported actions or return non-object payloads', async () => {
    const client = new StudentVisitorClient({ baseUrl: 'https://example.supabase.co', publishableKey: 'public', fetchImpl: vi.fn().mockResolvedValue(ok([])) });
    await expect(client.request('arbitrary')).rejects.toThrow('Unsupported visitor action');
    await expect(client.request('public_stats')).resolves.toEqual({});
  });

  it('surfaces safe server errors and handles empty success responses', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Admin authorization failed.' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new StudentVisitorClient({ baseUrl: 'https://example.supabase.co', publishableKey: 'public', fetchImpl });
    await expect(client.request('admin_list')).rejects.toThrow('Admin authorization failed.');
    await expect(client.request('activity')).resolves.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
