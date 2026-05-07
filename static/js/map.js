// ── Constants ────────────────────────────────────────────────────────────
const OSRM    = 'https://router.project-osrm.org/route/v1/foot';
const NOMIN   = 'https://nominatim.openstreetmap.org';
const TOPO_API = 'https://api.opentopodata.org/v1/srtm30m';

// ── State ────────────────────────────────────────────────────────────────
let map, routeLayer, elevChart;
let waypoints = [];   // [{id, lat, lng, name, marker}]
let routeGeometry = null;
let routeStats = { distance: 0, duration: 0, elevGain: 0 };

// ── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindControls();
  if (window.PRELOAD_ROUTE) loadExistingRoute(window.PRELOAD_ROUTE);
});

function initMap() {
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
    maxZoom: 19
  });
  const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17
  });
  const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.cyclosm.org">CyclOSM</a>',
    maxZoom: 20
  });

  map = L.map('map', { layers: [osmLayer], zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  L.control.layers(
    { 'Mappa': osmLayer, 'Topografica': topoLayer, 'CyclOSM': cyclosm },
    {},
    { position: 'topright', collapsed: true }
  ).addTo(map);

  // Start near user location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => map.setView([p.coords.latitude, p.coords.longitude], 13),
      () => map.setView([45.8, 10.0], 9)
    );
  } else {
    map.setView([45.8, 10.0], 9);
  }

  map.on('click', e => addWaypoint(e.latlng.lat, e.latlng.lng));
}

// ── Waypoints ────────────────────────────────────────────────────────────

async function addWaypoint(lat, lng, name = null) {
  if (!name) name = await reverseGeocode(lat, lng);

  const id = Date.now() + Math.random();
  const idx = waypoints.length;
  const marker = makeMarker(lat, lng, idx, name);
  marker.addTo(map);

  const wp = { id, lat, lng, name, marker };
  waypoints.push(wp);

  marker.on('dragend', async () => {
    const pos = marker.getLatLng();
    wp.lat = pos.lat;
    wp.lng = pos.lng;
    wp.name = await reverseGeocode(pos.lat, pos.lng);
    marker.setPopupContent(wp.name);
    refreshMarkerIcons();
    updateWpList();
    if (waypoints.length >= 2) await calcRoute();
  });

  refreshMarkerIcons();
  updateWpList();
  if (waypoints.length >= 2) await calcRoute();
}

function removeWaypoint(id) {
  const idx = waypoints.findIndex(w => w.id === id);
  if (idx === -1) return;
  map.removeLayer(waypoints[idx].marker);
  waypoints.splice(idx, 1);
  refreshMarkerIcons();
  updateWpList();
  if (waypoints.length >= 2) calcRoute();
  else clearRoute();
}

function clearAll() {
  waypoints.forEach(w => map.removeLayer(w.marker));
  waypoints = [];
  clearRoute();
  updateWpList();
}

function undoLast() {
  if (!waypoints.length) return;
  const last = waypoints[waypoints.length - 1];
  map.removeLayer(last.marker);
  waypoints.pop();
  refreshMarkerIcons();
  updateWpList();
  if (waypoints.length >= 2) calcRoute();
  else clearRoute();
}

