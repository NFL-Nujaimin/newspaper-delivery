/* Newspaper Delivery — delivery helper (PWA). All data stays on this phone (localStorage). */
'use strict';

const PAPERS = [
  { key: 'kahoku',   label: 'Kahoku',   jp: 'かほく',     cls: 'k', color: '#22c55e' },
  { key: 'mainichi', label: 'Mainichi', jp: '毎日',       cls: 'm', color: '#3b82f6' },
  { key: 'seikyo',   label: 'Seikyo',   jp: 'せいきょう', cls: 's', color: '#a855f7' },
];
const PLACE_CHIPS = ['Mailbox', 'Front-door post (玄関ポスト)', 'Push all the way in (落としこむ)', 'Door gap', 'Hand to person'];
const LS_KEY = 'paperRoute.v1'; // kept from the first version so existing data is preserved
const DEFAULT_CENTER = [38.268, 140.87]; // Sendai
const LIST_COUNT = 30;  // next-house cards in the swiped-up row

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = 'none'), ms);
}
function haversine(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const fmtDist = m => m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

/* ---------- data ---------- */
let db = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(LS_KEY)); if (d && Array.isArray(d.areas)) return normalize(d); } catch (e) {}
  return normalize({});
}
function normalize(d) {
  d.areas ??= []; d.settings ??= {};
  d.settings.darkMap ??= true; d.settings.wake ??= true;
  if (!d.areas.length) { const a = { id: uid(), name: 'My area', houses: [] }; d.areas.push(a); d.activeAreaIds = [a.id]; }
  const exists = id => d.areas.some(a => a.id === id);
  if (!Array.isArray(d.activeAreaIds)) d.activeAreaIds = [exists(d.currentAreaId) ? d.currentAreaId : d.areas[0].id];
  d.activeAreaIds = d.activeAreaIds.filter(exists);
  if (!exists(d.editAreaId)) d.editAreaId = d.activeAreaIds[0] || d.areas[0].id;
  delete d.currentAreaId;
  if (!d.progress || !Array.isArray(d.progress.done)) d.progress = null; // old format → fresh
  return d;
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { toast('⚠️ Could not save!'); } }

const activeAreas = () => db.areas.filter(a => db.activeAreaIds.includes(a.id));
const editArea = () => db.areas.find(a => a.id === db.editAreaId) || db.areas[0];
const multi = () => activeAreas().length > 1;
function where(id) {
  for (const a of db.areas) { const i = a.houses.findIndex(h => h.id === id); if (i >= 0) return { a, i, h: a.houses[i] }; }
  return null;
}
const findHouse = id => where(id)?.h;
const houseNo = h => (where(h.id)?.i ?? -1) + 1;
const isStopped = (h, d = today()) => !!h.stopFrom && d >= h.stopFrom && (!h.stopTo || d <= h.stopTo);
const hasLoc = h => typeof h.lat === 'number' && typeof h.lng === 'number';
function newProgress() { return { date: today(), started: false, done: [], skipped: [], history: [] }; }
function prog() {
  if (!db.progress || db.progress.date !== today()) { db.progress = newProgress(); save(); }
  return db.progress;
}
const route = () => activeAreas().flatMap(a => a.houses.filter(h => !isStopped(h)));
function statusOf(h) {
  const p = prog();
  if (isStopped(h)) return 'stopped';
  if (p.done.includes(h.id)) return 'done';
  if (p.skipped.includes(h.id)) return 'skipped';
  return 'todo';
}
const current = () => route().find(h => statusOf(h) === 'todo') || null;
function upcoming(n) {
  const r = route(), c = current(); if (!c) return [];
  return r.slice(r.indexOf(c) + 1).filter(h => statusOf(h) === 'todo').slice(0, n);
}
const todoCount = () => route().filter(h => statusOf(h) === 'todo').length;
function paperTotals(list) {
  const t = {}; PAPERS.forEach(p => (t[p.key] = 0));
  list.forEach(h => PAPERS.forEach(p => (t[p.key] += +(h.papers?.[p.key] || 0))));
  return t;
}
const paperCols = h => PAPERS.filter(p => +(h.papers?.[p.key] || 0) > 0).map(p => p.color);
function pinBg(h) {
  const cols = paperCols(h);
  if (!cols.length) return '#64748b';
  if (cols.length === 1) return cols[0];
  const step = 360 / cols.length;
  return `conic-gradient(${cols.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(',')})`;
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, maxZoom: 20 }).setView(DEFAULT_CENTER, 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let lineToTarget = null, meMarker = null, meAcc = null;
let myPos = null, watchId = null, follow = false;
let tab = 'direction', selectedId = null, expanded = false;

/* iOS home-screen apps sometimes report a viewport that is too short, leaving a
   gap under the bottom bar. Size the app box to the real screen instead. */
function fitApp() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let h = window.innerHeight;
  if (standalone) {
    const portrait = window.innerWidth <= window.innerHeight;
    const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    h = Math.max(h, screenH);
  }
  document.documentElement.style.setProperty('--app-h', h + 'px');
  map.invalidateSize();
}
['resize', 'orientationchange', 'pageshow'].forEach(ev => window.addEventListener(ev, () => setTimeout(fitApp, 50)));
window.visualViewport?.addEventListener('resize', () => setTimeout(fitApp, 50));
// after the keyboard closes, put the page back in place (iOS can leave it shifted)
document.addEventListener('focusout', () => setTimeout(() => { window.scrollTo(0, 0); fitApp(); }, 100));

