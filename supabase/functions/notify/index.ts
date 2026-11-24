// @ts-nocheck
// LockIn notification sender (Supabase Edge Function). Runs every minute (pg_cron) and instantly when someone ticks (DB trigger).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// Pure logic: decides which notifications to send. No network here (so it can be tested).
// Pure logic: decides which notifications to send. No network here (so it can be tested).
const TZ_OFFSET_MIN = 330; // India (IST, UTC+5:30)
const dnum = s => { const [a, b, c] = s.split('-').map(Number); return Date.UTC(a, b - 1, c) / 864e5; };
const addDays = (ds, n) => new Date((dnum(ds) + n) * 864e5).toISOString().slice(0, 10);

function occursOn(it, ds) {
  if (ds < it.date) return false;
  if (it.until && ds > it.until) return false;
  if (it.repeat === 'none') return ds === it.date;
  const a = new Date(it.date + 'T00:00:00Z'), b = new Date(ds + 'T00:00:00Z');
  if (it.repeat === 'daily') return true;
  if (it.repeat === 'weekly') return (dnum(ds) - dnum(it.date)) % 7 === 0;
  if (it.repeat === 'monthly') { const dim = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate(); return b.getUTCDate() === Math.min(a.getUTCDate(), dim); }
  if (it.repeat === 'yearly') return a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return false;
}
const dshort = ds => { const d = new Date(ds + 'T00:00:00Z'); return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; };
const applies = (it, m) => !it.for || !it.for.length || it.for.includes(m);
const t12 = t => { let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; };

/**
 * subs: [{grp,member,endpoint,p256dh,auth}]
 * data: { [grp]: { items:[item], comps:[{item_id,ds,member,created_at,notify}] } }
 * sent: Set of already-sent keys.  Returns [{sub,key,title,body}]
 */
function plan(subs, data, nowMs, sent) {
  const out = [];
  const ist = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  const today = ist.toISOString().slice(0, 10);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const add = (sub, key, title, body) => { if (!sent.has(key)) out.push({ sub, key, title, body }); };

  for (const g of Object.keys(data)) {
    const { items, comps } = data[g];
    const gsubs = subs.filter(s => s.grp === g);
    const done = new Set(comps.map(c => c.item_id + '|' + c.ds + '|' + c.member));
    const title = Object.fromEntries(items.map(i => [i.id, i.title]));
    const rep = Object.fromEntries(items.map(i => [i.id, i.repeat]));
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    const tasks = items.filter(i => i.type !== 'event');
    const members = [...new Set(gsubs.map(s => s.member))];

    for (const m of members) {
      const msubs = gsubs.filter(s => s.member === m);
      const pending = (ds) => tasks.filter(i => applies(i, m) && occursOn(i, ds) && !done.has(i.id + '|' + ds + '|' + m));

      // Morning digest 8:00-11:00
      if (mins >= 480 && mins < 660) {
        const lines = [];
        pending(today).forEach(i => lines.push((i.type === 'deadline' ? '⏰ Due today: ' : '☐ ') + i.title));
        [1, 2].forEach(n => tasks.filter(i => applies(i, m) && i.type === 'deadline' && occursOn(i, addDays(today, n)) && !done.has(i.id + '|' + addDays(today, n) + '|' + m))
          .forEach(i => lines.push('📅 ' + (n === 1 ? 'Tomorrow' : 'In 2 days') + ': ' + i.title)));
        if (lines.length) msubs.forEach(s => add(s, `am|${g}|${m}|${today}|${s.endpoint.slice(-12)}`, 'Good morning ☀️', lines.slice(0, 5).join('\n')));
      }
      // Evening nudge 20:00-23:00
      if (mins >= 1200 && mins < 1380) {
        const lines = pending(today).map(i => '○ ' + i.title);
        for (let n = 1; n <= 7; n++) tasks.filter(i => applies(i, m) && i.type === 'deadline' && i.repeat === 'none' && i.date === addDays(today, -n) && !done.has(i.id + '|' + i.date + '|' + m)).forEach(i => lines.push('⚠️ Overdue: ' + i.title));
        if (lines.length) msubs.forEach(s => add(s, `pm|${g}|${m}|${today}|${s.endpoint.slice(-12)}`, 'Still pending today', lines.slice(0, 5).join('\n')));
      }
      // Timed items starting within 40 minutes
      items.filter(i => i.time && applies(i, m) && occursOn(i, today)).forEach(i => {
        const [h, mm] = i.time.split(':').map(Number), diff = h * 60 + mm - mins;
        if (diff >= 0 && diff <= 40) msubs.forEach(s => add(s, `t|${g}|${m}|${i.id}|${today}|${s.endpoint.slice(-12)}`, i.title, 'Starts at ' + t12(i.time)));
      });
      // Friend finished something (live ticks in the last 3 hours)
      comps.filter(c => c.notify && c.member !== m && nowMs - Date.parse(c.created_at) < 3 * 3600e3 && byId[c.item_id] && applies(byId[c.item_id], m)).forEach(c =>
        msubs.forEach(s => add(s, `c|${g}|${m}|${c.item_id}|${c.ds}|${c.member}|${s.endpoint.slice(-12)}`, `${c.member} completed ✅`, `"${title[c.item_id]}"` + (rep[c.item_id] && rep[c.item_id] !== 'none' ? ' (' + dshort(c.ds) + ')' : ''))));
    }
  }
  return out;
}


Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('unauthorized', { status: 401 });
  const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  webpush.setVapidDetails('https://jibran3960.github.io/LockIn/', Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_PRIVATE_KEY'));

  const { data: subs, error: e1 } = await sb.from('push_subs').select('*');
  if (e1) return new Response('subs error: ' + e1.message, { status: 500 });
  if (!subs.length) return new Response('no subscriptions');
  const data = {};
  for (const g of [...new Set(subs.map((s) => s.grp))]) {
    const { data: items } = await sb.from('items').select('data').eq('grp', g);
    const { data: comps } = await sb.from('completions').select('item_id,ds,member,created_at,notify').eq('grp', g);
    data[g] = { items: (items || []).map((r) => r.data), comps: comps || [] };
  }
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const { data: logged } = await sb.from('push_log').select('key').gte('sent_at', since);
  const sent = new Set((logged || []).map((r) => r.key));
  const todo = plan(subs, data, Date.now(), sent);

  const ok = [];
  for (const n of todo) {
    try {
      await webpush.sendNotification({ endpoint: n.sub.endpoint, keys: { p256dh: n.sub.p256dh, auth: n.sub.auth } }, JSON.stringify({ title: n.title, body: n.body, url: './' }));
      ok.push({ key: n.key });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await sb.from('push_subs').delete().eq('endpoint', n.sub.endpoint);
    }
  }
  if (ok.length) await sb.from('push_log').upsert(ok, { onConflict: 'key' });
  return new Response(`planned ${todo.length}, sent ${ok.length}`);
});
