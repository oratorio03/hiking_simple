// ── Constants ─────────────────────────────────────────────────────────────
const BROUTER      = 'https://brouter.de/brouter';
const OSRM         = 'https://router.project-osrm.org/route/v1/foot';
const NOMIN        = 'https://nominatim.openstreetmap.org';
const OVERPASS     = 'https://overpass-api.de/api/interpreter';
const TOPO_API     = 'https://api.opentopodata.org/v1/srtm30m';
const ELEV_FALLBACK = 'https://api.open-elevation.com/api/v1/lookup';
const MIN_SLOPE_SEGMENT_M = 25;
const OSM_ELEV_SAMPLE_INTERVAL_M = 40;
const OSM_RELIABLE_SLOPE_SEGMENT_M = 100;
const VISUAL_SLOPE_CLAMP_PCT = 50;
const GPX_MAX_FILE_BYTES = 15 * 1024 * 1024;
const GPX_MAX_POINTS = 5000;
const GPX_ELEV_THRESHOLD_M = 8;
const SAVED_ROUTE_COLOR = '#6f42c1';
const NEARBY_RADIUS_KM = 25;
const TECHNICAL_WAYPOINT_NAMES = {
  osm_single: ['Inizio sentiero OSM', 'Fine sentiero OSM'],
  gpx: ['Inizio traccia GPX', 'Fine traccia GPX']
};

// ── State ─────────────────────────────────────────────────────────────────
let map, routeLayer, osmTrailsLayer, elevChart, slopeChart;
let chartHoverMarker = null;
let elevSampleCoords = null;
let waypoints     = [];
let routeGeometry = null;
let osmTrailsVisible = false;
let selectedOsmTrail = null;
let routeSource = 'manual'; // 'manual' | 'osm_single' | 'osm_composed' | 'gpx'
let routeAnalysisId = 0;
let savedRouteLayer = null;
let placeMarker = null;
let myRoutesLayer = null;
let myRoutesVisible = false;
let searchRequestId = 0;
let nearbyRequestId = 0;
let routeProfile  = 'hiking';   // 'hiking' | 'trekking' | 'safety'
let routeStats    = {
  distance: 0, duration: 0,
  elevGain: 0, elevLoss: 0, maxElev: null, minElev: null,
  avgSlope: null, maxSlopeAsc: null, maxSlopeDesc: null,
  elevSeries: [], slopeSeries: [], slopeSeriesRaw: [], slopeSeriesReliable: [],
  visualSlopeSeries: [], slopeQuality: null, equivalentSlopePct: null,
  displayedSlopeStats: null
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

  map.setView([45.8, 10.0], 9);
  let viewMoved = false;
  map.once('movestart', () => { viewMoved = true; });
  savedRouteLayer = L.layerGroup().addTo(map);
  navigator.geolocation?.getCurrentPosition(p => {
    // A late fix must not pull the map away from what the user is already looking at.
    if (!viewMoved && routeGeometry === null && !waypoints.length && !osmTrailsVisible && !myRoutesVisible &&
        !placeMarker && !savedRouteLayer.getLayers().length) {
      map.setView([p.coords.latitude, p.coords.longitude], 13);
    }
  }, null, { timeout: 10000, maximumAge: 300000 });

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
  if (!name) {
    name = await reverseGeocode(lat, lng);
    // A GPX or OSM route may have replaced the manual route while the name was loading.
    if (routeSource !== 'manual') return;
  }

  const id     = Date.now() + Math.random();
  const marker = makeMarker(lat, lng, waypoints.length, name);
  marker.addTo(map);

  const wp = { id, lat, lng, name, marker };
  waypoints.push(wp);

  marker.on('dragend', async () => {
    const pos = marker.getLatLng();
    wp.lat = pos.lat; wp.lng = pos.lng;
    wp.name = await reverseGeocode(pos.lat, pos.lng);
    marker.setPopupContent(escapeHtml(wp.name));
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
  return L.marker([lat, lng], { draggable: true, icon }).bindPopup(escapeHtml(name));
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
    wp.marker.setPopupContent(escapeHtml(wp.name));
  });
}

// ── Brouter routing (primary) ─────────────────────────────────────────────

async function calcRoute() {
  if (waypoints.length < 2) return;
  routeSource = 'manual';
  const analysisId = ++routeAnalysisId;
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
    if (isStaleRouteCalc(analysisId)) return;
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
      await fetchElevation({ analysisId });
    }

  } catch (err) {
    if (isStaleRouteCalc(analysisId)) return;
    console.warn('Brouter failed, falling back to OSRM:', err.message);
    setStatus('Brouter non raggiungibile, uso routing alternativo…', 'muted');
    await calcRouteOSRM(analysisId);
  }
}

function isStaleRouteCalc(analysisId) {
  if (analysisId === routeAnalysisId) return false;
  hideSpinner();
  return true;
}

// ── OSRM routing (fallback) ───────────────────────────────────────────────