function applyMapStyle() { document.body.classList.toggle('dark-tiles', !!db.settings.darkMap); }
map.on('zoomend', () => $('#map').classList.toggle('show-labels', map.getZoom() >= 18));

function mapHouses() {
  const list = activeAreas().flatMap(a => a.houses);
  if (ed) { const a = db.areas.find(x => x.id === ed._areaId); if (a && !db.activeAreaIds.includes(a.id)) list.push(...a.houses); }
  return list;
}
function renderMarkers() {
  markerLayer.clearLayers();
  const cur = current();
  mapHouses().forEach(h => {
    if (!hasLoc(h)) return;
    const st = statusOf(h), n = houseNo(h);
    const isCur = cur && h.id === cur.id;
    const size = st === 'done' ? 20 : isCur ? 40 : 28;
    const cls = ['pin', st, isCur ? 'current' : '', h.id === selectedId ? 'sel' : ''].join(' ');
    const icon = L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="${cls}" style="background:${pinBg(h)}">${st === 'done' ? '✓' : n}</div>`,
    });
    const m = L.marker([h.lat, h.lng], { icon, zIndexOffset: isCur ? 1000 : h.id === selectedId ? 900 : st === 'done' ? -100 : 0 });
    m.bindTooltip(esc(h.kanji || h.kana || `#${n}`), { permanent: true, direction: 'top', offset: [0, -size / 2], className: 'lbl' });
    m.on('click', () => openInfo(h.id));
    m.addTo(markerLayer);
  });
  drawLine();
}
function drawLine() {
  if (lineToTarget) { map.removeLayer(lineToTarget); lineToTarget = null; }
  const c = current(), p = prog();
  if (tab === 'direction' && p.started && c && hasLoc(c) && myPos) {
    lineToTarget = L.polyline([myPos, [c.lat, c.lng]], { color: '#fbbf24', weight: 4, dashArray: '8 8', opacity: .9 }).addTo(map);
  }
}
function sheetHeight() {
  const s = tab === 'overview' ? $('#ovSheet') : $('#dirSheet');
  return s && s.style.display !== 'none' ? s.offsetHeight : 0;
}
function focusPoints(points, minZoom = 17) {
  points = points.filter(Boolean);
  if (!points.length) return;
  map.stop();
  map.fitBounds(L.latLngBounds(points), {
    paddingTopLeft: [40, 70], paddingBottomRight: [60, sheetHeight() + 30],
    maxZoom: points.length === 1 ? Math.max(minZoom, Math.min(19, map.getZoom())) : 19,
  });
}
function focusHouse(h, withMe = true) {
  if (!h || !hasLoc(h)) return;
  const pts = [[h.lat, h.lng]];
  if (withMe && myPos && haversine(myPos, pts[0]) < 500) pts.push(myPos);
  focusPoints(pts, 18);
}
function fitAll() {
  const pts = mapHouses().filter(hasLoc).map(h => [h.lat, h.lng]);
  if (pts.length) focusPoints(pts, 10); else if (myPos) map.setView(myPos, 17);
}

/* ---------- GPS ---------- */
function startGPS() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(pos => {
    myPos = [pos.coords.latitude, pos.coords.longitude];
    const acc = pos.coords.accuracy;
    if (!meMarker) {
      meMarker = L.marker(myPos, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, interactive: false }).addTo(map);
      meAcc = L.circle(myPos, { radius: acc, color: '#3b82f6', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(myPos); meAcc.setLatLng(myPos).setRadius(acc); }
    if (follow) map.panTo(myPos, { animate: true });
    drawLine(); renderTop(); updateDistances();
  }, err => {
    if (err.code === 1) toast('Location permission denied. Allow it in iPhone Settings → Privacy → Location.', 4000);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
function getOnce() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No GPS'));
    navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function keepAwake() {
  if (!db.settings.wake || !('wakeLock' in navigator) || !prog().started) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); render(); } });

/* ---------- top bar ---------- */
function renderTop() {
  const t = $('#topInfo'), p = prog(), r = route();
  if (tab === 'settings') { t.textContent = 'Settings'; return; }
  const names = activeAreas().map(a => a.name).join(' + ') || 'No area';
  const done = r.filter(h => p.done.includes(h.id)).length;
  let s = `<b>${esc(names)}</b> · ${done}/${r.length}`;
  const c = current();
  if (tab === 'direction' && p.started && c) {
    s += ` · next #${houseNo(c)}`;
    if (myPos && hasLoc(c)) s += ` · ${fmtDist(haversine(myPos, [c.lat, c.lng]))}`;
  }
  t.innerHTML = s;
}

/* ---------- house display pieces ---------- */
function badgesHTML(h) {
  const out = [];
  PAPERS.forEach(p => { const q = +(h.papers?.[p.key] || 0); if (q) out.push(`<span class="b ${p.cls}">${p.label} ×${q}</span>`); });
  if (h.deadline) out.push(`<span class="b red">⏰ by ${esc(h.deadline)}</span>`);
  if (h.wrap) out.push(`<span class="b warn">Wrap (ラッピング)</span>`);
  if (h.noFlyer) out.push(`<span class="b warn">No flyers</span>`);
  if (h.place) out.push(`<span class="b">📮 ${esc(h.place)}</span>`);
  if (h.rooms) out.push(`<span class="b">🏢 ${esc(h.rooms)}</span>`);
  if (!hasLoc(h)) out.push(`<span class="b red">No location set</span>`);
  return `<div class="badges">${out.join('')}</div>`;
}
const noteHTML = h => h.note ? `<div class="note">${esc(h.note)}</div>` : '';
const numHTML = h => `<div class="num" style="background:${pinBg(h)}">${houseNo(h)}</div>`;
const areaTag = h => multi() ? `<span class="atag">${esc(where(h.id)?.a.name)}</span>` : '';
const distTo = h => myPos && hasLoc(h) ? haversine(myPos, [h.lat, h.lng]) : null;

