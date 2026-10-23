/* Paper Route — newspaper delivery helper (PWA). All data stays on this phone (localStorage). */
'use strict';

const PAPERS = [
  { key: 'kahoku',   short: 'K', label: 'Kahoku',   jp: 'かほく',   cls: 'k', color: '#22c55e' },
  { key: 'mainichi', short: 'M', label: 'Mainichi', jp: '毎日',     cls: 'm', color: '#3b82f6' },
  { key: 'seikyo',   short: 'S', label: 'Seikyo',   jp: 'せいきょう', cls: 's', color: '#a855f7' },
];
const PLACE_CHIPS = ['Mailbox', 'Front-door post (玄関ポスト)', 'Push all the way in (落としこむ)', 'Door gap', 'Hand to person'];
const LS_KEY = 'paperRoute.v1';
const DEFAULT_CENTER = [38.268, 140.87]; // Sendai
const NEXT_COUNT = 12;

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
  d.areas ??= []; d.progress ??= {}; d.settings ??= {};
  d.settings.darkMap ??= true; d.settings.wake ??= true;
  if (!d.areas.length) { const a = { id: uid(), name: 'My area', houses: [] }; d.areas.push(a); d.currentAreaId = a.id; }
  if (!d.areas.find(a => a.id === d.currentAreaId)) d.currentAreaId = d.areas[0].id;
  return d;
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { toast('⚠️ Could not save!'); }
}
const area = () => db.areas.find(a => a.id === db.currentAreaId);
const houseNo = h => area().houses.indexOf(h) + 1;
const isStopped = (h, d = today()) => !!h.stopFrom && d >= h.stopFrom && (!h.stopTo || d <= h.stopTo);
const hasLoc = h => typeof h.lat === 'number' && typeof h.lng === 'number';
function prog() {
  const a = area(); let p = db.progress[a.id];
  if (!p || p.date !== today()) { p = db.progress[a.id] = { date: today(), started: false, done: [], skipped: [], history: [] }; save(); }
  return p;
}
const route = () => area().houses.filter(h => !isStopped(h));
function statusOf(h) {
  const p = prog();
  if (isStopped(h)) return 'stopped';
  if (p.done.includes(h.id)) return 'done';
  if (p.skipped.includes(h.id)) return 'skipped';
  return 'todo';
}
function current() { return route().find(h => statusOf(h) === 'todo') || null; }
function upcoming() {
  const r = route(), c = current(); if (!c) return [];
  return r.slice(r.indexOf(c) + 1).filter(h => statusOf(h) === 'todo').slice(0, NEXT_COUNT);
}
function paperTotals(list) {
  const t = {}; PAPERS.forEach(p => (t[p.key] = 0));
  list.forEach(h => PAPERS.forEach(p => (t[p.key] += +(h.papers?.[p.key] || 0))));
  return t;
}
function pinBg(h) {
  const cols = PAPERS.filter(p => +(h.papers?.[p.key] || 0) > 0).map(p => p.color);
  if (!cols.length) return '#64748b';
  if (cols.length === 1) return cols[0];
  const step = 360 / cols.length;
  return `conic-gradient(${cols.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(',')})`;
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, maxZoom: 20, tap: false }).setView(DEFAULT_CENTER, 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap',
}).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let lineToTarget = null, meMarker = null, meAcc = null;
let myPos = null, watchId = null, follow = false;
let tab = 'direction', selectedId = null, sheetMini = false;

function applyMapStyle() { document.body.classList.toggle('dark-tiles', !!db.settings.darkMap); }
map.on('zoomend', () => $('#map').classList.toggle('show-labels', map.getZoom() >= 18));