async function calcRouteOSRM(analysisId) {
  const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  try {
    const res  = await fetchWithTimeout(
      `${OSRM}/${coords}?overview=full&geometries=geojson`, {}, 12000
    );
    const data = await res.json();
    if (isStaleRouteCalc(analysisId)) return;

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
    await fetchElevation({ analysisId });

  } catch (err) {
    if (isStaleRouteCalc(analysisId)) return;
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
      btn.className = 'btn btn-sm btn-outline-success flex-fill';
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
      btn.className = 'btn btn-sm btn-success flex-fill';
      btn.innerHTML = '<i class="bi bi-eye-slash me-1"></i>Nascondi sentieri OSM';
    }
    setStatus(`${geojson.features.length} sentieri OSM caricati nella zona visibile.`, 'success');
  } catch (err) {
    console.warn('OSM trails load failed:', err);
    if (btn) {
      btn.disabled = false;
      btn.className = 'btn btn-sm btn-outline-success flex-fill';
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
  routeStats = blankRouteStats(selectedOsmTrail.lengthKm || estimateLineLengthKm(routeGeometry) || 0);
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

function blankRouteStats(distance) {
  return {
    distance,
    duration: null,
    elevGain: 0,
    elevLoss: 0,
    maxElev: null,
    minElev: null,
    avgSlope: null,
    maxSlopeAsc: null,
    maxSlopeDesc: null,
    elevSeries: [],
    slopeSeriesRaw: [],
    slopeSeriesReliable: [],
    slopeSeries: [],
    visualSlopeSeries: [],
    slopeQuality: null,
    equivalentSlopePct: null,
    displayedSlopeStats: null
  };
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
    elevSeries: [], slopeSeries: [], slopeSeriesRaw: [], slopeSeriesReliable: [],
    visualSlopeSeries: [], slopeQuality: null, equivalentSlopePct: null,
    displayedSlopeStats: null
  };
  document.getElementById('stats-bar')?.classList.add('d-none');
  document.getElementById('chart-panel')?.classList.add('d-none');
  setStatus('', '');
  updateBtnState();
}

// ── GPX import ────────────────────────────────────────────────────────────

function parseGpx(text, fallbackName = '') {
  // GPX never needs a DTD; refusing it keeps the XML parser from resolving external entities.
  if (text.includes('<!DOCTYPE')) throw new Error('File GPX non valido: dichiarazione DOCTYPE non supportata.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagNameNS('*', 'parsererror').length) {
    throw new Error('File GPX non valido: XML malformato.');
  }

  const byTag = tag => Array.from(doc.getElementsByTagNameNS('*', tag));
  let pointEls = byTag('trkpt');
  if (!pointEls.length) pointEls = byTag('rtept');
  if (!pointEls.length) throw new Error('Nessuna traccia trovata nel file GPX.');

  const points = [];
  for (const el of pointEls) {
    const lat = parseGpxNumber(el.getAttribute('lat'));
    const lon = parseGpxNumber(el.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const prev = points[points.length - 1];
    if (prev && prev.lat === lat && prev.lon === lon) continue;
    const ele = parseGpxNumber(gpxChild(el, 'ele')?.textContent);
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  if (points.length < 2) throw new Error('La traccia GPX contiene meno di 2 punti validi.');

  const hasElevation = points.filter(p => p.ele !== null).length >= points.length * 0.9;
  const elevs = hasElevation ? fillElevationGaps(points.map(p => p.ele)) : null;
  let coords = points.map((p, i) => hasElevation ? [p.lon, p.lat, elevs[i]] : [p.lon, p.lat]);
  if (coords.length > GPX_MAX_POINTS) {
    const step = (coords.length - 1) / (GPX_MAX_POINTS - 1);
    coords = Array.from({ length: GPX_MAX_POINTS }, (_, i) => coords[Math.round(i * step)]);
  }

  // GPX 1.0 keeps name/desc directly under <gpx> instead of <metadata>.
  const root = doc.documentElement;
  const metadata = gpxChild(root, 'metadata');
  const firstTrk = byTag('trk')[0];
  const firstRte = byTag('rte')[0];
  return {
    name: gpxChildText(metadata, 'name') || gpxChildText(root, 'name') ||
      gpxChildText(firstTrk, 'name') || gpxChildText(firstRte, 'name') || fallbackName,
    desc: gpxChildText(metadata, 'desc') || gpxChildText(root, 'desc') || gpxChildText(firstTrk, 'desc'),
    coords,
    hasElevation,
    pointCount: coords.length
  };
}

function parseGpxNumber(value) {
  return value != null && String(value).trim() !== '' ? Number(value) : NaN;
}

function gpxChild(el, tag) {
  return el ? Array.from(el.children).find(c => c.localName === tag) || null : null;
}

function gpxChildText(el, tag) {
  return gpxChild(el, tag)?.textContent.trim() || '';
}

function fillElevationGaps(elevs) {
  const filled = elevs.slice();
  let prev = -1;
  for (let i = 0; i <= filled.length; i++) {
    if (i < filled.length && filled[i] === null) continue;
    for (let j = prev + 1; j < i; j++) {
      if (prev < 0) filled[j] = filled[i];
      else if (i === filled.length) filled[j] = filled[prev];
      else filled[j] = filled[prev] + (filled[i] - filled[prev]) * (j - prev) / (i - prev);
    }
    prev = i;
  }
  return filled;
}

async function importGpxFile(file) {
  const input = document.getElementById('gpx-file');
  if (input) input.value = '';
  if (!file) return;
  if (file.size > GPX_MAX_FILE_BYTES) {
    setStatus('File GPX troppo grande (massimo 15 MB).', 'danger');
    return;
  }

  let text;
  try {
    text = decodeGpxBytes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    setStatus('Impossibile leggere il file GPX.', 'danger');
    return;
  }

  let parsed;
  try {
    parsed = parseGpx(text, file.name.replace(/\.[^.]*$/, ''));
  } catch (err) {
    setStatus(err.message, 'danger');
    return;
  }

  clearManualWaypoints();
  clearOsmTrailSelection();
  map.closePopup();
  routeSource = 'gpx';
  routeGeometry = { type: 'LineString', coordinates: parsed.coords };
  routeStats = blankRouteStats(estimateLineLengthKm(routeGeometry) || 0);
  clearChartRouteMarker();
  document.getElementById('chart-panel')?.classList.add('d-none');
  const analysisId = ++routeAnalysisId;
  drawRoute();
  updateStatsBar();
  updateWpList();
  updateBtnState();
  prefillEmptyField('route-name', parsed.name);
  prefillEmptyField('route-desc', parsed.desc);
  setStatus('Analisi altimetrica della traccia GPX...', 'muted');

  // 3D tracks take fetchElevation's file-elevation branch, so no network request is made.
  const hasElevation = await fetchElevation({
    loadingText: 'Analisi altimetrica della traccia GPX...',
    fallbackText: 'Tentativo con API altimetrica alternativa...',
    failureText: 'Dati altimetrici non disponibili per questa traccia GPX.',
    analysisId
  });
  if (analysisId !== routeAnalysisId) return;

  routeStats.duration = estimateWalkingMinutes(routeStats.distance, routeStats.elevGain, routeStats.elevLoss);
  updateStatsBar();
  const importedText = `Traccia GPX importata (${parsed.pointCount.toLocaleString('it-IT')} punti).`;
  if (hasElevation) setStatus(`${importedText}${slopeQualityText()}`, 'success');
  else setStatus(`${importedText} Dati altimetrici non disponibili.`, 'warning');
}

function decodeGpxBytes(bytes) {
  let label = 'utf-8';
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) label = 'utf-16le';
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) label = 'utf-16be';
  else {
    const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 200));
    const declared = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/)?.[1];
    // A declaration readable as ASCII means the bytes can't be UTF-16, whatever it claims.
    if (declared && !/16/.test(declared)) label = declared;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function prefillEmptyField(id, value) {
  const el = document.getElementById(id);
  if (!el || !value || el.value.trim()) return;
  el.value = el.maxLength > 0 ? value.slice(0, el.maxLength) : value;
}

