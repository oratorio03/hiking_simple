// ── Constants ─────────────────────────────────────────────────────────────
const BROUTER      = 'https://brouter.de/brouter';
const OSRM         = 'https://router.project-osrm.org/route/v1/foot';
const NOMIN        = 'https://nominatim.openstreetmap.org';
const OVERPASS     = 'https://overpass-api.de/api/interpreter';
const TOPO_API     = 'https://api.opentopodata.org/v1/srtm30m';
const ELEV_FALLBACK = 'https://api.open-elevation.com/api/v1/lookup';
const MIN_SLOPE_SEGMENT_M = 25;
const VISUAL_SLOPE_CLAMP_PCT = 50;

// ── State ─────────────────────────────────────────────────────────────────
let map, routeLayer, osmTrailsLayer, elevChart, slopeChart;
let chartHoverMarker = null;
let waypoints     = [];
let routeGeometry = null;
let osmTrailsVisible = false;
let selectedOsmTrail = null;
let routeSource = 'manual'; // 'manual' | 'osm_single' | 'osm_composed'
let routeAnalysisId = 0;
let routeProfile  = 'hiking';   // 'hiking' | 'trekking' | 'safety'
let routeStats    = {
  distance: 0, duration: 0,
  elevGain: 0, elevLoss: 0, maxElev: null, minElev: null,
  avgSlope: null, maxSlopeAsc: null, maxSlopeDesc: null,
  elevSeries: [], slopeSeries: [], visualSlopeSeries: []
};

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindControls();
  if (window.PRELOAD_ROUTE) loadExistingRoute(window.PRELOAD_ROUTE);
});

function initMap() {
  const osmLayer  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom: 19
  });
  const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17
  });
  const cyclosm   = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.cyclosm.org">CyclOSM</a>', maxZoom: 20
  });

  map = L.map('map', { layers: [topoLayer], zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  L.control.layers(
    { 'Topografica': topoLayer, 'Standard OSM': osmLayer, 'CyclOSM': cyclosm },
    {}, { position: 'topright', collapsed: true }
  ).addTo(map);

  navigator.geolocation?.getCurrentPosition(
    p => map.setView([p.coords.latitude, p.coords.longitude], 13),
    () => map.setView([45.8, 10.0], 9)
  );

  map.on('click', handleMapClick);
}

function handleMapClick(e) {
  if (routeSource !== 'manual') return;
  addWaypoint(e.latlng.lat, e.latlng.lng);
}

// ── Route profile selection ───────────────────────────────────────────────

function setRouteProfile(profile) {
  routeProfile = profile;
  ['hiking', 'trekking', 'safety'].forEach(p => {
    const btn = document.getElementById(`btn-prof-${p}`);
    if (btn) btn.className = `btn btn-sm ${p === profile ? 'btn-success' : 'btn-outline-secondary'}`;
  });
  if (routeSource === 'manual' && waypoints.length >= 2) calcRoute();
}

// ── Waypoints ─────────────────────────────────────────────────────────────

async function addWaypoint(lat, lng, name = null, options = {}) {
  if (!name) name = await reverseGeocode(lat, lng);

  const id     = Date.now() + Math.random();
  const marker = makeMarker(lat, lng, waypoints.length, name);
  marker.addTo(map);

  const wp = { id, lat, lng, name, marker };
  waypoints.push(wp);

  marker.on('dragend', async () => {
    const pos = marker.getLatLng();
    wp.lat = pos.lat; wp.lng = pos.lng;
    wp.name = await reverseGeocode(pos.lat, pos.lng);
    marker.setPopupContent(wp.name);
    refreshMarkerIcons();
    updateWpList();
    if (waypoints.length >= 2) await calcRoute();
  });

  refreshMarkerIcons();
  updateWpList();
  if (!options.skipRouteCalc && waypoints.length >= 2) await calcRoute();
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
  routeAnalysisId += 1;
  clearManualWaypoints();
  clearOsmTrailSelection();
  routeSource = 'manual';
  clearRoute();
  updateWpList();
}

function clearManualWaypoints() {
  waypoints.forEach(w => map.removeLayer(w.marker));
  waypoints = [];
}

function undoLast() {
  if (!waypoints.length) return;
  map.removeLayer(waypoints.pop().marker);
  refreshMarkerIcons();
  updateWpList();
  if (waypoints.length >= 2) calcRoute();
  else clearRoute();
}

function makeMarker(lat, lng, idx, name) {
  const color = idx === 0 ? '#198754' : '#0d6efd';
  const icon  = L.divIcon({
    html: `<div class="wp-marker" style="background:${color}">${idx + 1}</div>`,
    className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -16]
  });
  return L.marker([lat, lng], { draggable: true, icon }).bindPopup(name || '');
}

function refreshMarkerIcons() {
  waypoints.forEach((wp, i) => {
    const isEnd = i === waypoints.length - 1 && i > 0;
    const color = i === 0 ? '#198754' : isEnd ? '#dc3545' : '#0d6efd';
    const icon  = L.divIcon({
      html: `<div class="wp-marker" style="background:${color}">${i + 1}</div>`,
      className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -16]
    });
    wp.marker.setIcon(icon);
    wp.marker.setPopupContent(wp.name || '');
  });
}

