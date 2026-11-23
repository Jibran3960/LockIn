const webpush = require('web-push');
const { plan } = require('./plan');
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) { console.error('Missing env vars'); process.exit(1); }
webpush.setVapidDetails('https://jibran3960.github.io/LockIn/', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
const H = { apikey: KEY, 'Content-Type': 'application/json' };
const enc = encodeURIComponent;
async function rest(path, opt = {}) {
  const r = await fetch(URL_ + '/rest/v1/' + path, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
(async () => {
  const subs = await rest('push_subs?select=*');
  if (!subs.length) { console.log('No subscriptions yet.'); return; }
  const data = {};
  for (const g of [...new Set(subs.map(s => s.grp))]) {
    const items = (await rest('items?grp=eq.' + enc(g) + '&select=data')).map(r => r.data);
    const comps = await rest('completions?grp=eq.' + enc(g) + '&select=item_id,ds,member,created_at,notify');
    data[g] = { items, comps };
  }
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const sent = new Set((await rest('push_log?select=key&sent_at=gte.' + enc(since))).map(r => r.key));
  const todo = plan(subs, data, Date.now(), sent);
  console.log('To send:', todo.length);
  const ok = [];
  for (const n of todo) {
    try {
      await webpush.sendNotification({ endpoint: n.sub.endpoint, keys: { p256dh: n.sub.p256dh, auth: n.sub.auth } }, JSON.stringify({ title: n.title, body: n.body, url: './' }));
      ok.push({ key: n.key });
    } catch (e) {
      console.warn('Send failed', e.statusCode || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) await rest('push_subs?endpoint=eq.' + enc(n.sub.endpoint), { method: 'DELETE' }).catch(() => {});
    }
  }
  if (ok.length) await rest('push_log?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(ok) });
  console.log('Sent:', ok.length);
})().catch(e => { console.error(e); process.exit(1); });