function extractFileElevation(coords) {
  const sampled = resampleLineStringByDistance(coords, OSM_ELEV_SAMPLE_INTERVAL_M);
  const elevs = sampled.map(c => c[2]);
  if (elevs.length < 2 || !elevs.every(Number.isFinite)) return null;
  processElevation(elevs, sampled, { source: 'gpx' });
  return elevs;
}

// DIN 33466 hiking time.
function estimateWalkingMinutes(distanceKm, gainM, lossM) {
  const horizontalH = (distanceKm || 0) / 4;
  const verticalH = (gainM || 0) / 300 + (lossM || 0) / 500;
  return (Math.max(horizontalH, verticalH) + Math.min(horizontalH, verticalH) / 2) * 60;
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
  elevSampleCoords = null;

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

  const coords = routeGeometry.coordinates;
  const sampled = getElevationSampleCoords(coords);

  // If Brouter or the GPX file already embedded elevation, use it
  if (sampled[0]?.length >= 3 && sampled[0][2] != null) {
    if (!isCurrentAnalysis()) return false;
    const elevs = routeSource === 'gpx' ? extractFileElevation(coords) : extractBrouterElevation(coords, {});
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

  processElevation(elevs, sampled, { source: routeSource });
  drawElevChart(elevs);
  drawSlopeChart(routeStats.slopeSeries);
  updateStatsBar();
  document.getElementById('chart-panel')?.classList.remove('d-none');
  if (successText) setStatus(`${successText}${slopeQualityText()}`, 'success');
  return true;
}

function slopeQualityText() {
  if (routeStats.slopeQuality === 'rumorosa') {
    return ' Pendenza reale non affidabile: dati altimetrici rumorosi. Mostro pendenza equivalente netta.';
  }
  return routeStats.slopeQuality ? ' Pendenza stimata da dati altimetrici, possibili errori.' : '';
}

function reloadElevation() {
  fetchElevation();
}

function getElevationSampleCoords(coords) {
  if (routeSource === 'osm_single') {
    return resampleLineStringByDistance(coords, OSM_ELEV_SAMPLE_INTERVAL_M);
  }

  const step = Math.max(1, Math.floor(coords.length / 50));
  const sampled = coords.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
  }
  return sampled;
}