function renderMarkers() {
  markerLayer.clearLayers();
  const a = area(), cur = current();
  a.houses.forEach((h, i) => {
    if (!hasLoc(h)) return;
    const st = statusOf(h);
    const isCur = cur && h.id === cur.id;
    let size = st === 'done' ? 20 : isCur ? 40 : 28;
    const cls = ['pin', st, isCur ? 'current' : '', h.id === selectedId ? 'sel' : ''].join(' ');
    const icon = L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="${cls}" style="background:${pinBg(h)}">${st === 'done' ? '✓' : i + 1}</div>`,
    });
    const m = L.marker([h.lat, h.lng], { icon, zIndexOffset: isCur ? 1000 : h.id === selectedId ? 900 : st === 'done' ? -100 : 0 });
    m.bindTooltip(esc(h.kanji || h.kana || `#${i + 1}`), { permanent: true, direction: 'top', offset: [0, -size / 2], className: 'lbl' });
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
  map.stop(); // cancel any running animation so the new focus wins
  const b = L.latLngBounds(points);
  map.fitBounds(b, {
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
  const pts = area().houses.filter(hasLoc).map(h => [h.lat, h.lng]);
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
    drawLine(); renderTop();
    if (tab === 'direction') updateDistances();
  }, err => {
    if (err.code === 1) toast('Location permission denied. Allow it in iPhone Settings → Privacy → Location.', 4000);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}
function getOnce() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No GPS'));
    navigator.geolocation.getCurrentPosition(p => res(p), rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function keepAwake() {
  if (!db.settings.wake || !('wakeLock' in navigator) || !prog().started) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); render(); } });

/* ---------- top bar ---------- */
function renderTop() {
  const t = $('#topInfo'), p = prog(), r = route();
  const done = r.filter(h => p.done.includes(h.id)).length;
  if (tab === 'settings') { t.innerHTML = 'Settings'; return; }
  let s = `<b>${esc(area().name)}</b> · ${done}/${r.length}`;
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
function distTo(h) { return myPos && hasLoc(h) ? haversine(myPos, [h.lat, h.lng]) : null; }

/* ---------- Direction ---------- */
function renderDirection() {
  const body = $('#dirBody'), p = prog(), r = route(), c = current();
  $('#dirSheet').classList.toggle('mini', sheetMini);
  if (!area().houses.length) {
    body.innerHTML = `<div class="empty">No houses in <b>${esc(area().name)}</b> yet.<br>
      Stand at a house and tap <b>+</b> to add it at your location,<br>or add houses in Settings.</div>
      <button class="btn big" id="demoBtn">Try with demo houses</button>`;
    $('#demoBtn').onclick = loadDemo;
    return;
  }
  if (!p.started) {
    const t = paperTotals(r);
    body.innerHTML = `<div style="font-size:20px;font-weight:800;margin:4px 0">${esc(area().name)}</div>
      <div class="muted">${r.length} houses today${area().houses.length - r.length ? ` · ${area().houses.length - r.length} on hold` : ''}</div>
      <div class="badges">${PAPERS.map(pp => `<span class="b ${pp.cls}">${pp.label} ×${t[pp.key]}</span>`).join('')}</div>
      ${p.done.length ? `<div class="muted" style="margin-top:8px">${p.done.length} already done today</div>` : ''}
      <div class="actions"><button class="btn primary" id="startBtn">▶ ${p.done.length ? 'Continue' : 'Start'} delivery</button></div>`;
    $('#startBtn').onclick = startDelivery;
    return;
  }
  if (!c) {
    const sk = r.filter(h => statusOf(h) === 'skipped');
    body.innerHTML = `<div class="empty" style="font-size:20px">🎉 All done!</div>
      ${sk.length ? `<div class="nexthead">Skipped — tap to deliver now</div>
        ${sk.map(h => `<div class="hl" data-unskip="${h.id}">${numHTML(h)}<div class="t"><div><b>${esc(h.kanji)}</b> <span class="muted">${esc(h.kana)}</span></div></div><span>›</span></div>`).join('')}` : ''}
      <div class="actions"><button class="btn" id="undoBtn">↶ Undo</button><button class="btn" id="finishBtn" style="flex:1">Finish</button></div>`;
    body.querySelectorAll('[data-unskip]').forEach(el => el.onclick = () => {
      const id = el.dataset.unskip; p.skipped = p.skipped.filter(x => x !== id); save(); render();
      focusHouse(current());
    });
    $('#undoBtn').onclick = undo;
    $('#finishBtn').onclick = () => { p.started = false; save(); releaseWake(); render(); fitAll(); };
    return;
  }
  const next = upcoming(), d = distTo(c);
  body.innerHTML = `
    <div class="cur">${numHTML(c)}
      <div style="flex:1;min-width:0"><div class="name">${esc(c.kanji || '(no name)')}</div><div class="kana">${esc(c.kana)}</div></div>
      <div class="dist" id="curDist">${fmtDist(d)}</div>
    </div>
    ${badgesHTML(c)}
    <div class="hide-mini">${noteHTML(c)}</div>
    <div class="actions">
      <button class="btn" id="undoBtn" ${p.history.length ? '' : 'disabled style="opacity:.4"'}>↶</button>
      <button class="btn" id="skipBtn">Skip</button>
      <button class="btn primary" id="doneBtn">✓ Done</button>
    </div>
    <div class="hide-mini">
      <div class="nexthead">Up next (${route().filter(h => statusOf(h) === 'todo').length - 1} left)<span class="sp"></span>
        <button class="btn small" id="notesToggle">${db.settings.showNotes ? 'Hide notes' : 'Show notes'}</button></div>
      ${next.length ? `<div class="strip ${db.settings.showNotes ? 'notes' : ''}" id="strip">${next.map(h => `
        <div class="card ${h.id === selectedId ? 'sel open' : ''}" data-id="${h.id}">
          <div class="top">${numHTML(h)}<div style="flex:1;min-width:0"><div class="nm">${esc(h.kanji || '(no name)')}</div><div class="kn">${esc(h.kana)}</div></div>
          <div class="dist" data-dist="${h.id}">${fmtDist(distTo(h))}</div></div>
          ${badgesHTML(h)}
          <div class="more">${noteHTML(h)}<div class="row" style="margin-top:8px"><button class="btn small" data-done="${h.id}">✓ Mark done</button><button class="btn small" data-edit="${h.id}">Edit</button></div></div>
          <div class="hint">${h.note ? 'Tap to see notes · ' : ''}tap to show on map</div>
        </div>`).join('')}</div>` : '<div class="muted">This is the last house.</div>'}
      <div class="row" style="margin-top:10px">
        <button class="btn small" id="navBtn">Open in Maps</button>
        <button class="btn small" id="editCurBtn">Edit this house</button>
        <span class="sp" style="flex:1"></span>
        <button class="btn small" id="pauseBtn">Pause</button>
      </div>
    </div>`;
  $('#doneBtn').onclick = () => markDone(c.id);
  $('#skipBtn').onclick = () => { p.skipped.push(c.id); p.history.push({ t: 'skip', id: c.id }); save(); selectedId = null; render(); focusHouse(current()); };
  $('#undoBtn').onclick = undo;
  $('#notesToggle').onclick = () => { db.settings.showNotes = !db.settings.showNotes; save(); renderDirection(); };
  $('#navBtn').onclick = () => { if (hasLoc(c)) location.href = `https://maps.apple.com/?daddr=${c.lat},${c.lng}&dirflg=w`; };
  $('#editCurBtn').onclick = () => openEditor(c.id);
  $('#pauseBtn').onclick = () => { p.started = false; save(); releaseWake(); render(); };
  body.querySelectorAll('.card').forEach(el => el.onclick = e => {
    if (e.target.closest('button')) return;
    const id = el.dataset.id, h = area().houses.find(x => x.id === id);
    const wasSel = selectedId === id;
    body.querySelectorAll('.card').forEach(x => x.classList.remove('sel', 'open'));
    selectedId = wasSel ? null : id;
    if (!wasSel) { el.classList.add('sel', 'open'); focusHouse(h, false); }
    renderMarkers();
  });
  body.querySelectorAll('[data-done]').forEach(b => b.onclick = () => markDone(b.dataset.done));
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
}
function updateDistances() {
  const c = current(); if (!c) return;
  const cd = $('#curDist'); if (cd) cd.textContent = fmtDist(distTo(c));
  document.querySelectorAll('[data-dist]').forEach(el => {
    const h = area().houses.find(x => x.id === el.dataset.dist); if (h) el.textContent = fmtDist(distTo(h));
  });
}
function startDelivery() {
  const p = prog(); p.started = true; save();
  startGPS(); keepAwake(); sheetMini = false; selectedId = null;
  render(); focusHouse(current());
}
function markDone(id) {
  const p = prog();
  if (!p.done.includes(id)) p.done.push(id);
  p.skipped = p.skipped.filter(x => x !== id);
  p.history.push({ t: 'done', id });
  save(); selectedId = null; closeModal('info');
  render(); focusHouse(current());
}
function undo() {
  const p = prog(), last = p.history.pop(); if (!last) return;
  p.done = p.done.filter(x => x !== last.id); p.skipped = p.skipped.filter(x => x !== last.id);
  save(); render(); focusHouse(current()); toast('Undone');
}
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }

/* ---------- Overview ---------- */
function renderOverview() {
  const p = prog(), r = route(), all = area().houses;
  const done = r.filter(h => statusOf(h) === 'done').length;
  const skipped = r.filter(h => statusOf(h) === 'skipped').length;
  const t = paperTotals(r), left = paperTotals(r.filter(h => statusOf(h) === 'todo'));
  const pct = r.length ? Math.round(done / r.length * 100) : 0;
  $('#ovBody').innerHTML = `
    <div class="row"><select id="ovArea">${db.areas.map(a => `<option value="${a.id}" ${a.id === db.currentAreaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="prog"><i style="width:${pct}%"></i></div>
    <div class="grid4">
      <div><b>${done}</b><span>Done</span></div>
      <div><b>${r.length - done - skipped}</b><span>Left</span></div>
      <div><b>${skipped}</b><span>Skipped</span></div>
      <div><b>${all.length - r.length}</b><span>On hold</span></div>
    </div>
    <div class="nexthead">Papers today (left / total)</div>
    <div class="badges">${PAPERS.map(pp => `<span class="b ${pp.cls}">${pp.label} ${left[pp.key]} / ${t[pp.key]}</span>`).join('')}</div>
    <div class="muted" style="margin-top:10px">Tap a pin for its notes. Grey ✓ = done, dashed orange = skipped, dashed grey = on hold.</div>
    ${all.some(h => !hasLoc(h)) ? `<div class="muted" style="color:var(--warn);margin-top:6px">${all.filter(h => !hasLoc(h)).length} house(s) have no location yet (Settings).</div>` : ''}`;
  $('#ovArea').onchange = e => { db.currentAreaId = e.target.value; save(); render(); fitAll(); };
}

/* ---------- House info (tap a pin) ---------- */
function openInfo(id) {
  const h = area().houses.find(x => x.id === id); if (!h) return;
  const st = statusOf(h);
  $('#infoBox').innerHTML = `
    <div class="cur">${numHTML(h)}<div style="flex:1"><div class="name">${esc(h.kanji || '(no name)')}</div><div class="kana">${esc(h.kana)}</div></div>
    <div class="dist">${fmtDist(distTo(h))}<br>${st === 'stopped' ? 'On hold' : st}</div></div>
    ${badgesHTML(h)}${noteHTML(h)}
    <div class="actions">
      <button class="btn" id="iClose">Close</button>
      <button class="btn" id="iEdit">Edit</button>
      ${st === 'stopped' ? '' : st === 'done' ? `<button class="btn primary" id="iUndone">Mark not done</button>` : `<button class="btn primary" id="iDone">✓ Done</button>`}
    </div>`;
  $('#iClose').onclick = () => closeModal('info');
  $('#iEdit').onclick = () => { closeModal('info'); openEditor(id); };
  if ($('#iDone')) $('#iDone').onclick = () => markDone(id);
  if ($('#iUndone')) $('#iUndone').onclick = () => {
    const p = prog(); p.done = p.done.filter(x => x !== id); save(); closeModal('info'); render();
  };
  $('#info').classList.add('show');
}
function closeModal(name) { $('#' + name).classList.remove('show'); }
$('#info').addEventListener('click', e => { if (e.target.id === 'info') closeModal('info'); });

/* ---------- House editor ---------- */
let ed = null; // working copy
function openEditor(id, opts = {}) {
  const a = area();
  const h = id ? a.houses.find(x => x.id === id) : null;
  ed = h ? JSON.parse(JSON.stringify(h)) : {
    id: uid(), kanji: '', kana: '', papers: { kahoku: 1, mainichi: 0, seikyo: 0 },
    place: '', wrap: false, noFlyer: false, deadline: '', rooms: '', note: '', stopFrom: '', stopTo: '',
    lat: opts.lat ?? null, lng: opts.lng ?? null,
  };
  ed._isNew = !h;
  ed._pos = h ? a.houses.indexOf(h) + 1 : (opts.pos ?? a.houses.length + 1);
  renderEditor();
  $('#editor').classList.add('show');
}
function renderEditor() {
  const a = area();
  $('#editorBox').innerHTML = `
    <h3>${ed._isNew ? 'Add house' : 'Edit house'}</h3>
    <div class="muted">${esc(a.name)}</div>
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
    <label class="f">Position in route (1 – ${a.houses.length + (ed._isNew ? 1 : 0)})</label>
    <input type="number" id="ePos" value="${ed._pos}" min="1" max="${a.houses.length + (ed._isNew ? 1 : 0)}" inputmode="numeric">
    <div class="actions">
      ${ed._isNew ? '' : '<button class="btn danger" id="eDel">Delete</button>'}
      <button class="btn" id="eCancel">Cancel</button>
      <button class="btn primary" id="eSave">Save</button>
    </div>`;
  const box = $('#editorBox');
  box.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => stepPaper(b.dataset.plus, 1));
  box.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => stepPaper(b.dataset.minus, -1));
  box.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { $('#ePlace').value = b.dataset.chip; });
  $('#eGps').onclick = async () => {
    $('#eLoc').textContent = 'Getting GPS…';
    try {
      const p = await getOnce(); ed.lat = p.coords.latitude; ed.lng = p.coords.longitude;
      $('#eLoc').textContent = `Set from GPS (±${Math.round(p.coords.accuracy)} m). Use "Pick on map" to fine-tune.`;
    } catch (e) { $('#eLoc').textContent = 'Could not get GPS. Use "Pick on map".'; }
  };
  $('#ePick').onclick = () => { readEditor(); startPick(); };
  $('#eCancel').onclick = () => { ed = null; closeModal('editor'); };
  $('#eSave').onclick = saveEditor;
  if ($('#eDel')) $('#eDel').onclick = () => {
    if (!confirm(`Delete ${ed.kanji || 'this house'}?`)) return;
    a.houses = a.houses.filter(x => x.id !== ed.id); save(); ed = null; closeModal('editor'); render(); toast('Deleted');
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
  const a = area(), { _isNew, _pos, ...house } = ed;
  a.houses = a.houses.filter(x => x.id !== house.id);
  const idx = Math.max(0, Math.min(a.houses.length, _pos - 1));
  a.houses.splice(idx, 0, house);
  save(); ed = null; closeModal('editor'); render();
  toast(_isNew ? `Added #${idx + 1} ${house.kanji}` : 'Saved');
}

/* ---------- Pick on map ---------- */
function startPick() {
  closeModal('editor');
  document.body.classList.add('picking');
  if (hasLoc(ed)) map.setView([ed.lat, ed.lng], Math.max(map.getZoom(), 18));
  else if (myPos) map.setView(myPos, 18);
}
$('#pickSet').onclick = () => {
  const c = map.getCenter(); ed.lat = c.lat; ed.lng = c.lng;
  document.body.classList.remove('picking'); renderEditor(); $('#editor').classList.add('show');
};
$('#pickCancel').onclick = () => { document.body.classList.remove('picking'); renderEditor(); $('#editor').classList.add('show'); };

/* ---------- Settings ---------- */
function renderSettings() {
  const a = area();
  $('#settingsPage').innerHTML = `
    <h2>Settings</h2>
    <div class="sec"><h3>Area</h3>
      <div class="row"><select id="sArea">${db.areas.map(x => `<option value="${x.id}" ${x.id === a.id ? 'selected' : ''}>${esc(x.name)} (${x.houses.length})</option>`).join('')}</select></div>
      <div class="row"><button class="btn small" id="sNewArea">+ New area</button><button class="btn small" id="sRename">Rename</button><button class="btn small danger" id="sDelArea">Delete area</button></div>
    </div>
    <div class="sec"><h3>Houses in route order</h3>
      <div class="row" style="margin-bottom:6px"><button class="btn small" id="sAdd">+ Add house</button><span class="muted">Tap a house to edit. ↑↓ to reorder.</span></div>
      ${a.houses.length ? a.houses.map((h, i) => `
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
      <b>Deliver:</b> Direction → Start → Done at each house. Tap a card in "Up next" to show it on the map.<br>
      <b>On hold:</b> set stop dates in a house to hide it from the route (休止).</div></div>
    <div class="muted" style="text-align:center">Paper Route v1</div>`;
  const pg = $('#settingsPage');
  $('#sArea').onchange = e => { db.currentAreaId = e.target.value; save(); renderSettings(); };
  $('#sNewArea').onclick = () => {
    const n = prompt('New area name', '23区'); if (!n) return;
    const na = { id: uid(), name: n.trim(), houses: [] }; db.areas.push(na); db.currentAreaId = na.id; save(); renderSettings();
  };
  $('#sRename').onclick = () => { const n = prompt('Area name', a.name); if (n) { a.name = n.trim(); save(); renderSettings(); } };
  $('#sDelArea').onclick = () => {
    if (!confirm(`Delete area "${a.name}" and its ${a.houses.length} houses?`)) return;
    db.areas = db.areas.filter(x => x.id !== a.id); delete db.progress[a.id]; db = normalize(db); save(); renderSettings();
  };
  $('#sAdd').onclick = () => openEditor(null, { lat: myPos?.[0], lng: myPos?.[1] });
  pg.querySelectorAll('.hl[data-edit]').forEach(el => el.onclick = e => { if (!e.target.closest('button')) openEditor(el.dataset.edit); });
  pg.querySelectorAll('[data-up],[data-down]').forEach(b => b.onclick = () => {
    const i = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up != null ? i - 1 : i + 1;
    if (j < 0 || j >= a.houses.length) return;
    [a.houses[i], a.houses[j]] = [a.houses[j], a.houses[i]]; save(); renderSettings();
  });
  $('#sReset').onclick = () => { if (confirm("Reset today's done/skipped marks?")) { delete db.progress[a.id]; save(); toast('Reset'); } };
  $('#sWake').onchange = e => { db.settings.wake = e.target.checked; save(); };
  $('#sDark').onchange = e => { db.settings.darkMap = e.target.checked; save(); applyMapStyle(); };
  $('#sExport').onclick = exportData;
  $('#sImport').onclick = () => $('#importFile').click();
}
async function exportData() {
  const data = JSON.stringify({ app: 'paper-route', version: 1, exported: new Date().toISOString(), areas: db.areas, settings: db.settings }, null, 2);
  const name = `paper-route-backup-${today()}.json`;
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
    db.areas = d.areas; if (d.settings) Object.assign(db.settings, d.settings);
    db.progress = {}; db = normalize(db); save(); applyMapStyle(); render(); toast('Backup restored');
  } catch (err) { toast('That file is not a Paper Route backup', 3000); }
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
  db.areas.push(a); db.currentAreaId = a.id; save(); render(); fitAll();
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
$('#dirHandle').onclick = () => { sheetMini = !sheetMini; renderDirection(); };
$('#ovHandle').onclick = () => $('#ovSheet').classList.toggle('mini');
$('#fabLocate').onclick = () => { startGPS(); if (myPos) map.setView(myPos, Math.max(map.getZoom(), 18)); else toast('Finding you…'); };
$('#fabFit').onclick = fitAll;
$('#fabFollow').onclick = () => {
  follow = !follow; $('#fabFollow').classList.toggle('on', follow); startGPS();
  toast(follow ? 'Following your position' : 'Follow off'); if (follow && myPos) map.panTo(myPos);
};
$('#fabAdd').onclick = async () => {
  startGPS();
  // Insert right after the current house while delivering, otherwise at the end.
  const c = current(), p = prog();
  const pos = p.started && c ? houseNo(c) + 1 : area().houses.length + 1;
  let lat = myPos?.[0], lng = myPos?.[1];
  try { const g = await getOnce(); lat = g.coords.latitude; lng = g.coords.longitude; } catch (e) {}
  openEditor(null, { lat, lng, pos });
};

/* ---------- boot ---------- */
applyMapStyle();
setTab('direction');
fitAll();
if (prog().started) { startGPS(); keepAwake(); }
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