/* ---------- Direction ---------- */
function setExpanded(v) {
  if (expanded === v) return;
  expanded = v;
  if (!v && selectedId) { selectedId = null; renderMarkers(); document.querySelectorAll('.ncard.sel').forEach(x => x.classList.remove('sel')); }
  $('#dirSheet').classList.toggle('expanded', v && prog().started && !!current());
  // wait for the slide animation, then keep the house visible above the panel
  setTimeout(() => focusHouse(selectedId ? findHouse(selectedId) : current(), !selectedId), 280);
}
function renderDirection() {
  const body = $('#dirBody'), p = prog(), r = route(), c = current();
  $('#dirSheet').classList.toggle('expanded', expanded && p.started && !!c);
  $('#dirHint').textContent = '';

  if (!activeAreas().length) {
    body.innerHTML = `<div class="empty">No area selected for today.<br>Pick your area(s) in Settings.</div>
      <button class="btn big" id="goSettings">Choose area</button>`;
    $('#goSettings').onclick = () => setTab('settings');
    return;
  }
  if (!activeAreas().some(a => a.houses.length)) {
    body.innerHTML = `<div class="empty">No houses in <b>${esc(activeAreas().map(a => a.name).join(' + '))}</b> yet.<br>
      Stand at a house and tap <b>+</b> to add it at your location,<br>or add houses in Settings.</div>
      <button class="btn big" id="demoBtn">Try with demo houses</button>`;
    $('#demoBtn').onclick = loadDemo;
    return;
  }

  // Start page
  if (!p.started) {
    const t = paperTotals(r);
    const midway = p.done.length > 0 && !!c;
    const hold = activeAreas().reduce((s, a) => s + a.houses.length, 0) - r.length;
    body.innerHTML = `<div style="font-size:20px;font-weight:800;margin:4px 0">${esc(activeAreas().map(a => a.name).join(' + '))}</div>
      <div class="muted">${r.length} houses today${hold ? ` · ${hold} on hold` : ''}</div>
      <div class="badges">${PAPERS.map(pp => `<span class="b ${pp.cls}">${pp.label} ×${t[pp.key]}</span>`).join('')}</div>
      ${midway ? `<div class="muted" style="margin-top:8px">Paused: ${p.done.length} done, ${todoCount()} left</div>` : ''}
      <div class="actions"><button class="btn primary" id="startBtn">▶ ${midway ? 'Continue' : 'Start'} delivery</button></div>
      ${midway ? `<div class="actions"><button class="btn small" id="restartBtn" style="flex:1">Start over from house 1</button></div>` : ''}`;
    $('#startBtn').onclick = startDelivery;
    if ($('#restartBtn')) $('#restartBtn').onclick = () => { if (confirm('Clear today\'s progress and start from the first house?')) { db.progress = newProgress(); save(); startDelivery(); } };
    return;
  }

  // Finished
  if (!c) {
    const sk = r.filter(h => statusOf(h) === 'skipped');
    body.innerHTML = `<div class="empty" style="font-size:20px">🎉 All done!</div>
      ${sk.length ? `<div class="nexthead">Skipped — tap to deliver now</div>
        ${sk.map(h => `<div class="hl" data-unskip="${h.id}">${numHTML(h)}<div class="t"><div><b>${esc(h.kanji)}</b> <span class="muted">${esc(h.kana)}</span>${areaTag(h)}</div></div><span>›</span></div>`).join('')}` : ''}
      <div class="actions"><button class="btn" id="undoBtn">↶ Undo</button><button class="btn primary" id="finishBtn">Finish</button></div>`;
    body.querySelectorAll('[data-unskip]').forEach(el => el.onclick = () => {
      p.skipped = p.skipped.filter(x => x !== el.dataset.unskip); save(); render(); focusHouse(current());
    });
    $('#undoBtn').onclick = undo;
    $('#finishBtn').onclick = finishDelivery;
    return;
  }

  // Delivering
  const left = todoCount() - 1;
  const next = upcoming(LIST_COUNT);
  $('#dirHint').textContent = left > 0 ? `︿ swipe up · ${left} next` : 'last house';
  body.innerHTML = `
    <div class="cur">${numHTML(c)}
      <div style="flex:1;min-width:0"><div class="name">${esc(c.kanji || '(no name)')}${areaTag(c)}</div><div class="kana">${esc(c.kana)}</div></div>
      <div class="dist" data-dist="${c.id}">${fmtDist(distTo(c))}</div>
    </div>
    ${badgesHTML(c)}${noteHTML(c)}
    <div class="actions">
      <button class="btn" id="undoBtn" ${p.history.length ? '' : 'disabled style="opacity:.4"'}>↶</button>
      <button class="btn" id="skipBtn">Skip</button>
      <button class="btn" id="moreBtn">⋯</button>
      <button class="btn primary" id="doneBtn">✓ Done</button>
    </div>
    <div class="nextwrap">
      <div class="nexthead">Next · ${left} left<span class="sp"></span><span style="text-transform:none;letter-spacing:0">swipe ← →</span></div>
      ${next.length ? `<div class="nstrip" id="nstrip">${next.map(h => `
        <div class="ncard ${h.id === selectedId ? 'sel' : ''}" data-id="${h.id}">
          <div class="top">${numHTML(h)}<div style="flex:1;min-width:0"><div class="nm">${esc(h.kanji || '(no name)')}${areaTag(h)}</div><div class="kn">${esc(h.kana)}</div></div>
          <div class="dist" data-dist="${h.id}">${fmtDist(distTo(h))}</div></div>
          ${badgesHTML(h)}${noteHTML(h)}
          <div class="row" style="margin-top:8px"><button class="btn small" data-done="${h.id}">✓ Done</button><button class="btn small" data-edit="${h.id}">Edit</button><span class="hint">Tap card = show on map</span></div>
        </div>`).join('')}</div>` : '<div class="muted" style="padding:6px 0 10px">This is the last house.</div>'}
    </div>`;
  body.querySelectorAll('.ncard').forEach(el => el.onclick = e => {
    if (e.target.closest('button')) return;
    const id = el.dataset.id, wasSel = selectedId === id;
    body.querySelectorAll('.ncard').forEach(x => x.classList.remove('sel'));
    selectedId = wasSel ? null : id;
    if (!wasSel) el.classList.add('sel');
    renderMarkers();
    focusHouse(wasSel ? current() : findHouse(id), wasSel);
  });
  body.querySelectorAll('[data-done]').forEach(b => b.onclick = () => markDone(b.dataset.done));
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
  $('#doneBtn').onclick = () => markDone(c.id);
  $('#skipBtn').onclick = () => {
    p.skipped.push(c.id); p.history.push({ t: 'skip', id: c.id }); save();
    selectedId = null; render(); focusHouse(current());
  };
  $('#undoBtn').onclick = undo;
  $('#moreBtn').onclick = () => openMenu(c);
}
function openMenu(c) {
  $('#infoBox').innerHTML = `
    <h3 style="margin-bottom:12px">#${houseNo(c)} ${esc(c.kanji)}</h3>
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn" id="mNav">🧭 Open in Apple Maps</button>
      <button class="btn" id="mEdit">✏️ Edit this house</button>
      <button class="btn" id="mPause">⏸ Pause delivery</button>
      <button class="btn" id="mClose">Close</button>
    </div>`;
  $('#mNav').onclick = () => { if (hasLoc(c)) location.href = `https://maps.apple.com/?daddr=${c.lat},${c.lng}&dirflg=w`; };
  $('#mEdit').onclick = () => { closeModal('info'); openEditor(c.id); };
  $('#mPause').onclick = () => { const p = prog(); p.started = false; expanded = false; save(); releaseWake(); closeModal('info'); render(); };
  $('#mClose').onclick = () => closeModal('info');
  $('#info').classList.add('show');
}
function updateDistances() {
  document.querySelectorAll('[data-dist]').forEach(el => {
    const h = findHouse(el.dataset.dist); if (h) el.textContent = fmtDist(distTo(h));
  });
}