function resampleLineStringByDistance(coords, intervalM) {
  if (!coords || coords.length < 2) return coords || [];

  const sampled = [coords[0]];
  let lastSample = coords[0];
  let carryM = 0;

  for (let i = 1; i < coords.length; i++) {
    let segStart = coords[i - 1];
    const segEnd = coords[i];
    let segLenM = haversineMeters(segStart[1], segStart[0], segEnd[1], segEnd[0]);
    if (!segLenM || !isFinite(segLenM)) continue;

    while (carryM + segLenM >= intervalM) {
      const remainingM = intervalM - carryM;
      const ratio = remainingM / segLenM;
      const nextSample = interpolateCoord(segStart, segEnd, ratio);
      sampled.push(nextSample);
      lastSample = nextSample;
      segStart = nextSample;
      segLenM = haversineMeters(segStart[1], segStart[0], segEnd[1], segEnd[0]);
      carryM = 0;
    }

    carryM += segLenM;
  }

  const end = coords[coords.length - 1];
  const endGapM = haversineMeters(lastSample[1], lastSample[0], end[1], end[0]);
  if (endGapM > 1) sampled.push(end);
  return sampled;
}

function interpolateCoord(a, b, ratio) {
  const point = [
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio
  ];
  if (Number.isFinite(a[2]) && Number.isFinite(b[2])) point.push(a[2] + (b[2] - a[2]) * ratio);
  return point;
}

function hasNoisyElevation(source) {
  return source === 'osm_single' || source === 'gpx';
}

function processElevation(elevs, coords = null, options = {}) {
  const noisy = hasNoisyElevation(options.source);
  const statsElevs = noisy ? smoothElevationSeries(elevs, 3) : elevs;
  routeStats.elevSeries = elevs;
  elevSampleCoords = coords;
  routeStats.maxElev    = Math.round(Math.max(...statsElevs));
  routeStats.minElev    = Math.round(Math.min(...statsElevs));
  routeStats.equivalentSlopePct = calculateEquivalentSlope(statsElevs);

  const { gain, loss } = sumElevationChanges(statsElevs, options.source === 'gpx' ? GPX_ELEV_THRESHOLD_M : 0);
  routeStats.elevGain = Math.round(gain);
  routeStats.elevLoss = Math.round(loss);

  updateSlopeStats(coords, statsElevs, {
    rawElevs: elevs,
    source: options.source
  });
}

// Climbs and descents count between turning points at least thresholdM apart, so GPS altitude jitter does not add up.
function sumElevationChanges(elevs, thresholdM) {
  let gain = 0, loss = 0, turn = elevs[0], extreme = elevs[0];
  for (let i = 1; i < elevs.length; i++) {
    const e = elevs[i];
    if (extreme >= turn ? e >= extreme : e <= extreme) {
      extreme = e;
    } else if (Math.abs(e - extreme) >= thresholdM) {
      if (extreme > turn) gain += extreme - turn; else loss += turn - extreme;
      turn = extreme;
      extreme = e;
    }
  }
  if (extreme > turn) gain += extreme - turn; else loss += turn - extreme;
  return { gain, loss };
}

function calculateEquivalentSlope(elevs) {
  if (!elevs || elevs.length < 2 || !routeStats.distance) return null;
  // Net start/end grade: useful as a fallback when real local slope is too noisy,
  // but it can understate routes with repeated climbs and descents.
  const netGainM = elevs[elevs.length - 1] - elevs[0];
  return Math.round((netGainM / (routeStats.distance * 1000)) * 1000) / 10;
}

// ── Charts ────────────────────────────────────────────────────────────────

function updateSlopeStats(coords, elevs, options = {}) {
  const noisy = hasNoisyElevation(options.source);
  const rawSlopes = buildSlopeSeries(coords, options.rawElevs || elevs, MIN_SLOPE_SEGMENT_M);
  const reliableSlopes = noisy
    ? buildSlopeSeries(coords, elevs, OSM_RELIABLE_SLOPE_SEGMENT_M)
    : rawSlopes;

  routeStats.slopeSeriesRaw = rawSlopes;
  routeStats.slopeSeriesReliable = reliableSlopes;
  routeStats.slopeSeries = reliableSlopes;
  routeStats.visualSlopeSeries = buildVisualSlopeSeries(reliableSlopes);
  routeStats.slopeQuality = assessSlopeQuality(rawSlopes, reliableSlopes, coords, noisy);
  routeStats.displayedSlopeStats = buildDisplayedSlopeStats(reliableSlopes, routeStats.slopeQuality, noisy);

  routeStats.avgSlope = routeStats.displayedSlopeStats?.avg ?? null;
  routeStats.maxSlopeAsc = routeStats.displayedSlopeStats?.maxAsc ?? null;
  routeStats.maxSlopeDesc = routeStats.displayedSlopeStats?.maxDesc ?? null;
}