// ── Brouter routing (primary) ─────────────────────────────────────────────

async function calcRoute() {
  if (waypoints.length < 2) return;
  routeSource = 'manual';
  routeAnalysisId += 1;
  showSpinner('Calcolo percorso…');
  setStatus('', '');

  const lonlats = waypoints.map(w => `${w.lng},${w.lat}`).join('|');

  try {
    const res  = await fetchWithTimeout(
      `${BROUTER}?lonlats=${lonlats}&profile=${routeProfile}&alternativeidx=0&format=geojson`,
      {}, 18000
    );

    // Brouter returns 500 with plain-text error when no route found
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Brouter HTTP ${res.status}`);
    }

    const data    = await res.json();
    const feature = data.features?.[0];
    if (!feature) throw new Error('No route in response');

    const coords = feature.geometry.coordinates;  // [lon, lat, elev?]
    const props  = feature.properties;

    routeGeometry       = { type: 'LineString', coordinates: coords };
    routeStats.distance = parseFloat(props['track-length']) / 1000;
    routeStats.duration = parseFloat(props['total-time'])   / 60;

    drawRoute();
    updateStatsBar();
    updateBtnState();
    hideSpinner();

    // Elevation is embedded in 3D coords — no external API needed
    const elevSampled = extractBrouterElevation(coords, props);
    if (elevSampled) {
      drawElevChart(elevSampled);
      drawSlopeChart(routeStats.slopeSeries);
      updateStatsBar();
      document.getElementById('chart-panel')?.classList.remove('d-none');
      const elevStatus = document.getElementById('elev-status');
      if (elevStatus) elevStatus.style.display = 'none';
    } else {
      await fetchElevation();
    }

  } catch (err) {
    console.warn('Brouter failed, falling back to OSRM:', err.message);
    setStatus('Brouter non raggiungibile, uso routing alternativo…', 'muted');
    await calcRouteOSRM();
  }
}

// ── OSRM routing (fallback) ───────────────────────────────────────────────

async function calcRouteOSRM() {
  const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  try {
    const res  = await fetchWithTimeout(
      `${OSRM}/${coords}?overview=full&geometries=geojson`, {}, 12000
    );
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes.length) {
      setStatus('Nessun percorso trovato. Sposta i waypoint su sentieri o strade.', 'warning');
      hideSpinner();
      return;
    }

    const r           = data.routes[0];
    routeGeometry     = r.geometry;
    routeStats.distance = r.distance / 1000;
    routeStats.duration = r.duration / 60;

    setStatus('Brouter non disponibile — percorso alternativo (potrebbe non seguire sentieri).', 'warning');
    drawRoute();
    updateStatsBar();
    updateBtnState();
    hideSpinner();
    await fetchElevation();

  } catch (err) {
    hideSpinner();
    setStatus('Impossibile calcolare il percorso. Controlla la connessione.', 'danger');
    console.error('OSRM fallback failed:', err);
  }
}

// ── Route drawing ─────────────────────────────────────────────────────────

function drawRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.geoJSON(routeGeometry, {
    style: { color: '#198754', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

// ── Visible OSM trails layer ──────────────────────────────────────────────

async function toggleOsmTrails() {
  const btn = document.getElementById('btn-osm-trails');

  if (osmTrailsVisible) {
    if (osmTrailsLayer) map.removeLayer(osmTrailsLayer);
    clearOsmTrailSelection();
    osmTrailsVisible = false;
    if (btn) {
      btn.className = 'btn btn-sm btn-outline-success w-100';
      btn.innerHTML = '<i class="bi bi-signpost-2 me-1"></i>Mostra sentieri OSM visibili';
    }
    setStatus('', '');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Carico sentieri OSM...';
  }
  setStatus('Caricamento sentieri OSM nella zona visibile...', 'muted');

  try {
    const geojson = await fetchVisibleOsmTrails();
    if (osmTrailsLayer) map.removeLayer(osmTrailsLayer);

    osmTrailsLayer = L.geoJSON(geojson, {
      style: feature => osmTrailStyle(feature.properties || {}),
      onEachFeature: (feature, layer) => {
        layer.on('click', e => {
          if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
          selectOsmTrail(feature, layer);
        });
        layer.on('popupopen', e => bindOsmTrailPopupActions(e.popup, feature, layer));
        layer.bindPopup(() => osmTrailPopup(feature, estimateLineLengthKm(feature.geometry)));
      }
    }).addTo(map);

    osmTrailsVisible = true;
    if (btn) {
      btn.disabled = false;
      btn.className = 'btn btn-sm btn-success w-100';
      btn.innerHTML = '<i class="bi bi-eye-slash me-1"></i>Nascondi sentieri OSM';
    }
    setStatus(`${geojson.features.length} sentieri OSM caricati nella zona visibile.`, 'success');
  } catch (err) {
    console.warn('OSM trails load failed:', err);
    if (btn) {
      btn.disabled = false;
      btn.className = 'btn btn-sm btn-outline-success w-100';
      btn.innerHTML = '<i class="bi bi-signpost-2 me-1"></i>Mostra sentieri OSM visibili';
    }
    setStatus('Impossibile caricare i sentieri OSM. Riduci lo zoom o riprova tra poco.', 'warning');
  }
}

async function fetchVisibleOsmTrails() {
  const b = map.getBounds();
  const bbox = [
    b.getSouth().toFixed(6),
    b.getWest().toFixed(6),
    b.getNorth().toFixed(6),
    b.getEast().toFixed(6)
  ].join(',');

  const query = `
    [out:json][timeout:20];
    (
      way["highway"="path"](${bbox});
      way["highway"="footway"](${bbox});
      way["highway"="track"](${bbox});
    );
    out tags geom;
  `;

  const res = await fetchWithTimeout(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ data: query })
  }, 25000);

  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return overpassToGeoJson(await res.json());
}

function overpassToGeoJson(data) {
  const features = (data.elements || [])
    .filter(el => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map(el => ({
      type: 'Feature',
      properties: el.tags || {},
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map(p => [p.lon, p.lat])
      }
    }));

  return { type: 'FeatureCollection', features };
}

function osmTrailStyle(tags) {
  const color = tags.highway === 'track' ? '#8b5e34' : tags.highway === 'footway' ? '#0d6efd' : '#6f42c1';
  return {
    color,
    weight: 3,
    opacity: 0.75,
    dashArray: tags.highway === 'track' ? '6 4' : null
  };
}

function selectedOsmTrailStyle() {
  return {
    color: '#dc3545',
    weight: 7,
    opacity: 0.95,
    dashArray: null,
    lineCap: 'round',
    lineJoin: 'round'
  };
}

function selectOsmTrail(feature, layer) {
  if (selectedOsmTrail?.layer && selectedOsmTrail.layer !== layer) {
    selectedOsmTrail.layer.setStyle(osmTrailStyle(selectedOsmTrail.feature.properties || {}));
  }

  const lengthKm = estimateLineLengthKm(feature.geometry);
  selectedOsmTrail = { feature, layer, lengthKm };
  layer.setStyle(selectedOsmTrailStyle());
  layer.bringToFront?.();
  setStatus('Sentiero OSM selezionato. Puoi usarlo come percorso dal popup.', 'success');
  updateBtnState();
}

function clearOsmTrailSelection() {
  if (selectedOsmTrail?.layer && osmTrailsLayer?.hasLayer?.(selectedOsmTrail.layer)) {
    selectedOsmTrail.layer.setStyle(osmTrailStyle(selectedOsmTrail.feature.properties || {}));
  }
  selectedOsmTrail = null;
}

function bindOsmTrailPopupActions(popup, feature, layer) {
  const el = popup.getElement();
  const btn = el?.querySelector('[data-action="use-osm-trail"]');
  if (!btn) return;

  L.DomEvent.disableClickPropagation(btn);
  btn.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedOsmTrail || selectedOsmTrail.layer !== layer) {
      selectOsmTrail(feature, layer);
    }
    await useSelectedOsmTrailAsRoute();
  }, { once: true });
}

async function useSelectedOsmTrailAsRoute() {
  if (!selectedOsmTrail?.feature?.geometry) return;

  clearManualWaypoints();
  routeSource = 'osm_single';
  routeGeometry = {
    type: 'LineString',
    coordinates: selectedOsmTrail.feature.geometry.coordinates
  };
  routeStats = {
    distance: selectedOsmTrail.lengthKm || estimateLineLengthKm(routeGeometry) || 0,
    duration: null,
    elevGain: 0,
    elevLoss: 0,
    maxElev: null,
    minElev: null,
    avgSlope: null,
    maxSlopeAsc: null,
    maxSlopeDesc: null,
    elevSeries: [],
    slopeSeries: [],
    visualSlopeSeries: []
  };
  clearChartRouteMarker();
  document.getElementById('chart-panel')?.classList.add('d-none');
  map.closePopup();
  const analysisId = ++routeAnalysisId;
  drawRoute();
  updateStatsBar();
  updateWpList();
  updateBtnState();
  setStatus('Analisi altimetrica del sentiero OSM...', 'muted');

  const hasElevation = await fetchElevation({
    loadingText: 'Analisi altimetrica del sentiero OSM...',
    fallbackText: 'Tentativo con API altimetrica alternativa...',
    failureText: 'Dati altimetrici non disponibili per questo sentiero OSM.',
    successText: 'Sentiero OSM usato come percorso.',
    analysisId
  });

  if (analysisId !== routeAnalysisId) return;
  if (!hasElevation) {
    updateStatsBar();
    setStatus('Sentiero OSM usato come percorso. Dati altimetrici non disponibili.', 'warning');
  }
}

function estimateLineLengthKm(geometry) {
  const coords = geometry?.coordinates || [];
  if (coords.length < 2 || !map) return null;

  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += map.distance(
      [coords[i - 1][1], coords[i - 1][0]],
      [coords[i][1], coords[i][0]]
    );
  }
  return Math.round((meters / 1000) * 100) / 100;
}

function osmTrailPopup(feature, lengthKm = null) {
  const tags = feature?.properties || {};
  const tagValue = value => value || 'non disponibile';
  const rows = [
    ['Nome', tagValue(tags.name)],
    ['highway', tagValue(tags.highway)],
    ['sac_scale', tagValue(tags.sac_scale)],
    ['surface', tagValue(tags.surface)],
    ['trail_visibility', tagValue(tags.trail_visibility)],
    ['smoothness', tagValue(tags.smoothness)],
    ['wheelchair', tagValue(tags.wheelchair)],
    ['incline', tagValue(tags.incline)],
    ['Lunghezza stimata', lengthKm !== null ? `${lengthKm.toFixed(2)} km` : 'non disponibile']
  ];

  const details = rows.map(([label, value], i) =>
    `${i === 0 ? '<strong>' : ''}${escapeHtml(label)}: ${escapeHtml(value)}${i === 0 ? '</strong>' : ''}`
  ).join('<br>');

  return `
    <div>
      ${details}
      <button type="button" class="btn btn-sm btn-success w-100 mt-2" data-action="use-osm-trail">
        Usa come percorso
      </button>
    </div>`;
}

function clearRoute() {
  routeAnalysisId += 1;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  clearChartRouteMarker();
  routeGeometry = null;
  routeStats = {
    distance: 0, duration: 0,
    elevGain: 0, elevLoss: 0, maxElev: null, minElev: null,
    avgSlope: null, maxSlopeAsc: null, maxSlopeDesc: null,
    elevSeries: [], slopeSeries: [], visualSlopeSeries: []
  };
  document.getElementById('stats-bar')?.classList.add('d-none');
  document.getElementById('chart-panel')?.classList.add('d-none');
  setStatus('', '');
  updateBtnState();
}

// ── Elevation from Brouter 3D coords ─────────────────────────────────────

function extractBrouterElevation(coords, props) {
  if (!coords.length || coords[0].length < 3) return null;

  const allElevs = coords.map(c => c[2]);
  if (allElevs.some(e => e == null || isNaN(e))) return null;

  // Accurate stats from the full series
  routeStats.maxElev = Math.round(Math.max(...allElevs));
  routeStats.minElev = Math.round(Math.min(...allElevs));

  let gain = 0, loss = 0;
  for (let i = 1; i < allElevs.length; i++) {
    const d = allElevs[i] - allElevs[i - 1];
    if (d > 0) gain += d; else loss += Math.abs(d);
  }
  routeStats.elevGain = Math.round(gain);
  routeStats.elevLoss = Math.round(loss);

  // Sample down to ≤100 points for chart rendering
  const step    = Math.max(1, Math.floor(allElevs.length / 80));
  const sampled = allElevs.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== allElevs[allElevs.length - 1]) {
    sampled.push(allElevs[allElevs.length - 1]);
  }
  routeStats.elevSeries = sampled;

  updateSlopeStats(coords, allElevs);

  return sampled;
}

// ── Elevation fallback (external APIs, used when Brouter unavailable) ─────

async function fetchElevation(options = {}) {
  if (!routeGeometry) return false;

  const elevStatus = document.getElementById('elev-status');
  const reloadBtn  = document.getElementById('btn-reload-elev');
  const loadingText = options.loadingText || 'Caricamento dati altimetrici...';
  const fallbackText = options.fallbackText || 'Tentativo con API alternativa...';
  const failureText = options.failureText || 'Dati altimetrici non disponibili. Riprova tra poco.';
  const successText = options.successText || null;
  const isCurrentAnalysis = () => !options.analysisId || options.analysisId === routeAnalysisId;

  if (elevStatus) { elevStatus.textContent = loadingText; elevStatus.style.display = ''; }
  if (reloadBtn)  reloadBtn.style.display = 'none';

  const coords  = routeGeometry.coordinates;
  const step    = Math.max(1, Math.floor(coords.length / 50));
  const sampled = coords.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
  }

  // If Brouter already embedded elevation, use it
  if (sampled[0]?.length >= 3 && sampled[0][2] != null) {
    if (!isCurrentAnalysis()) return false;
    const elevs = extractBrouterElevation(coords, {});
    if (elevs) {
      if (elevStatus) elevStatus.style.display = 'none';
      drawElevChart(elevs);
      drawSlopeChart(routeStats.slopeSeries);
      updateStatsBar();
      document.getElementById('chart-panel')?.classList.remove('d-none');
      if (successText) setStatus(successText, 'success');
      return true;
    }
  }

  let elevs = null;

  // Primary: OpenTopoData SRTM30m
  try {
    const locs = sampled.map(c => `${c[1]},${c[0]}`).join('|');
    const res  = await fetchWithTimeout(`${TOPO_API}?locations=${locs}`, {}, 9000);
    const data = await res.json();
    if (data.status === 'OK' && data.results?.length) {
      elevs = data.results.map(r => r.elevation);
    }
  } catch (e) {
    console.warn('OpenTopoData unavailable, trying fallback', e);
  }

  // Fallback: Open-Elevation (POST)
  if (!elevs) {
    try {
      if (elevStatus) elevStatus.textContent = fallbackText;
      const locations = sampled.map(c => ({ latitude: c[1], longitude: c[0] }));
      const res = await fetchWithTimeout(ELEV_FALLBACK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations })
      }, 14000);
      const data = await res.json();
      if (data.results?.length) elevs = data.results.map(r => r.elevation);
    } catch (e) {
      console.warn('Open-Elevation fallback failed', e);
    }
  }

  if (!elevs) {
    if (!isCurrentAnalysis()) return false;
    if (elevStatus) elevStatus.textContent = failureText;
    if (reloadBtn)  reloadBtn.style.display = '';
    return false;
  }

  if (elevStatus) elevStatus.style.display = 'none';
  if (reloadBtn)  reloadBtn.style.display  = 'none';
  if (!isCurrentAnalysis()) return false;

  processElevation(elevs, sampled);
  drawElevChart(elevs);
  drawSlopeChart(routeStats.slopeSeries);
  updateStatsBar();
  document.getElementById('chart-panel')?.classList.remove('d-none');
  if (successText) setStatus(successText, 'success');
  return true;
}

function reloadElevation() {
  fetchElevation();
}

function processElevation(elevs, coords = null) {
  routeStats.elevSeries = elevs;
  routeStats.maxElev    = Math.round(Math.max(...elevs));
  routeStats.minElev    = Math.round(Math.min(...elevs));

  let gain = 0, loss = 0;
  for (let i = 1; i < elevs.length; i++) {
    const diff = elevs[i] - elevs[i - 1];
    if (diff > 0) gain += diff; else loss += Math.abs(diff);
  }
  routeStats.elevGain = Math.round(gain);
  routeStats.elevLoss = Math.round(loss);

  updateSlopeStats(coords, elevs);
}

// ── Charts ────────────────────────────────────────────────────────────────

function updateSlopeStats(coords, elevs) {
  const rawSlopes = buildSlopeSeries(coords, elevs);
  routeStats.slopeSeries = rawSlopes;
  routeStats.visualSlopeSeries = buildVisualSlopeSeries(rawSlopes);

  const statsSlopes = routeStats.visualSlopeSeries.length ? routeStats.visualSlopeSeries : rawSlopes;
  const absSlopes = statsSlopes.map(Math.abs);
  routeStats.avgSlope = absSlopes.length
    ? Math.round((absSlopes.reduce((a, b) => a + b, 0) / absSlopes.length) * 10) / 10
    : null;
  routeStats.maxSlopeAsc = statsSlopes.length ? Math.max(...statsSlopes) : null;
  routeStats.maxSlopeDesc = statsSlopes.length ? Math.min(...statsSlopes) : null;
}

function buildSlopeSeries(coords, elevs) {
  if (!elevs || elevs.length < 2) return [];

  const slopes = [];
  let distBucket = 0;
  let elevBucket = 0;

  for (let i = 1; i < elevs.length; i++) {
    const segDistM = coords && coords[i - 1] && coords[i]
      ? haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0])
      : (routeStats.distance * 1000) / (elevs.length - 1);

    if (!segDistM || !isFinite(segDistM)) continue;

    distBucket += segDistM;
    elevBucket += elevs[i] - elevs[i - 1];

    if (distBucket < MIN_SLOPE_SEGMENT_M && i < elevs.length - 1) continue;

    slopes.push(Math.round((elevBucket / distBucket) * 1000) / 10);
    distBucket = 0;
    elevBucket = 0;
  }

  return slopes;
}

function buildVisualSlopeSeries(slopes) {
  const smoothed = smoothSeries(slopes, 3);
  // Visual-only clamp: keeps the chart readable when elevation noise creates unrealistic spikes.
  return smoothed.map(s => Math.max(-VISUAL_SLOPE_CLAMP_PCT, Math.min(VISUAL_SLOPE_CLAMP_PCT, s)));
}

function smoothSeries(values, windowSize = 3) {
  if (!values.length || windowSize <= 1) return values;
  const radius = Math.floor(windowSize / 2);
  return values.map((_, i) => {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length, i + radius + 1);
    const slice = values.slice(start, end);
    return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
  });
}

function isValidRouteGeometry(geometry) {
  return geometry?.type === 'LineString' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length >= 2;
}

function technicalWaypointsFromGeometry(geometry) {
  if (!isValidRouteGeometry(geometry)) return [];

  const coords = geometry.coordinates;
  const start = coords[0];
  const end = coords[coords.length - 1];
  if (!start || !end || start[0] == null || start[1] == null || end[0] == null || end[1] == null) {
    return [];
  }

  return [
    { lat: start[1], lng: start[0], name: 'Inizio sentiero OSM' },
    { lat: end[1], lng: end[0], name: 'Fine sentiero OSM' }
  ];
}

function buildSaveWaypoints() {
  const manualWaypoints = waypoints.map(({ lat, lng, name }) => ({ lat, lng, name }));
  if (manualWaypoints.length || routeSource !== 'osm_single') return manualWaypoints;
  return technicalWaypointsFromGeometry(routeGeometry);
}

function inferRouteSource(route) {
  const savedWaypoints = route.waypoints || [];
  const hasOsmTechnicalWaypoints = savedWaypoints.length === 2 &&
    savedWaypoints[0]?.name === 'Inizio sentiero OSM' &&
    savedWaypoints[1]?.name === 'Fine sentiero OSM';

  return isValidRouteGeometry(route.geometry) && hasOsmTechnicalWaypoints
    ? 'osm_single'
    : 'manual';
}

function slopeColor(slope, alpha = 0.85) {
  const abs = Math.abs(slope);
  if (abs < 10) return slope >= 0 ? `rgba(25,135,84,${alpha})` : `rgba(13,110,253,${alpha})`;
  if (abs < 20) return `rgba(255,193,7,${alpha})`;
  if (abs < 30) return `rgba(253,126,20,${alpha})`;
  return `rgba(220,53,69,${alpha})`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bindChartRouteMarker(chart, values, valueLabel, valueUnit) {
  chart.options.onHover = (event, elements) => {
    if (!elements.length) return;
    const idx = elements[0].index;
    showChartRouteMarker(idx, values.length, {
      value: values[idx],
      label: valueLabel,
      unit: valueUnit
    }, false);
  };
  chart.options.onClick = (event, elements) => {
    if (!elements.length) return;
    const idx = elements[0].index;
    showChartRouteMarker(idx, values.length, {
      value: values[idx],
      label: valueLabel,
      unit: valueUnit
    }, true);
  };
  chart.update();
}

function showChartRouteMarker(index, totalPoints, metric, centerMap = false) {
  const routePoint = getRoutePointForChartIndex(index, totalPoints);
  if (!routePoint) return;

  const { coord, ratio } = routePoint;
  const lat = coord[1];
  const lng = coord[0];
  if (lat == null || lng == null) return;

  const km = routeStats.distance ? routeStats.distance * ratio : 0;
  const elev = coord[2] ?? routeStats.elevSeries?.[index];
  const value = Number.isFinite(metric.value) ? metric.value : null;
  const valueText = value == null
    ? ''
    : `<br>${metric.label}: ${value > 0 && metric.unit === '%' ? '+' : ''}${value.toFixed(1)}${metric.unit}`;
  const elevText = Number.isFinite(elev) ? `<br>Quota: ${Math.round(elev)} m` : '';

  if (chartHoverMarker) map.removeLayer(chartHoverMarker);
  chartHoverMarker = L.circleMarker([lat, lng], {
    radius: 9,
    color: '#fff',
    weight: 3,
    fillColor: '#dc3545',
    fillOpacity: 0.95
  }).addTo(map);
  chartHoverMarker.bindPopup(`Km circa: ${km.toFixed(2)}${valueText}${elevText}`).openPopup();

  if (centerMap) map.panTo([lat, lng]);
}

function getRoutePointForChartIndex(index, totalPoints) {
  const coords = routeGeometry?.coordinates;
  if (!coords || !coords.length || !totalPoints) return null;

  const ratio = totalPoints <= 1 ? 0 : index / (totalPoints - 1);
  const routeIndex = Math.max(0, Math.min(
    coords.length - 1,
    Math.round(ratio * (coords.length - 1))
  ));

  return { coord: coords[routeIndex], ratio };
}

function clearChartRouteMarker() {
  if (!chartHoverMarker || !map) return;
  map.removeLayer(chartHoverMarker);
  chartHoverMarker = null;
}

function drawElevChart(elevs) {
  const canvas = document.getElementById('elev-chart');
  if (!canvas) return;
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
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${Math.round(ctx.parsed.y)} m s.l.m.` } }
      },
      scales: {
        x: { title: { display: true, text: 'km' }, ticks: { maxTicksLimit: 5 } },
        y: { title: { display: true, text: 'm' } }
      }
    }
  });
  bindChartRouteMarker(elevChart, elevs, 'Quota', ' m');
}