/* Swipe up / down on the direction panel */
(function sheetGestures() {
  const sheet = $('#dirSheet'), body = $('#dirBody');
  let g = null;
  sheet.addEventListener('touchstart', e => {
    const t = e.touches[0], card = e.target.closest('.ncard');
    g = {
      x: t.clientX, y: t.clientY, top: body.scrollTop,
      atBottom: body.scrollTop + body.clientHeight >= body.scrollHeight - 4,
      cardScrolls: !!card && card.scrollHeight > card.clientHeight + 2, // long note inside a card
    };
  }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (!g) return;
    const t = e.changedTouches[0], dx = t.clientX - g.x, dy = t.clientY - g.y, s = g; g = null;
    if (Math.abs(dy) < 40 || Math.abs(dy) < Math.abs(dx) * 1.3) return; // taps & sideways swipes
    if (s.cardScrolls || !prog().started || !current()) return;
    if (dy < 0 && !expanded && s.atBottom) setExpanded(true);
    else if (dy > 0 && expanded && s.top <= 0) setExpanded(false);
  }, { passive: true });
  $('#dirHandle').onclick = () => { if (prog().started && current()) setExpanded(!expanded); };
})();

function startDelivery() {
  let p = prog();
  if (!current()) { db.progress = p = newProgress(); } // previous round finished → fresh start
  p.started = true; save();
  startGPS(); keepAwake(); expanded = false; selectedId = null;
  render(); focusHouse(current());
}
function finishDelivery() {
  db.progress = newProgress(); save(); // back to the Start page
  releaseWake(); expanded = false; selectedId = null;
  render(); fitAll(); toast('Delivery finished 👍');
}
function markDone(id) {
  const p = prog();
  if (!p.done.includes(id)) p.done.push(id);
  p.skipped = p.skipped.filter(x => x !== id);
  p.history.push({ t: 'done', id });
  save(); selectedId = null;
  closeModal('info'); render(); focusHouse(current());
}
function undo() {
  const p = prog(), last = p.history.pop(); if (!last) return;
  p.done = p.done.filter(x => x !== last.id); p.skipped = p.skipped.filter(x => x !== last.id);
  save(); render(); focusHouse(current()); toast('Undone');
}

