// Edge Function: announces board schedules in each department's Telegram chat.
// - "tick" (called every 5 minutes by pg_cron, no login): sends the messages the database says are due, then reports each one as done.
//   Anyone may call it; it only ever sends what is due, once, to chats an administrator linked.
// - "info" / "link-check" / "test" (called from the administrator screen, need an administrator login).
// The bot token is the function secret TELEGRAM_BOT_TOKEN (entered by the administrator in Supabase, never stored in this repository).
// Errors are reported without the Telegram address, because that address contains the token.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function telegram(method: string, body: Record<string, unknown> = {}) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return { ok: false, error_code: 0, description: 'TELEGRAM_BOT_TOKEN is not set' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return await response.json();
  } catch {
    return { ok: false, error_code: 0, description: 'Could not reach Telegram' };
  }
}

async function isAdmin(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return false;
  const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const result = await user.rpc('serotonin_is_admin');
  return result.data === true;
}

async function tick() {
  const due = await service.rpc('serotonin_telegram_due');
  if (due.error) return json({ ok: false, step: 'due', message: due.error.message }, 500);
  const jobs: { dept: string; chat: number; kind: string; mark: string; text: string }[] = due.data ?? [];
  let sent = 0;
  for (const job of jobs) {
    const result = await telegram('sendMessage', { chat_id: job.chat, text: job.text, disable_web_page_preview: true });
    if (result.ok) {
      await service.rpc('serotonin_telegram_done', { p_dept: job.dept, p_kind: job.kind, p_mark: job.mark });
      sent++;
    } else {
      // 400/403 mean the chat is gone or the bot was removed: stop trying. Anything else (network, rate limit) is retried at the next run.
      const refused = result.error_code === 400 || result.error_code === 403;
      await service.rpc('serotonin_telegram_failed', { p_dept: job.dept, p_message: result.description, p_disable: refused });
    }
  }
  return json({ ok: true, due: jobs.length, sent });
}

// Reads the bot's recent messages for "/link CODE" and links that chat to the department that issued the code.
async function linkCheck() {
  const updates = await telegram('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  if (!updates.ok) return json({ ok: false, message: updates.description });
  const linked: string[] = [];
  let last = 0;
  for (const update of updates.result ?? []) {
    last = Math.max(last, update.update_id);
    const message = update.message;
    const found = /^\/link(?:@\w+)?\s+([A-Za-z0-9-]{6,40})\s*$/.exec(message?.text ?? '');
    if (!found || !['private', 'group', 'supergroup'].includes(message.chat?.type)) continue;
    const result = await service.rpc('serotonin_telegram_link_finish', { p_code: found[1].toUpperCase(), p_chat: message.chat.id });
    if (result.error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: '이 대화방은 이미 다른 부서에 연결되어 있어 연결하지 못했습니다.' });
    } else if (result.data) {
      linked.push(result.data);
      await telegram('sendMessage', { chat_id: message.chat.id, text: '✅ 연결되었습니다. 이 대화방으로 일정 알림을 보냅니다.' });
    }
  }
  if (last) await telegram('getUpdates', { offset: last + 1, limit: 1, timeout: 0 }); // mark what was read as handled
  return json({ ok: true, linked });
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let input: { action?: string; dept?: string } = {};
  try {
    input = await request.json();
  } catch {
    // an empty body is treated as a tick
  }
  const action = input.action ?? 'tick';
  if (action === 'tick') return await tick();
  if (!(await isAdmin(request))) return json({ ok: false, message: 'Administrator required' }, 403);
  if (action === 'info') {
    const me = await telegram('getMe');
    return json(
      me.ok
        ? { ok: true, configured: true, username: me.result.username }
        : { ok: false, configured: me.error_code !== 0, message: me.description },
    );
  }
  if (action === 'link-check') return await linkCheck();
  if (action === 'test') {
    const chat = await service.rpc('serotonin_telegram_chat', { p_dept: input.dept });
    if (chat.error || chat.data == null) return json({ ok: false, message: '연결된 대화방이 없습니다.' });
    const result = await telegram('sendMessage', {
      chat_id: chat.data,
      text: '✅ 시험 메시지입니다. 이 대화방에서 보드 일정 알림을 받게 됩니다.',
    });
    return json({ ok: result.ok === true, message: result.ok ? undefined : result.description });
  }
  return json({ ok: false, message: 'Unknown action' }, 400);
});
