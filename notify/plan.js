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
    const tasks = items.filter(i => i.type !== 'event');
    const members = [...new Set(gsubs.map(s => s.member))];

    for (const m of members) {
      const msubs = gsubs.filter(s => s.member === m);
      const pending = (ds) => tasks.filter(i => occursOn(i, ds) && !done.has(i.id + '|' + ds + '|' + m));

      // Morning digest 8:00-11:00
      if (mins >= 480 && mins < 660) {
        const lines = [];
        pending(today).forEach(i => lines.push((i.type === 'deadline' ? '⏰ Due today: ' : '☐ ') + i.title));
        [1, 2].forEach(n => tasks.filter(i => i.type === 'deadline' && occursOn(i, addDays(today, n)) && !done.has(i.id + '|' + addDays(today, n) + '|' + m))
          .forEach(i => lines.push('📅 ' + (n === 1 ? 'Tomorrow' : 'In 2 days') + ': ' + i.title)));
        if (lines.length) msubs.forEach(s => add(s, `am|${g}|${m}|${today}|${s.endpoint.slice(-12)}`, 'Good morning ☀️', lines.slice(0, 5).join('\n')));
      }
      // Evening nudge 20:00-23:00
      if (mins >= 1200 && mins < 1380) {
        const lines = pending(today).map(i => '○ ' + i.title);
        for (let n = 1; n <= 7; n++) tasks.filter(i => i.type === 'deadline' && i.repeat === 'none' && i.date === addDays(today, -n) && !done.has(i.id + '|' + i.date + '|' + m)).forEach(i => lines.push('⚠️ Overdue: ' + i.title));
        if (lines.length) msubs.forEach(s => add(s, `pm|${g}|${m}|${today}|${s.endpoint.slice(-12)}`, 'Still pending today', lines.slice(0, 5).join('\n')));
      }
      // Timed items starting within 40 minutes
      items.filter(i => i.time && occursOn(i, today)).forEach(i => {
        const [h, mm] = i.time.split(':').map(Number), diff = h * 60 + mm - mins;
        if (diff >= 0 && diff <= 40) msubs.forEach(s => add(s, `t|${g}|${m}|${i.id}|${today}|${s.endpoint.slice(-12)}`, i.title, 'Starts at ' + t12(i.time)));
      });
      // Friend finished something (live ticks in the last 3 hours)
      comps.filter(c => c.notify && c.member !== m && nowMs - Date.parse(c.created_at) < 3 * 3600e3 && title[c.item_id]).forEach(c =>
        msubs.forEach(s => add(s, `c|${g}|${m}|${c.item_id}|${c.ds}|${c.member}|${s.endpoint.slice(-12)}`, `${c.member} finished ✅`, title[c.item_id])));
    }
  }
  return out;
}
module.exports = { plan, occursOn };