/* ---------- Overview ---------- */
function renderOverview() {
  const r = route();
  const done = r.filter(h => statusOf(h) === 'done').length;
  const skipped = r.filter(h => statusOf(h) === 'skipped').length;
  const hold = activeAreas().reduce((s, a) => s + a.houses.length, 0) - r.length;
  const t = paperTotals(r), left = paperTotals(r.filter(h => statusOf(h) === 'todo'));
  const pct = r.length ? Math.round(done / r.length * 100) : 0;
  $('#ovBody').innerHTML = !activeAreas().length ? `<div class="empty">No area selected. Pick areas in Settings.</div>` : `
    <div style="font-weight:800;font-size:18px">${esc(activeAreas().map(a => a.name).join(' + '))}</div>
    <div class="prog"><i style="width:${pct}%"></i></div>
    <div class="grid4">
      <div><b>${done}</b><span>Done</span></div>
      <div><b>${r.length - done - skipped}</b><span>Left</span></div>
      <div><b>${skipped}</b><span>Skipped</span></div>
      <div><b>${hold}</b><span>On hold</span></div>
    </div>
    ${multi() ? `<div style="margin-top:8px">${activeAreas().map(a => {
      const ar = a.houses.filter(h => !isStopped(h)); const d = ar.filter(h => statusOf(h) === 'done').length;
      return `<div class="muted">${esc(a.name)}: ${d} / ${ar.length}</div>`; }).join('')}</div>` : ''}
    <div class="nexthead">Papers today (left / total)</div>
    <div class="badges">${PAPERS.map(pp => `<span class="b ${pp.cls}">${pp.label} ${left[pp.key]} / ${t[pp.key]}</span>`).join('')}</div>
    <div class="muted" style="margin-top:10px">Tap a pin for its notes. Grey ✓ = done, dashed orange = skipped, dashed grey = on hold.</div>`;
}

/* ---------- House info (tap a pin) ---------- */
function openInfo(id) {
  const h = findHouse(id); if (!h) return;
  const st = statusOf(h);
  $('#infoBox').innerHTML = `
    <div class="cur">${numHTML(h)}<div style="flex:1"><div class="name">${esc(h.kanji || '(no name)')}${areaTag(h)}</div><div class="kana">${esc(h.kana)}</div></div>
    <div class="dist">${fmtDist(distTo(h))}<br>${st === 'stopped' ? 'On hold' : st === 'todo' ? '' : st}</div></div>
    ${badgesHTML(h)}${noteHTML(h)}
    <div class="actions">
      <button class="btn" id="iClose">Close</button>
      <button class="btn" id="iEdit">Edit</button>
      ${st === 'stopped' ? '' : st === 'done' ? `<button class="btn primary" id="iUndone">Mark not done</button>` : `<button class="btn primary" id="iDone">✓ Done</button>`}
    </div>`;
  $('#iClose').onclick = () => closeModal('info');
  $('#iEdit').onclick = () => { closeModal('info'); openEditor(id); };
  if ($('#iDone')) $('#iDone').onclick = () => markDone(id);
  if ($('#iUndone')) $('#iUndone').onclick = () => { const p = prog(); p.done = p.done.filter(x => x !== id); save(); closeModal('info'); render(); };
  $('#info').classList.add('show');
}
function closeModal(name) { $('#' + name).classList.remove('show'); }
$('#info').addEventListener('click', e => { if (e.target.id === 'info') closeModal('info'); });