function buildSlopeSeries(coords, elevs, minSegmentM = MIN_SLOPE_SEGMENT_M) {
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

    if (distBucket < minSegmentM && i < elevs.length - 1) continue;

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

function assessSlopeQuality(rawSlopes, reliableSlopes, coords, noisy) {
  if (!noisy) return null;
  if (!coords || coords.length < 5 || routeStats.distance < 0.3 || reliableSlopes.length < 2) {
    return 'limitata';
  }

  const suspiciousCount = rawSlopes.filter(s => Math.abs(s) > 40).length;
  const unrealisticCount = rawSlopes.filter(s => Math.abs(s) > VISUAL_SLOPE_CLAMP_PCT).length;
  const unstableRatio = rawSlopes.length ? unrealisticCount / rawSlopes.length : 0;
  const suspiciousRatio = rawSlopes.length ? suspiciousCount / rawSlopes.length : 0;
  const maxRaw = rawSlopes.length ? Math.max(...rawSlopes.map(Math.abs)) : 0;
  const maxReliable = reliableSlopes.length ? Math.max(...reliableSlopes.map(Math.abs)) : 0;

  if (unstableRatio > 0.2 || suspiciousRatio > 0.35 || maxReliable > 40 ||
      (maxRaw > 70 && maxRaw > maxReliable * 2.5)) {
    return 'rumorosa';
  }
  return 'stimata';
}

function buildDisplayedSlopeStats(reliableSlopes, slopeQuality, noisy) {
  if (!reliableSlopes.length) {
    return { usable: false, label: 'non disponibile', avg: null, maxAsc: null, maxDesc: null };
  }

  if (!noisy) {
    const absSlopes = reliableSlopes.map(Math.abs);
    return {
      usable: true,
      label: null,
      avg: Math.round((absSlopes.reduce((a, b) => a + b, 0) / absSlopes.length) * 10) / 10,
      maxAsc: Math.max(...reliableSlopes),
      maxDesc: Math.min(...reliableSlopes)
    };
  }

  if (slopeQuality === 'rumorosa') {
    return {
      usable: false,
      label: 'dato rumoroso',
      equivalentSlope: routeStats.equivalentSlopePct,
      avg: null,
      maxAsc: null,
      maxDesc: null
    };
  }

  if (slopeQuality === 'limitata') {
    return {
      usable: false,
      label: 'non affidabile',
      equivalentSlope: routeStats.equivalentSlopePct,
      avg: null,
      maxAsc: null,
      maxDesc: null
    };
  }

  const filtered = reliableSlopes.filter(s => Number.isFinite(s) && Math.abs(s) <= 40);
  if (filtered.length < 2) {
    return { usable: false, label: 'non affidabile', avg: null, maxAsc: null, maxDesc: null };
  }

  const positives = filtered.filter(s => s > 0);
  const negatives = filtered.filter(s => s < 0);
  const absSlopes = filtered.map(Math.abs);
  return {
    usable: true,
    label: 'stimata',
    avg: Math.round((absSlopes.reduce((a, b) => a + b, 0) / absSlopes.length) * 10) / 10,
    maxAsc: positives.length ? percentile(positives, 0.85) : 0,
    maxDesc: negatives.length ? percentile(negatives, 0.15) : 0
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return Math.round(sorted[idx] * 10) / 10;
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

function smoothElevationSeries(elevs, windowSize = 3) {
  if (!elevs.length || windowSize <= 1) return elevs;
  const smoothed = smoothSeries(elevs, windowSize);
  smoothed[0] = elevs[0];
  smoothed[smoothed.length - 1] = elevs[elevs.length - 1];
  return smoothed;
}

function isValidRouteGeometry(geometry) {
  return geometry?.type === 'LineString' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length >= 2;
}

function technicalWaypointsFromGeometry(geometry, [startName, endName]) {
  if (!isValidRouteGeometry(geometry)) return [];

  const coords = geometry.coordinates;
  const start = coords[0];
  const end = coords[coords.length - 1];
  if (!start || !end || start[0] == null || start[1] == null || end[0] == null || end[1] == null) {
    return [];
  }

  return [
    { lat: start[1], lng: start[0], name: startName },
    { lat: end[1], lng: end[0], name: endName }
  ];
}

function buildSaveWaypoints() {
  const manualWaypoints = waypoints.map(({ lat, lng, name }) => ({ lat, lng, name }));
  const technicalNames = TECHNICAL_WAYPOINT_NAMES[routeSource];
  if (manualWaypoints.length || !technicalNames) return manualWaypoints;
  return technicalWaypointsFromGeometry(routeGeometry, technicalNames);
}

function inferRouteSource(route) {
  const savedWaypoints = route.waypoints || [];
  if (!isValidRouteGeometry(route.geometry) || savedWaypoints.length !== 2) return 'manual';

  return Object.keys(TECHNICAL_WAYPOINT_NAMES).find(source => {
    const [startName, endName] = TECHNICAL_WAYPOINT_NAMES[source];
    return savedWaypoints[0]?.name === startName && savedWaypoints[1]?.name === endName;
  }) || 'manual';
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
  const elev = routePoint.elev ?? routeStats.elevSeries?.[index];
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
  // Elevation samples can be spaced by distance rather than by vertex, so map onto them when known.
  const samples = elevSampleCoords?.length ? elevSampleCoords : null;
  const coords = samples || routeGeometry?.coordinates;
  if (!coords || !coords.length || !totalPoints) return null;

  const ratio = totalPoints <= 1 ? 0 : index / (totalPoints - 1);
  const routeIndex = Math.max(0, Math.min(
    coords.length - 1,
    Math.round(ratio * (coords.length - 1))
  ));

  const coord = coords[routeIndex];
  return { coord, ratio, elev: samples ? routeStats.elevSeries[routeIndex] : coord[2] };
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
  const slopeAvgLabel = el('slope-avg-label');
  const slopeAvgUnit = el('stat-slope-avg-unit');
  const slopeAscUnit = el('stat-slope-asc-unit');
  const slopeDescUnit = el('stat-slope-desc-unit');

  const displaySlope = routeStats.displayedSlopeStats;
  if (displaySlope && !displaySlope.usable) {
    const hasEquivalent = displaySlope.equivalentSlope !== null && displaySlope.equivalentSlope !== undefined;
    if (slopeAvgLabel) slopeAvgLabel.textContent = hasEquivalent ? 'eq.' : '∅';
    if (slopeAvgUnit) slopeAvgUnit.style.display = hasEquivalent ? '' : 'none';
    if (slopeAscUnit) slopeAscUnit.style.display = 'none';
    if (slopeDescUnit) slopeDescUnit.style.display = 'none';
    el('stat-slope-avg').textContent  = hasEquivalent
      ? displaySlope.equivalentSlope.toFixed(1)
      : displaySlope.label;
    el('stat-slope-asc').textContent  = 'non affidabile';
    el('stat-slope-desc').textContent = 'non affidabile';
    el('slope-avg-span').className    = 'fw-semibold text-muted';
  } else if (routeStats.avgSlope !== null) {
    if (slopeAvgLabel) slopeAvgLabel.textContent = '∅';
    if (slopeAvgUnit) slopeAvgUnit.style.display = '';
    if (slopeAscUnit) slopeAscUnit.style.display = '';
    if (slopeDescUnit) slopeDescUnit.style.display = '';
    el('stat-slope-avg').textContent  = routeStats.avgSlope.toFixed(1);
    el('stat-slope-asc').textContent  = routeStats.maxSlopeAsc !== null ? `+${routeStats.maxSlopeAsc.toFixed(1)}` : '—';
    el('stat-slope-desc').textContent = routeStats.maxSlopeDesc !== null ? `${routeStats.maxSlopeDesc.toFixed(1)}` : '—';
    el('slope-avg-span').className    = `fw-semibold text-${slopeColorClass(routeStats.avgSlope)}`;
  } else {
    if (slopeAvgLabel) slopeAvgLabel.textContent = '∅';
    if (slopeAvgUnit) slopeAvgUnit.style.display = '';
    if (slopeAscUnit) slopeAscUnit.style.display = '';
    if (slopeDescUnit) slopeDescUnit.style.display = '';
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

// Explicit submit only: Nominatim's usage policy forbids search-as-you-type.
async function search(query) {
  query = query.trim();
  if (!query) return;
  const requestId = ++searchRequestId;
  const routesRequest = fetchOwnRoutes({ q: query, limit: 10 });
  const placesRequest = searchPlaces(query);
  showSearchResults({ routes: [], places: [], pending: 'Cerco…' });
  // Own routes come from our server and are usually ready long before Nominatim answers.
  routesRequest.then(routes => {
    if (requestId === searchRequestId) showSearchResults({ routes, places: [], pending: 'Cerco luoghi…' });
  }, () => {});
  const [routes, places] = await Promise.allSettled([routesRequest, placesRequest]);
  if (requestId !== searchRequestId) return;
  if (routes.status === 'rejected') console.warn('Own route search failed', routes.reason);
  if (places.status === 'rejected') console.warn('Place search failed', places.reason);
  showSearchResults({
    routes: routes.value || [],
    places: places.value || [],
    routesFailed: routes.status === 'rejected',
    placesFailed: places.status === 'rejected'
  });
}

async function fetchOwnRoutes(params) {
  const res = await fetchWithTimeout(`/api/routes/search?${new URLSearchParams(params)}`, {}, 10000);
  if (!res.ok) throw new Error(`Route search HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function searchPlaces(query) {
  const res = await fetchWithTimeout(
    `${NOMIN}/search?q=${encodeURIComponent(query)}&format=json&limit=6&accept-language=it`,
    { headers: { 'User-Agent': 'HikePath/1.0' } },
    10000
  );
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Nominatim: unexpected response');
  return data.map(r => {
    const parts = String(r.display_name || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      name: parts[0] || query,
      label: parts.slice(0, 2).join(', ') || query
    };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

function showSearchResults({ routes, places, routesFailed, placesFailed, pending }) {
  const box = document.getElementById('search-results');
  box.replaceChildren();
  if (routes.length) {
    box.appendChild(searchGroupHeader('bi-signpost-split saved-route-icon', 'I tuoi percorsi'));
    routes.forEach(route => box.appendChild(searchResultButton(route.name, savedRouteSummary(route), () => {
      searchRequestId += 1;
      closeSearchResults();
      showSavedRouteOnMap(route);
    })));
  }
  if (places.length) {
    box.appendChild(searchGroupHeader('bi-geo-alt-fill text-success', 'Luoghi'));
    places.forEach(place => box.appendChild(searchResultButton(place.label, '', () => selectPlace(place))));
  }
  if (pending) {
    const row = createEl('div', 'list-group-item small text-muted');
    row.append(createEl('span', 'spinner-border spinner-border-sm me-2'), pending);
    box.appendChild(row);
  } else if (!routes.length && !places.length) {
    box.appendChild(createEl('div', 'list-group-item small', 'Nessun risultato'));
  }
  if (routesFailed) box.appendChild(createEl('div', 'list-group-item small text-muted', 'Ricerca nei tuoi percorsi non riuscita.'));
  if (placesFailed) box.appendChild(createEl('div', 'list-group-item small text-muted', 'Ricerca luoghi non disponibile, riprova più tardi.'));
  box.style.display = 'block';
}

function searchGroupHeader(iconClass, text) {
  const header = createEl('div', 'list-group-item bg-light text-muted small fw-semibold py-1');
  header.append(createEl('i', `bi ${iconClass} me-1`), text);
  return header;
}

function searchResultButton(title, subtitle, onSelect) {
  const btn = createEl('button', 'list-group-item list-group-item-action text-start small py-2');
  btn.type = 'button';
  btn.appendChild(createEl('div', 'text-truncate', title));
  if (subtitle) btn.appendChild(createEl('div', 'text-muted', subtitle));
  btn.addEventListener('click', onSelect);
  return btn;
}

function closeSearchResults() {
  document.getElementById('search-results').style.display = 'none';
}

function selectPlace(place) {
  closeSearchResults();
  document.getElementById('search-input').value = place.name;
  map.setView([place.lat, place.lon], 14);
  showPlaceMarker(place);
  loadNearbyRoutes(place);
}

function showPlaceMarker(place) {
  clearPlaceMarker();
  const icon = L.divIcon({
    html: '<i class="bi bi-geo-alt-fill"></i>',
    className: 'place-marker', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]
  });
  placeMarker = L.marker([place.lat, place.lon], { icon, zIndexOffset: 500 })
    .bindPopup(() => placePopupContent(place))
    .addTo(map)
    .openPopup();
}

function clearPlaceMarker() {
  if (!placeMarker) return;
  map.removeLayer(placeMarker);
  placeMarker = null;
}

function placePopupContent(place) {
  const box = document.createElement('div');
  box.appendChild(createEl('strong', '', place.name));
  if (routeSource !== 'manual') return box;
  const btn = createEl('button', 'btn btn-sm btn-success w-100 mt-2');
  btn.type = 'button';
  btn.append(createEl('i', 'bi bi-plus-circle me-1'), 'Aggiungi come tappa');
  btn.addEventListener('click', () => {
    if (routeSource !== 'manual') return;
    clearPlaceMarker();
    addWaypoint(place.lat, place.lon, place.name);
  });
  box.appendChild(btn);
  return box;
}

async function loadNearbyRoutes(place) {
  const requestId = ++nearbyRequestId;
  showNearbyRoutes(place, [nearbyNote('Cerco i tuoi percorsi vicini…')]);
  try {
    const routes = await fetchOwnRoutes({ lat: place.lat, lng: place.lon, radius_km: NEARBY_RADIUS_KM });
    if (requestId !== nearbyRequestId) return;
    showNearbyRoutes(place, routes.length
      ? routes.map(nearbyRouteButton)
      : [nearbyNote(`Nessun tuo percorso entro ${NEARBY_RADIUS_KM} km`)]);
  } catch (err) {
    if (requestId !== nearbyRequestId) return;
    console.warn('Nearby route search failed', err);
    showNearbyRoutes(place, [nearbyNote('Impossibile cercare i tuoi percorsi vicini.')]);
  }
}

function showNearbyRoutes(place, items) {
  document.getElementById('nearby-title').textContent = `Percorsi vicini a ${place.name}`;
  document.getElementById('nearby-list').replaceChildren(...items);
  document.getElementById('nearby-routes').classList.remove('d-none');
}

function closeNearbyRoutes() {
  nearbyRequestId += 1;
  document.getElementById('nearby-routes').classList.add('d-none');
  document.getElementById('nearby-list').replaceChildren();
}

function nearbyNote(text) {
  return createEl('div', 'small text-muted py-1', text);
}

function nearbyRouteButton(route) {
  const btn = createEl('button', 'list-group-item list-group-item-action d-flex align-items-center gap-2 small px-2 py-1');
  btn.type = 'button';
  btn.append(
    createEl('span', 'text-truncate flex-grow-1', route.name),
    createEl('span', 'text-muted text-nowrap', formatDistanceFrom(route.distance_from_point_km))
  );
  btn.addEventListener('click', () => showSavedRouteOnMap(route));
  return btn;
}

function formatDistanceFrom(km) {
  if (!Number.isFinite(km)) return '';
  const meters = Math.round(km * 1000);
  return meters < 1000 ? `a ${meters} m` : `a ${km.toFixed(1)} km`;
}

// ── Saved routes on the map ───────────────────────────────────────────────

function savedRouteSummary(route) {
  const km = (Number(route.distance_km) || 0).toFixed(1);
  return `${km} km · +${Math.round(Number(route.elevation_gain_m) || 0)} m`;
}

function savedRoutePopup(route) {
  return `
    <div>
      <strong>${escapeHtml(route.name)}</strong>
      <div class="small text-muted">${escapeHtml(savedRouteSummary(route))}</div>
      <div class="d-flex gap-3 mt-2 small">
        <a href="${escapeHtml(route.url)}"><i class="bi bi-file-text me-1"></i>Apri scheda</a>
        <a href="${escapeHtml(route.edit_url)}"><i class="bi bi-pencil me-1"></i>Modifica</a>
      </div>
    </div>`;
}

// Saved routes never bubble clicks to the map, so they can't add waypoints to the route being edited.
function savedRouteMapLayer(route, style) {
  const coords = route.geometry?.coordinates;
  const options = { color: SAVED_ROUTE_COLOR, bubblingMouseEvents: false, ...style };
  let layer;
  if (Array.isArray(coords) && coords.length >= 2) {
    layer = L.polyline(coords.map(([lng, lat]) => [lat, lng]), { lineCap: 'round', lineJoin: 'round', ...options });
  } else if (route.start) {
    layer = L.circleMarker([route.start.lat, route.start.lng], { radius: 7, fillOpacity: 0.5, ...options });
  } else {
    return null;
  }
  return layer.bindPopup(savedRoutePopup(route));
}

function showSavedRouteOnMap(route) {
  const layer = savedRouteMapLayer(route, { weight: 5, opacity: 0.9 });
  if (!layer) return;
  savedRouteLayer.clearLayers();
  savedRouteLayer.addLayer(layer);
  if (layer.getBounds) map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 16 });
  else map.setView(layer.getLatLng(), 14);
  layer.openPopup();
}

async function toggleMyRoutes() {
  const btn = document.getElementById('btn-my-routes');
  if (myRoutesVisible) {
    map.removeLayer(myRoutesLayer);
    myRoutesVisible = false;
    updateMyRoutesButton();
    return;
  }

  if (!myRoutesLayer) {
    btn.disabled = true;
    btn.replaceChildren(createEl('span', 'spinner-border spinner-border-sm me-1'), 'Carico i tuoi percorsi…');
    try {
      const editId = window.PRELOAD_ROUTE?.id;
      const routes = (await fetchOwnRoutes({ limit: 50 })).filter(r => r.id !== editId);
      myRoutesLayer = L.featureGroup(routes
        .map(r => savedRouteMapLayer(r, { weight: 3, opacity: 0.7 })?.bindTooltip(escapeHtml(r.name), { sticky: true }))
        .filter(Boolean));
    } catch (err) {
      console.warn('Own routes overlay failed', err);
      setStatus('Impossibile caricare i tuoi percorsi. Riprova tra poco.', 'warning');
    }
    btn.disabled = false;
    if (!myRoutesLayer) { updateMyRoutesButton(); return; }
  }

  const layers = myRoutesLayer.getLayers();
  if (!layers.length) {
    updateMyRoutesButton();
    setStatus(window.PRELOAD_ROUTE ? 'Nessun altro percorso salvato.' : 'Non hai ancora percorsi salvati.', 'muted');
    return;
  }
  myRoutesLayer.addTo(map);
  myRoutesVisible = true;
  updateMyRoutesButton();

  const view = map.getBounds();
  if (layers.some(l => l.getBounds ? view.intersects(l.getBounds()) : view.contains(l.getLatLng()))) return;
  if (routeGeometry === null && !waypoints.length) {
    map.fitBounds(myRoutesLayer.getBounds(), { padding: [30, 30], maxZoom: 14 });
  } else {
    setStatus('I tuoi percorsi sono fuori dalla zona visibile della mappa.', 'muted');
  }
}

function updateMyRoutesButton() {
  const btn = document.getElementById('btn-my-routes');
  if (!btn) return;
  btn.className = `btn btn-sm ${myRoutesVisible ? 'btn-primary' : 'btn-outline-primary'} flex-fill`;
  btn.setAttribute('aria-pressed', String(myRoutesVisible));
  btn.replaceChildren(
    createEl('i', 'bi bi-collection me-1'),
    myRoutesVisible ? `Nascondi i miei percorsi (${myRoutesLayer.getLayers().length})` : 'I miei percorsi'
  );
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
  routeStats.slopeSeriesRaw = [];
  routeStats.slopeSeriesReliable = [];
  routeStats.visualSlopeSeries = [];
  routeStats.slopeQuality = null;
  routeStats.equivalentSlopePct = null;
  routeStats.displayedSlopeStats = routeStats.avgSlope !== null
    ? {
        usable: true,
        label: null,
        avg: routeStats.avgSlope,
        maxAsc: routeStats.maxSlopeAsc,
        maxDesc: routeStats.maxSlopeDesc
      }
    : null;
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
    // A recorded track can't be rebuilt, so its start/end are not editable markers (buildSaveWaypoints derives them).
    if (routeSource === 'gpx') return;

    const savedWaypoints = (route.waypoints || []).length
      ? route.waypoints
      : technicalWaypointsFromGeometry(route.geometry, TECHNICAL_WAYPOINT_NAMES.osm_single);
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
  const gpxInput = document.getElementById('gpx-file');
  document.getElementById('btn-import-gpx')?.addEventListener('click', () => gpxInput?.click());
  gpxInput?.addEventListener('change', () => importGpxFile(gpxInput.files?.[0]));
  document.getElementById('btn-my-routes')?.addEventListener('click', toggleMyRoutes);
  document.getElementById('nearby-close')?.addEventListener('click', closeNearbyRoutes);
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-input') && !e.target.closest('#search-results')) closeSearchResults();
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

function createEl(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
