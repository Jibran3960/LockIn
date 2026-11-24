// Pure logic: decides which notifications to send. No network here (so it can be tested).
const DEFAULT_TZ = 'Europe/London';
const dnum = s => { const [a, b, c] = s.split('-').map(Number); return Date.UTC(a, b - 1, c) / 864e5; };
const addDays = (ds, n) => new Date((dnum(ds) + n) * 864e5).toISOString().slice(0, 10);
const applies = (it, m) => !it.for || !it.for.length || it.for.includes(m);

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
const t12 = t => { let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; };

// Local date/time for a time zone (handles UK winter/summer time automatically).
const fmts = {};
function localNow(nowMs, tz) {
  let f = fmts[tz];
  if (!f) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try { f = fmts[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); }
    catch (e) { f = fmts[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TZ, ...opts }); }
  }
  const p = Object.fromEntries(f.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  return { today, mins: (+p.hour) * 60 + (+p.minute), dow: new Date(today + 'T00:00:00Z').getUTCDay() };
}

/**
 * subs: [{grp,member,endpoint,p256dh,auth,tz}]
 * data: { [grp]: { items:[item], comps:[{item_id,ds,member,created_at,notify}] } }
 * sent: Set of already-sent keys.  Returns [{sub,key,title,body}]
 */
function plan(subs, data, nowMs, sent) {
  const out = [];
  for (const g of Object.keys(data)) {
    const items = data[g].items.filter(i => !i.deleted), comps = data[g].comps;
    const gsubs = subs.filter(s => s.grp === g);
    const done = new Set(comps.map(c => c.item_id + '|' + c.ds + '|' + c.member));
    const title = Object.fromEntries(items.map(i => [i.id, i.title]));
    const rep = Object.fromEntries(items.map(i => [i.id, i.repeat]));
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    const tasks = items.filter(i => i.type !== 'event');
    const people = [...new Set([...gsubs.map(s => s.member), ...comps.map(c => c.member)])];

    for (const s of gsubs) {
      const m = s.member, sk = s.endpoint.slice(-12);
      const { today, mins, dow } = localNow(nowMs, s.tz || DEFAULT_TZ);
      const add = (key, t, b) => { const k = key + '|' + sk; if (!sent.has(k)) out.push({ sub: s, key: k, title: t, body: b }); };
      const dn = (id, ds, who) => done.has(id + '|' + ds + '|' + (who || m));
      const pending = ds => tasks.filter(i => applies(i, m) && occursOn(i, ds) && !dn(i.id, ds));

      // Morning digest 08:00-11:00 local
      if (mins >= 480 && mins < 660) {
        const lines = [];
        pending(today).forEach(i => lines.push((i.type === 'deadline' ? '⏰ Due today: ' : '☐ ') + i.title));
        [1, 2].forEach(n => tasks.filter(i => applies(i, m) && i.type === 'deadline' && occursOn(i, addDays(today, n)) && !dn(i.id, addDays(today, n)))
          .forEach(i => lines.push('📅 ' + (n === 1 ? 'Tomorrow' : 'In 2 days') + ': ' + i.title)));
        if (lines.length) add(`am|${g}|${m}|${today}`, 'Good morning ☀️', lines.slice(0, 5).join('\n'));
      }
      // Evening nudge 20:00-23:00 local
      if (mins >= 1200 && mins < 1380) {
        const lines = pending(today).map(i => '○ ' + i.title);
        for (let n = 1; n <= 7; n++) tasks.filter(i => applies(i, m) && i.type === 'deadline' && i.repeat === 'none' && i.date === addDays(today, -n) && !dn(i.id, i.date)).forEach(i => lines.push('⚠️ Overdue: ' + i.title));
        if (lines.length) add(`pm|${g}|${m}|${today}`, 'Still pending today', lines.slice(0, 5).join('\n'));
      }
      // Timed items starting within 40 minutes
      items.filter(i => i.time && applies(i, m) && occursOn(i, today)).forEach(i => {
        const [h, mm] = i.time.split(':').map(Number), diff = h * 60 + mm - mins;
        if (diff >= 0 && diff <= 40) add(`t|${g}|${m}|${i.id}|${today}`, i.title, 'Starts at ' + t12(i.time));
      });
      // Extra reminders chosen per item: 2d / 1d (at 09:00) or 2h / 1h before (its time, or 09:00)
      items.filter(i => i.remind && applies(i, m)).forEach(i => {
        const isTask = i.type !== 'event', lead = i.remind, n = parseInt(lead), word = isTask ? 'Due' : 'Starts';
        if (lead.endsWith('d')) {
          const ds = addDays(today, n);
          if (occursOn(i, ds) && !(isTask && dn(i.id, ds)) && mins >= 540 && mins < 720)
            add(`r|${g}|${m}|${i.id}|${ds}|${lead}`, '⏰ ' + i.title, (n === 1 ? word + ' tomorrow' : word + ' in 2 days') + (i.time ? ' at ' + t12(i.time) : ''));
        } else if (lead.endsWith('h')) {
          const dm = i.time ? (+i.time.split(':')[0]) * 60 + (+i.time.split(':')[1]) : 540, target = dm - n * 60;
          if (target >= 0 && occursOn(i, today) && !(isTask && dn(i.id, today)) && mins >= target && mins < target + 30)
            add(`r|${g}|${m}|${i.id}|${today}|${lead}`, '⏰ ' + i.title, (i.time ? 'Starts at ' + t12(i.time) : word + ' today') + ` (in ${n} hour${n > 1 ? 's' : ''})`);
        }
      });
      // A friend finished something (live ticks in the last 3 hours)
      comps.filter(c => c.notify && c.member !== m && nowMs - Date.parse(c.created_at) < 3 * 3600e3 && byId[c.item_id] && applies(byId[c.item_id], m)).forEach(c =>
        add(`c|${g}|${m}|${c.item_id}|${c.ds}|${c.member}`, `${c.member} completed ✅`, `"${title[c.item_id]}"` + (rep[c.item_id] && rep[c.item_id] !== 'none' ? ' (' + dshort(c.ds) + ')' : '')));
      // Sunday-evening weekly summary 18:00-21:00 local
      if (dow === 0 && mins >= 1080 && mins < 1260) {
        const stat = who => { let t = 0, d = 0; for (let k = -6; k <= 0; k++) { const ds = addDays(today, k); tasks.forEach(i => { if (applies(i, who) && occursOn(i, ds)) { t++; if (dn(i.id, ds, who)) d++; } }); } return { t, d }; };
        const me = stat(m);
        if (me.t) {
          const others = people.filter(p => p !== m).map(p => ({ p, ...stat(p) })).filter(x => x.t);
          const next = tasks.filter(i => i.type === 'deadline' && applies(i, m)).flatMap(i => { const r = []; for (let k = 1; k <= 7; k++) { const ds = addDays(today, k); if (occursOn(i, ds) && !dn(i.id, ds)) r.push([ds, i.title]); } return r; }).sort().slice(0, 2);
          add(`wk|${g}|${m}|${today}`, 'Your week 📊', [`You ${me.d}/${me.t}` + others.map(x => ` · ${x.p} ${x.d}/${x.t}`).join(''), ...next.map(([ds, t]) => `Next: ${t} (${dshort(ds)})`)].join('\n'));
        }
      }
    }
  }
  return out;
}
module.exports = { plan, occursOn };