function makeMarker(lat, lng, idx, name) {
  const isStart = idx === 0;
  const color = isStart ? '#198754' : '#0d6efd';
  const icon = L.divIcon({
    html: `<div class="wp-marker" style="background:${color}">${idx + 1}</div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16]
  });
  return L.marker([lat, lng], { draggable: true, icon }).bindPopup(name || '');
}

function refreshMarkerIcons() {
  waypoints.forEach((wp, i) => {
    const isStart = i === 0;
    const color = isStart ? '#198754' : '#0d6efd';
    const icon = L.divIcon({
      html: `<div class="wp-marker" style="background:${color}">${i + 1}</div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16]
    });
    wp.marker.setIcon(icon);
    wp.marker.setPopupContent(wp.name || '');
  });

  // Color last waypoint red if multiple
  if (waypoints.length > 1) {
    const last = waypoints[waypoints.length - 1];
    const icon = L.divIcon({
      html: `<div class="wp-marker" style="background:#dc3545">${waypoints.length}</div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16]
    });
    last.marker.setIcon(icon);
  }
}

// ── Routing ──────────────────────────────────────────────────────────────

async function calcRoute() {
  if (waypoints.length < 2) return;
  const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  try {
    const res = await fetch(`${OSRM}/${coords}?overview=full&geometries=geojson`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes.length) return;

    const r = data.routes[0];
    routeGeometry = r.geometry;
    routeStats.distance = r.distance / 1000;
    routeStats.duration = r.duration / 60;

    drawRoute();
    updateStatsBar();
    updateBtnState();
    await fetchElevation();
  } catch (err) {
    console.error('Routing error', err);
  }
}

function drawRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.geoJSON(routeGeometry, {
    style: { color: '#198754', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  routeGeometry = null;
  routeStats = { distance: 0, duration: 0, elevGain: 0 };
  document.getElementById('stats-bar')?.classList.add('d-none');
  document.getElementById('elev-panel')?.classList.add('d-none');
  updateBtnState();
}

// ── Elevation ────────────────────────────────────────────────────────────

async function fetchElevation() {
  if (!routeGeometry) return;
  const coords = routeGeometry.coordinates;
  const step = Math.max(1, Math.floor(coords.length / 60));
  const sampled = coords.filter((_, i) => i % step === 0);

  const locations = sampled.map(c => `${c[1]},${c[0]}`).join('|');

  try {
    const res = await fetch(`${TOPO_API}?locations=${locations}`);
    const data = await res.json();
    if (data.status !== 'OK') return;

    const elevs = data.results.map(r => r.elevation);
    computeElevGain(elevs);
    drawElevChart(elevs);
    updateStatsBar();
  } catch (err) {
    console.warn('Elevation API unavailable');
  }
}

function computeElevGain(elevs) {
  let gain = 0;
  for (let i = 1; i < elevs.length; i++) {
    const diff = elevs[i] - elevs[i - 1];
    if (diff > 0) gain += diff;
  }
  routeStats.elevGain = Math.round(gain);
}

function drawElevChart(elevs) {
  const panel = document.getElementById('elev-panel');
  const canvas = document.getElementById('elev-chart');
  if (!panel || !canvas) return;

  if (elevChart) elevChart.destroy();

  const labels = elevs.map((_, i) =>
    ((routeStats.distance * i) / (elevs.length - 1)).toFixed(1)
  );

  elevChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: elevs,
        fill: true,
        backgroundColor: 'rgba(25,135,84,.15)',
        borderColor: '#198754',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => `${Math.round(ctx.parsed.y)} m` }
      }},
      scales: {
        x: { title: { display: true, text: 'km' }, ticks: { maxTicksLimit: 5 } },
        y: { title: { display: true, text: 'm s.l.m.' } }
      }
    }
  });
  panel.classList.remove('d-none');
}

// ── Stats bar ─────────────────────────────────────────────────────────────

function updateStatsBar() {
  const bar = document.getElementById('stats-bar');
  if (!bar) return;

  document.getElementById('stat-dist').textContent =
    routeStats.distance.toFixed(2);
  document.getElementById('stat-dur').textContent =
    fmtDuration(routeStats.duration);
  document.getElementById('stat-elev').textContent =
    routeStats.elevGain > 0 ? `+${routeStats.elevGain}` : '—';

  bar.classList.remove('d-none');
}

function fmtDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}

// ── Waypoint list UI ──────────────────────────────────────────────────────

function updateWpList() {
  const list = document.getElementById('wp-list');
  const empty = document.getElementById('wp-empty');
  const count = document.getElementById('wp-count');
  if (!list) return;

  count.textContent = waypoints.length;

  if (!waypoints.length) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = waypoints.map((wp, i) => {
    const isStart = i === 0, isEnd = i === waypoints.length - 1 && i > 0;
    const dotClass = isStart ? 'wp-dot-start' : isEnd ? 'wp-dot-end' : 'wp-dot-mid';
    return `
      <div class="wp-list-row">
        <span class="wp-dot ${dotClass}">${i + 1}</span>
        <span class="wp-list-name">${wp.name}</span>
        <button class="wp-del-btn" onclick="removeWaypoint(${wp.id})">
          <i class="bi bi-x"></i>
        </button>
      </div>`;
  }).join('');

  updateBtnState();
}

function updateBtnState() {
  const hasWps = waypoints.length > 0;
  const hasRoute = routeGeometry !== null;
  document.getElementById('btn-undo').disabled = !hasWps;
  document.getElementById('btn-clear').disabled = !hasWps;
  document.getElementById('btn-save').disabled = !hasRoute;
}

// ── Search ────────────────────────────────────────────────────────────────

async function search(query) {
  if (!query.trim()) return;
  try {
    const res = await fetch(
      `${NOMIN}/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=it`,
      { headers: { 'User-Agent': 'HikePath/1.0' } }
    );
    const results = await res.json();
    showSearchResults(results);
  } catch (err) {
    console.error('Search error', err);
  }
}

function showSearchResults(results) {
  const box = document.getElementById('search-results');
  if (!results.length) { box.style.display = 'none'; return; }

  box.innerHTML = results.map(r => `
    <button class="list-group-item list-group-item-action text-start small py-2"
            onclick="selectSearchResult(${r.lat},${r.lon},'${escapeHtml(r.display_name.split(',')[0])}')">
      <i class="bi bi-geo-alt-fill text-success me-1"></i>
      ${escapeHtml(r.display_name.split(',').slice(0, 2).join(', '))}
    </button>`
  ).join('');
  box.style.display = 'block';
}

function selectSearchResult(lat, lon, name) {
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('search-input').value = name;
  map.setView([lat, lon], 14);
  addWaypoint(parseFloat(lat), parseFloat(lon), name);
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `${NOMIN}/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it`,
      { headers: { 'User-Agent': 'HikePath/1.0' } }
    );
    const d = await res.json();
    return d.address?.road || d.address?.hamlet || d.address?.village ||
           d.address?.town || d.address?.city || d.name ||
           `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ── Save ─────────────────────────────────────────────────────────────────

document.getElementById('save-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Salvo…';

  const payload = {
    name: document.getElementById('route-name').value.trim(),
    description: document.getElementById('route-desc').value.trim(),
    difficulty: document.getElementById('route-diff').value,
    distance_km: routeStats.distance,
    duration_min: routeStats.duration,
    elevation_gain_m: routeStats.elevGain,
    waypoints: waypoints.map(({ lat, lng, name }) => ({ lat, lng, name })),
    geometry: routeGeometry
  };

  try {
    const res = await fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      window.location.href = `/routes/${data.id}`;
    } else {
      alert('Errore nel salvataggio: ' + (data.error || 'sconosciuto'));
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-floppy me-1"></i>Salva percorso';
    }
  } catch (err) {
    alert('Errore di rete.');
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-floppy me-1"></i>Salva percorso';
  }
});

// ── Load existing route ───────────────────────────────────────────────────

async function loadExistingRoute(route) {
  document.getElementById('route-name').value = route.name || '';
  document.getElementById('route-desc').value = route.description || '';
  document.getElementById('route-diff').value = route.difficulty || 'medium';

  for (const wp of (route.waypoints || [])) {
    await addWaypoint(wp.lat, wp.lng, wp.name);
  }
}

// ── Controls binding ──────────────────────────────────────────────────────

function bindControls() {
  document.getElementById('btn-undo')?.addEventListener('click', undoLast);
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Rimuovere tutti i waypoint?')) clearAll();
  });

  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');

  searchBtn?.addEventListener('click', () => search(searchInput.value));
  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') search(searchInput.value);
  });

  // Close search results on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-input') && !e.target.closest('#search-results')) {
      document.getElementById('search-results').style.display = 'none';
    }
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]
  );
}