/* ---------- House editor ---------- */
let ed = null; // working copy
function defaultAddArea() {
  const ea = editArea();
  return db.activeAreaIds.includes(ea.id) ? ea : (activeAreas()[0] || ea);
}
function openEditor(id, opts = {}) {
  const w = id ? where(id) : null;
  if (w) {
    ed = JSON.parse(JSON.stringify(w.h)); ed._isNew = false; ed._areaId = w.a.id; ed._pos = w.i + 1;
  } else {
    const a = opts.areaId ? db.areas.find(x => x.id === opts.areaId) : defaultAddArea();
    ed = {
      id: uid(), kanji: '', kana: '', papers: { kahoku: 1, mainichi: 0, seikyo: 0 },
      place: '', wrap: false, noFlyer: false, deadline: '', rooms: '', note: '', stopFrom: '', stopTo: '',
      lat: opts.lat ?? null, lng: opts.lng ?? null,
      _isNew: true, _areaId: a.id, _pos: opts.pos ?? a.houses.length + 1,
    };
  }
  renderEditor();
  $('#editor').classList.add('show');
}
function editorMaxPos() {
  const a = db.areas.find(x => x.id === ed._areaId);
  return a.houses.filter(h => h.id !== ed.id).length + 1;
}
function renderEditor() {
  const max = editorMaxPos();
  $('#editorBox').innerHTML = `
    <h3>${ed._isNew ? 'Add house' : 'Edit house'}</h3>
    <label class="f">Area</label>
    <select id="eArea">${db.areas.map(a => `<option value="${a.id}" ${a.id === ed._areaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
    <label class="f">Name (kanji)</label><input type="text" id="eKanji" value="${esc(ed.kanji)}" placeholder="佐藤">
    <label class="f">Reading (hiragana)</label><input type="text" id="eKana" value="${esc(ed.kana)}" placeholder="さとう">
    <label class="f">Newspapers</label>
    ${PAPERS.map(p => `<div class="stepper"><div class="lab"><span class="dot" style="background:${p.color}"></span>${p.label} <span class="muted">${p.jp}</span></div>
      <button data-minus="${p.key}">−</button><span class="q" id="q_${p.key}">${+(ed.papers?.[p.key] || 0)}</span><button data-plus="${p.key}">+</button></div>`).join('')}
    <label class="f">Where to put it</label><input type="text" id="ePlace" value="${esc(ed.place)}" placeholder="e.g. 玄関ポスト">
    <div class="chips">${PLACE_CHIPS.map(c => `<button data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <label class="chk"><input type="checkbox" id="eWrap" ${ed.wrap ? 'checked' : ''}> Always wrap (ラッピング)</label>
    <label class="chk"><input type="checkbox" id="eNoFlyer" ${ed.noFlyer ? 'checked' : ''}> No flyers (チラシ無し)</label>
    <label class="f">Deliver before (optional)</label><input type="time" id="eDeadline" value="${esc(ed.deadline)}">
    <label class="f">Apartment rooms (optional)</label><input type="text" id="eRooms" value="${esc(ed.rooms)}" placeholder="101, 201">
    <label class="f">Notes</label><textarea id="eNote" placeholder="Anything to remember…">${esc(ed.note)}</textarea>
    <label class="f">On hold / stopped (休止) — from / to</label>
    <div class="row"><input type="date" id="eStopFrom" value="${esc(ed.stopFrom)}" style="flex:1"><input type="date" id="eStopTo" value="${esc(ed.stopTo)}" style="flex:1"></div>
    <div class="muted" style="margin-top:4px">Leave "to" empty to stop until you clear it.</div>
    <label class="f">Location</label>
    <div class="muted" id="eLoc">${hasLoc(ed) ? `Set (${ed.lat.toFixed(5)}, ${ed.lng.toFixed(5)})` : 'Not set'}</div>
    <div class="row" style="margin-top:6px"><button class="btn small" id="eGps">📍 Use my location</button><button class="btn small" id="ePick">🎯 Pick on map</button></div>
    <label class="f">Position in route (1 – ${max})</label>
    <input type="number" id="ePos" value="${Math.min(ed._pos, max)}" min="1" max="${max}" inputmode="numeric">
    <div class="actions">
      ${ed._isNew ? '' : '<button class="btn danger" id="eDel">Delete</button>'}
      <button class="btn" id="eCancel">Cancel</button>
      <button class="btn primary" id="eSave">Save</button>
    </div>`;
  const box = $('#editorBox');
  box.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => stepPaper(b.dataset.plus, 1));
  box.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => stepPaper(b.dataset.minus, -1));
  box.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { $('#ePlace').value = b.dataset.chip; });
  $('#eArea').onchange = e => { readEditor(); ed._areaId = e.target.value; ed._pos = editorMaxPos(); renderEditor(); };
  $('#eGps').onclick = async () => {
    $('#eLoc').textContent = 'Getting GPS…';
    try {
      const p = await getOnce(); ed.lat = p.coords.latitude; ed.lng = p.coords.longitude;
      $('#eLoc').textContent = `Set from GPS (±${Math.round(p.coords.accuracy)} m). Use "Pick on map" to fine-tune.`;
    } catch (e) { $('#eLoc').textContent = 'Could not get GPS. Use "Pick on map".'; }
  };
  $('#ePick').onclick = () => { readEditor(); startPick(); };
  $('#eCancel').onclick = () => { ed = null; closeModal('editor'); render(); };
  $('#eSave').onclick = saveEditor;
  if ($('#eDel')) $('#eDel').onclick = () => {
    if (!confirm(`Delete ${ed.kanji || 'this house'}?`)) return;
    db.areas.forEach(a => (a.houses = a.houses.filter(x => x.id !== ed.id)));
    save(); ed = null; closeModal('editor'); render(); toast('Deleted');
  };
}
function stepPaper(k, d) {
  ed.papers[k] = Math.max(0, Math.min(20, +(ed.papers[k] || 0) + d));
  $('#q_' + k).textContent = ed.papers[k];
}
function readEditor() {
  ed.kanji = $('#eKanji').value.trim(); ed.kana = $('#eKana').value.trim();
  ed.place = $('#ePlace').value.trim(); ed.wrap = $('#eWrap').checked; ed.noFlyer = $('#eNoFlyer').checked;
  ed.deadline = $('#eDeadline').value; ed.rooms = $('#eRooms').value.trim(); ed.note = $('#eNote').value;
  ed.stopFrom = $('#eStopFrom').value; ed.stopTo = $('#eStopTo').value;
  ed._pos = parseInt($('#ePos').value, 10) || ed._pos;
}
function saveEditor() {
  readEditor();
  if (!ed.kanji && !ed.kana) { toast('Please enter a name'); return; }
  const { _isNew, _pos, _areaId, ...house } = ed;
  db.areas.forEach(a => (a.houses = a.houses.filter(x => x.id !== house.id)));
  const a = db.areas.find(x => x.id === _areaId);
  const idx = Math.max(0, Math.min(a.houses.length, _pos - 1));
  a.houses.splice(idx, 0, house);
  save(); ed = null; closeModal('editor'); render();
  toast(_isNew ? `Added #${idx + 1} ${house.kanji}` : 'Saved');
}

/* ---------- Pick on map ---------- */
function startPick() {
  closeModal('editor');
  document.body.classList.add('picking');
  renderMarkers();
  if (hasLoc(ed)) map.setView([ed.lat, ed.lng], Math.max(map.getZoom(), 18));
  else if (myPos) map.setView(myPos, 18);
}
function endPick() { document.body.classList.remove('picking'); renderEditor(); $('#editor').classList.add('show'); }
$('#pickSet').onclick = () => { const c = map.getCenter(); ed.lat = c.lat; ed.lng = c.lng; endPick(); };
$('#pickCancel').onclick = endPick;