function drawSlopeChart(slopes) {
  const canvas = document.getElementById('slope-chart');
  if (!canvas || !slopes.length) return;
  if (slopeChart) slopeChart.destroy();

  const visualSlopes = routeStats.visualSlopeSeries.length ? routeStats.visualSlopeSeries : slopes;
  const labels = visualSlopes.map((_, i) =>
    ((routeStats.distance * i) / Math.max(1, visualSlopes.length - 1)).toFixed(1)
  );

  slopeChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: visualSlopes,
          fill: true,
          backgroundColor: 'rgba(25,135,84,.08)',
          borderColor: '#198754',
          segment: {
            borderColor: ctx => slopeColor(ctx.p1.parsed.y, 0.95)
          },
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.28
        },
        {
          data: visualSlopes.map(() => 0),
          borderColor: 'rgba(108,117,125,.35)',
          borderWidth: 1,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.datasetIndex === 0,
          callbacks: {
            label: ctx => {
              const v   = ctx.parsed.y;
              const abs = Math.abs(v);
              const lbl = abs < 10 ? 'dolce' : abs < 20 ? 'moderata' : abs < 30 ? 'ripida' : 'molto ripida';
              const raw = slopes[ctx.dataIndex];
              const clamped = raw != null && Math.abs(raw) > VISUAL_SLOPE_CLAMP_PCT ? ' visualizzata' : '';
              return `${v > 0 ? '+' : ''}${v.toFixed(1)}%${clamped}  (${lbl})`;
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'km' }, ticks: { maxTicksLimit: 5 } },
        y: {
          title: { display: true, text: 'Pendenza (%)' },
          suggestedMin: -VISUAL_SLOPE_CLAMP_PCT,
          suggestedMax: VISUAL_SLOPE_CLAMP_PCT,
          ticks: { callback: v => `${v > 0 ? '+' : ''}${v}%` }
        }
      }
    }
  });
  bindChartRouteMarker(slopeChart, visualSlopes, 'Pendenza', '%');
}