/* ---------- Settings ---------- */
function renderSettings() {
  const ea = editArea();
  $('#settingsPage').innerHTML = `
    <h2>Settings</h2>
    <div class="sec"><h3>Areas</h3>
      <div class="muted" style="margin-bottom:6px">Tick the area(s) you deliver today. Ticked areas are delivered top to bottom. Tap a name to edit its houses.</div>
      ${db.areas.map((a, i) => `
        <div class="arow ${a.id === ea.id ? 'editing' : ''}">
          <input type="checkbox" data-active="${a.id}" ${db.activeAreaIds.includes(a.id) ? 'checked' : ''}>
          <div class="t" data-editarea="${a.id}"><b>${esc(a.name)}</b><div class="muted">${a.houses.length} houses${a.id === ea.id ? ' · editing below' : ' · tap to edit'}</div></div>
          <div class="ar"><button data-aup="${i}">↑</button><button data-adown="${i}">↓</button></div>
        </div>`).join('')}
      <div class="row" style="margin-top:8px"><button class="btn small" id="sNewArea">+ New area</button></div>
    </div>
    <div class="sec"><h3>Houses in ${esc(ea.name)}</h3>
      <div class="row" style="margin-bottom:6px">
        <button class="btn small" id="sAdd">+ Add house</button>
        <button class="btn small" id="sRename">Rename area</button>
        <button class="btn small danger" id="sDelArea">Delete area</button>
      </div>
      <div class="muted" style="margin-bottom:4px">Tap a house to edit. ↑↓ to reorder.</div>
      ${ea.houses.length ? ea.houses.map((h, i) => `
        <div class="hl" data-edit="${h.id}">${numHTML(h)}
          <div class="t"><div><b>${esc(h.kanji || '(no name)')}</b> <span class="muted">${esc(h.kana)}</span></div>
          <div class="muted">${[PAPERS.filter(p => +(h.papers?.[p.key] || 0)).map(p => p.label + '×' + h.papers[p.key]).join(' '), isStopped(h) ? '⏸ on hold' : '', hasLoc(h) ? '' : '⚠ no location', h.note ? '📝' : ''].filter(Boolean).join(' · ')}</div></div>
          <div class="ar"><button data-up="${i}">↑</button><button data-down="${i}">↓</button></div>
        </div>`).join('') : '<div class="muted">No houses yet.</div>'}
    </div>
    <div class="sec"><h3>Today</h3>
      <div class="row"><button class="btn small" id="sReset">Reset today's progress</button></div>
      <label class="chk"><input type="checkbox" id="sWake" ${db.settings.wake ? 'checked' : ''}> Keep screen on while delivering</label>
      <label class="chk"><input type="checkbox" id="sDark" ${db.settings.darkMap ? 'checked' : ''}> Dark map (easier at night)</label>
    </div>
    <div class="sec"><h3>Backup</h3>
      <div class="muted" style="margin-bottom:8px">Your data is stored only on this phone. Export a backup after big changes (save it to Files or iCloud Drive).</div>
      <div class="row"><button class="btn small" id="sExport">⬆ Export backup</button><button class="btn small" id="sImport">⬇ Import backup</button></div>
    </div>
    <div class="sec"><h3>Help</h3><div class="muted" style="line-height:1.5">
      <b>Add houses:</b> stand at the door, tap <b>+</b> on the Direction map. Add them in delivery order.<br>
      <b>Deliver:</b> Direction → Start → Done at each house. Swipe the panel up to see the next houses, swipe the cards sideways, tap a card to show it on the map. ⋯ has Open in Maps, Edit and Pause.<br>
      <b>On hold:</b> set stop dates in a house to hide it from the route (休止).</div></div>
    <div class="muted" style="text-align:center">Newspaper Delivery v3</div>`;
  const pg = $('#settingsPage');
  pg.querySelectorAll('[data-active]').forEach(cb => cb.onchange = () => {
    const id = cb.dataset.active;
    db.activeAreaIds = cb.checked ? [...db.activeAreaIds, id] : db.activeAreaIds.filter(x => x !== id);
    save(); renderSettings(); renderTop();
  });
  pg.querySelectorAll('[data-editarea]').forEach(el => el.onclick = () => { db.editAreaId = el.dataset.editarea; save(); renderSettings(); });
  pg.querySelectorAll('[data-aup],[data-adown]').forEach(b => b.onclick = () => {
    const i = +(b.dataset.aup ?? b.dataset.adown), j = b.dataset.aup != null ? i - 1 : i + 1;
    if (j < 0 || j >= db.areas.length) return;
    [db.areas[i], db.areas[j]] = [db.areas[j], db.areas[i]]; save(); renderSettings();
  });
  $('#sNewArea').onclick = () => {
    const n = prompt('New area name', ''); if (!n || !n.trim()) return;
    const na = { id: uid(), name: n.trim(), houses: [] };
    db.areas.push(na); db.editAreaId = na.id;
    if (confirm(`Deliver "${na.name}" today?`)) db.activeAreaIds.push(na.id);
    save(); renderSettings();
  };
  $('#sRename').onclick = () => { const n = prompt('Area name', ea.name); if (n && n.trim()) { ea.name = n.trim(); save(); renderSettings(); } };
  $('#sDelArea').onclick = () => {
    if (!confirm(`Delete area "${ea.name}" and its ${ea.houses.length} houses?`)) return;
    db.areas = db.areas.filter(x => x.id !== ea.id);
    db.activeAreaIds = db.activeAreaIds.filter(x => x !== ea.id);
    db = normalize(db); save(); renderSettings();
  };
  $('#sAdd').onclick = () => openEditor(null, { areaId: ea.id, lat: myPos?.[0], lng: myPos?.[1] });
  pg.querySelectorAll('.hl[data-edit]').forEach(el => el.onclick = e => { if (!e.target.closest('button')) openEditor(el.dataset.edit); });
  pg.querySelectorAll('[data-up],[data-down]').forEach(b => b.onclick = () => {
    const i = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up != null ? i - 1 : i + 1;
    if (j < 0 || j >= ea.houses.length) return;
    [ea.houses[i], ea.houses[j]] = [ea.houses[j], ea.houses[i]]; save(); renderSettings();
  });
  $('#sReset').onclick = () => { if (confirm("Reset today's done/skipped marks?")) { db.progress = newProgress(); save(); toast('Reset'); } };
  $('#sWake').onchange = e => { db.settings.wake = e.target.checked; save(); };
  $('#sDark').onchange = e => { db.settings.darkMap = e.target.checked; save(); applyMapStyle(); };
  $('#sExport').onclick = exportData;
  $('#sImport').onclick = () => $('#importFile').click();
}
async function exportData() {
  const data = JSON.stringify({ app: 'newspaper-delivery', version: 2, exported: new Date().toISOString(), areas: db.areas, activeAreaIds: db.activeAreaIds, settings: db.settings }, null, 2);
  const name = `newspaper-delivery-backup-${today()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file), aEl = document.createElement('a');
  aEl.href = url; aEl.download = name; document.body.appendChild(aEl); aEl.click(); aEl.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.areas)) throw new Error('bad file');
    const n = d.areas.reduce((s, a) => s + (a.houses?.length || 0), 0);
    if (!confirm(`Replace current data with backup (${d.areas.length} areas, ${n} houses)?`)) return;
    db.areas = d.areas;
    db.activeAreaIds = Array.isArray(d.activeAreaIds) ? d.activeAreaIds : d.areas.slice(0, 1).map(a => a.id);
    if (d.settings) Object.assign(db.settings, d.settings);
    db.progress = null; db = normalize(db); save(); applyMapStyle(); render(); toast('Backup restored');
  } catch (err) { toast('That file is not a valid backup', 3000); }
};

/* ---------- Demo data ---------- */
function loadDemo() {
  const c = myPos || [map.getCenter().lat, map.getCenter().lng];
  const names = [['佐藤', 'さとう'], ['鈴木', 'すずき'], ['高橋', 'たかはし'], ['永井', 'ながい'], ['田中', 'たなか'], ['伊藤', 'いとう'], ['ソレイユ青葉', 'それいゆあおば'], ['中村', 'なかむら'], ['小林', 'こばやし'], ['加藤', 'かとう']];
  const a = { id: uid(), name: 'Demo', houses: [] };
  names.forEach(([k, r], i) => {
    const row = Math.floor(i / 5), col = i % 5;
    a.houses.push({
      id: uid(), kanji: k, kana: r,
      papers: { kahoku: i === 3 ? 0 : 1, mainichi: i === 3 ? 1 : 0, seikyo: i === 1 || i === 8 ? 1 : 0 },
      place: i === 2 ? 'Front-door post (玄関ポスト)' : i === 4 ? 'Push all the way in (落としこむ)' : '',
      wrap: i === 2, noFlyer: i === 7, deadline: i === 5 ? '05:30' : '', rooms: i === 6 ? '101, 201' : '',
      note: i === 0 ? 'Mailbox is on the left of the gate.' : i === 6 ? 'Apartment: two papers, rooms 101 and 201.' : '',
      stopFrom: '', stopTo: '',
      lat: c[0] + (row === 0 ? 0.00035 : -0.00035), lng: c[1] - 0.001 + col * 0.0005 * (row === 0 ? 1 : -1) + (row ? 0.002 : 0),
    });
  });
  db.areas.push(a); db.activeAreaIds = [a.id]; db.editAreaId = a.id; save(); render(); fitAll();
  toast('Demo area added — delete it later in Settings');
}

/* ---------- tabs & render ---------- */
function setTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#dirSheet').style.display = t === 'direction' ? '' : 'none';
  $('#ovSheet').style.display = t === 'overview' ? '' : 'none';
  $('#settingsPage').style.display = t === 'settings' ? '' : 'none';
  $('#fabs').style.display = t === 'settings' ? 'none' : '';
  $('#fabAdd').style.display = t === 'direction' ? '' : 'none';
  selectedId = null;
  render();
  if (t === 'overview') fitAll();
  if (t === 'direction' && prog().started) focusHouse(current());
}
function render() {
  if (tab === 'direction') renderDirection();
  if (tab === 'overview') renderOverview();
  if (tab === 'settings') renderSettings();
  renderMarkers(); renderTop();
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#ovHandle').onclick = () => $('#ovSheet').classList.toggle('mini');
$('#fabLocate').onclick = () => { startGPS(); if (myPos) map.setView(myPos, Math.max(map.getZoom(), 18)); else toast('Finding you…'); };
$('#fabFit').onclick = fitAll;
$('#fabFollow').onclick = () => {
  follow = !follow; $('#fabFollow').classList.toggle('on', follow); startGPS();
  toast(follow ? 'Following your position' : 'Follow off'); if (follow && myPos) map.panTo(myPos);
};
$('#fabAdd').onclick = async () => {
  startGPS();
  // While delivering, insert right after the current house; otherwise at the end of the area.
  const c = current(), p = prog();
  const opts = {};
  if (p.started && c) { const w = where(c.id); opts.areaId = w.a.id; opts.pos = w.i + 2; }
  try { const g = await getOnce(); opts.lat = g.coords.latitude; opts.lng = g.coords.longitude; }
  catch (e) { opts.lat = myPos?.[0]; opts.lng = myPos?.[1]; }
  openEditor(null, opts);
};

/* ---------- boot ---------- */
fitApp(); setTimeout(fitApp, 300); setTimeout(fitApp, 1200);
applyMapStyle();
setTab('direction');
fitAll();
if (prog().started) { startGPS(); keepAwake(); }
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