// ── Stats bar ─────────────────────────────────────────────────────────────

function updateStatsBar() {
  const el  = id => document.getElementById(id);
  const bar = el('stats-bar');
  if (!bar) return;

  el('stat-dist').textContent    = routeStats.distance.toFixed(2);
  el('stat-dur').textContent     = routeStats.duration !== null ? fmtDuration(routeStats.duration) : '—';
  el('stat-gain').textContent    = routeStats.elevGain > 0 ? routeStats.elevGain : '—';
  el('stat-loss').textContent    = routeStats.elevLoss > 0 ? routeStats.elevLoss : '—';
  el('stat-maxelev').textContent = routeStats.maxElev ?? '—';
  el('stat-minelev').textContent = routeStats.minElev ?? '—';

  if (routeStats.avgSlope !== null) {
    el('stat-slope-avg').textContent  = routeStats.avgSlope.toFixed(1);
    el('stat-slope-asc').textContent  = `+${routeStats.maxSlopeAsc.toFixed(1)}`;
    el('stat-slope-desc').textContent = `${routeStats.maxSlopeDesc.toFixed(1)}`;
    el('slope-avg-span').className    = `fw-semibold text-${slopeColorClass(routeStats.avgSlope)}`;
  } else {
    el('stat-slope-avg').textContent  = '—';
    el('stat-slope-asc').textContent  = '—';
    el('stat-slope-desc').textContent = '—';
    el('slope-avg-span').className    = 'fw-semibold text-muted';
  }

  bar.classList.remove('d-none');
}

function slopeColorClass(pct) {
  const v = Math.abs(pct || 0);
  if (v < 10) return 'success';
  if (v < 20) return 'warning';
  if (v < 30) return 'orange';
  return 'danger';
}

function fmtDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}

// ── Waypoint list UI ──────────────────────────────────────────────────────

function updateWpList() {
  const list  = document.getElementById('wp-list');
  const empty = document.getElementById('wp-empty');
  const count = document.getElementById('wp-count');
  if (!list) return;

  count.textContent = waypoints.length;
  if (!waypoints.length) {
    list.innerHTML      = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = waypoints.map((wp, i) => {
    const isEnd    = i === waypoints.length - 1 && i > 0;
    const dotClass = i === 0 ? 'wp-dot-start' : isEnd ? 'wp-dot-end' : 'wp-dot-mid';
    return `
      <div class="wp-list-row">
        <span class="wp-dot ${dotClass}">${i + 1}</span>
        <span class="wp-list-name">${escapeHtml(wp.name)}</span>
        <button class="wp-del-btn" onclick="removeWaypoint(${wp.id})">
          <i class="bi bi-x"></i>
        </button>
      </div>`;
  }).join('');

  updateBtnState();
}

function updateBtnState() {
  const hasWps = waypoints.length > 0;
  document.getElementById('btn-undo').disabled  = !hasWps;
  document.getElementById('btn-clear').disabled = !hasWps && !selectedOsmTrail && routeGeometry === null;
  document.getElementById('btn-save').disabled  = routeGeometry === null;
}

// ── Search ────────────────────────────────────────────────────────────────

async function search(query) {
  if (!query.trim()) return;
  try {
    const res = await fetch(
      `${NOMIN}/search?q=${encodeURIComponent(query)}&format=json&limit=6&accept-language=it`,
      { headers: { 'User-Agent': 'HikePath/1.0' } }
    );
    showSearchResults(await res.json());
  } catch (err) { console.error('Search error', err); }
}

function showSearchResults(results) {
  const box = document.getElementById('search-results');
  if (!results.length) { box.style.display = 'none'; return; }
  box.innerHTML = results.map(r => {
    const name = r.display_name.split(',').slice(0, 2).join(', ');
    return `<button class="list-group-item list-group-item-action text-start small py-2"
      onclick="selectResult(${r.lat},${r.lon},'${escapeHtml(r.display_name.split(',')[0])}')">
      <i class="bi bi-geo-alt-fill text-success me-1"></i>${escapeHtml(name)}
    </button>`;
  }).join('');
  box.style.display = 'block';
}

function selectResult(lat, lon, name) {
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('search-input').value = name;
  map.setView([parseFloat(lat), parseFloat(lon)], 14);
  addWaypoint(parseFloat(lat), parseFloat(lon), name);
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetchWithTimeout(
      `${NOMIN}/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it`,
      { headers: { 'User-Agent': 'HikePath/1.0' } },
      5000
    );
    const d = await res.json();
    return d.address?.road || d.address?.hamlet || d.address?.village ||
           d.address?.town || d.address?.city || d.name ||
           `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ── Save ──────────────────────────────────────────────────────────────────

document.getElementById('save-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-save');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Salvo…';

  const hazards = [...document.querySelectorAll('.hazard-cb:checked')].map(cb => cb.value);

  const payload = {
    name:               document.getElementById('route-name').value.trim(),
    description:        document.getElementById('route-desc').value.trim(),
    difficulty:         document.getElementById('route-diff').value,
    trail_type:         document.getElementById('route-trail-type').value,
    route_type_tag:     document.getElementById('route-type-tag').value,
    surface:            document.getElementById('route-surface').value,
    ferrata_grade:      document.getElementById('route-ferrata-grade')?.value || null,
    hazards,
    distance_km:        routeStats.distance,
    duration_min:       routeStats.duration,
    elevation_gain_m:   routeStats.elevGain,
    elevation_loss_m:   routeStats.elevLoss,
    max_elevation_m:    routeStats.maxElev,
    min_elevation_m:    routeStats.minElev,
    avg_slope_pct:      routeStats.avgSlope,
    max_slope_asc_pct:  routeStats.maxSlopeAsc  !== null ? Math.round(routeStats.maxSlopeAsc  * 10) / 10 : null,
    max_slope_desc_pct: routeStats.maxSlopeDesc !== null ? Math.round(routeStats.maxSlopeDesc * 10) / 10 : null,
    waypoints:          buildSaveWaypoints(),
    geometry:           routeGeometry,
  };

  const editId = window.PRELOAD_ROUTE?.id;
  const url    = editId ? `/api/routes/${editId}` : '/api/routes';
  const method = editId ? 'PUT' : 'POST';

  try {
    const res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      window.location.href = `/routes/${data.id}`;
    } else {
      alert('Errore: ' + (data.error || 'sconosciuto'));
      btn.disabled  = false;
      btn.innerHTML = '<i class="bi bi-floppy me-1"></i>Salva percorso';
    }
  } catch {
    alert('Errore di rete.');
    btn.disabled  = false;
    btn.innerHTML = '<i class="bi bi-floppy me-1"></i>Salva percorso';
  }
});

// ── Load existing route ───────────────────────────────────────────────────

function loadSavedRouteStats(route) {
  routeStats.distance = Number(route.distance_km) || 0;
  routeStats.duration = route.duration_min != null ? Number(route.duration_min) : null;
  routeStats.elevGain = Number(route.elevation_gain_m) || 0;
  routeStats.elevLoss = Number(route.elevation_loss_m) || 0;
  routeStats.maxElev = route.max_elevation_m ?? null;
  routeStats.minElev = route.min_elevation_m ?? null;
  routeStats.avgSlope = route.avg_slope_pct ?? null;
  routeStats.maxSlopeAsc = route.max_slope_asc_pct ?? null;
  routeStats.maxSlopeDesc = route.max_slope_desc_pct ?? null;
  routeStats.elevSeries = [];
  routeStats.slopeSeries = [];
  routeStats.visualSlopeSeries = [];
}

async function loadExistingRoute(route) {
  routeSource = inferRouteSource(route);
  document.getElementById('route-name').value       = route.name || '';
  document.getElementById('route-desc').value       = route.description || '';
  document.getElementById('route-diff').value       = route.difficulty || 'medium';
  document.getElementById('route-trail-type').value = route.trail_type || 'E';
  document.getElementById('route-type-tag').value   = route.route_type_tag || 'punto_punto';
  document.getElementById('route-surface').value    = route.surface || 'sentiero';
  if (route.ferrata_grade) {
    document.getElementById('route-ferrata-grade').value = route.ferrata_grade;
    document.getElementById('ferrata-row').classList.remove('d-none');
  }
  (route.hazards || []).forEach(h => {
    const cb = document.querySelector(`.hazard-cb[value="${h}"]`);
    if (cb) cb.checked = true;
  });
  loadSavedRouteStats(route);

  if (isValidRouteGeometry(route.geometry)) {
    routeGeometry = route.geometry;
    drawRoute();
    updateStatsBar();
    updateBtnState();

    const savedWaypoints = (route.waypoints || []).length
      ? route.waypoints
      : technicalWaypointsFromGeometry(route.geometry);
    for (const wp of savedWaypoints) {
      await addWaypoint(wp.lat, wp.lng, wp.name, { skipRouteCalc: true });
    }
    return;
  }

  for (const wp of (route.waypoints || [])) {
    await addWaypoint(wp.lat, wp.lng, wp.name);
  }
}

// ── Controls ──────────────────────────────────────────────────────────────

function bindControls() {
  document.getElementById('btn-undo')?.addEventListener('click', undoLast);
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Rimuovere waypoint, percorso e selezione OSM?')) clearAll();
  });
  const searchInput = document.getElementById('search-input');
  document.getElementById('search-btn')?.addEventListener('click', () => search(searchInput.value));
  searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') search(searchInput.value); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-input') && !e.target.closest('#search-results'))
      document.getElementById('search-results').style.display = 'none';
  });
}

// ── Spinner & status ──────────────────────────────────────────────────────

function showSpinner(text = 'Calcolo percorso…') {
  const sp = document.getElementById('map-spinner');
  const tx = document.getElementById('spinner-text');
  if (tx) tx.textContent = text;
  if (sp) sp.style.display = 'flex';
}

function hideSpinner() {
  const sp = document.getElementById('map-spinner');
  if (sp) sp.style.display = 'none';
}

function setStatus(msg, type = '') {
  const bar   = document.getElementById('status-bar');
  const msgEl = document.getElementById('status-msg');
  if (!bar || !msgEl) return;
  if (!msg) { bar.classList.add('d-none'); return; }
  msgEl.textContent = msg;
  msgEl.className   = `small text-${type || 'muted'}`;
  bar.classList.remove('d-none');
}

// ── Network utilities ─────────────────────────────────────────────────────

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
  ]);
}

// ── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
