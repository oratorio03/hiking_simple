// ── Navigation mode ───────────────────────────────────────────────────────

let navMap, posMarker, posCircle, routeGeoLayer, watchId;
let isNavigating = false;
let currentPos = null;
const route = window.NAV_ROUTE;

document.addEventListener('DOMContentLoaded', () => {
  initNavMap();
  document.getElementById('btn-start-nav').addEventListener('click', toggleNavigation);
  document.getElementById('btn-center').addEventListener('click', () => {
    if (currentPos) navMap.setView([currentPos.lat, currentPos.lng], 16);
  });
});

function initNavMap() {
  navMap = L.map('nav-map', { zoomControl: true });

  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17
  }).addTo(navMap);

  // Draw route
  const geometry = route.geometry;
  if (geometry) {
    routeGeoLayer = L.geoJSON(geometry, {
      style: { color: '#198754', weight: 5, opacity: 0.85, lineCap: 'round' }
    }).addTo(navMap);
    navMap.fitBounds(routeGeoLayer.getBounds(), { padding: [30, 30] });
  }

  // Draw waypoints
  const waypoints = route.waypoints || [];
  waypoints.forEach((wp, i) => {
    const isStart = i === 0;
    const isEnd = i === waypoints.length - 1;
    const color = isStart ? '#198754' : isEnd ? '#dc3545' : '#0d6efd';
    L.circleMarker([wp.lat, wp.lng], {
      radius: 9, fillColor: color, color: '#fff', weight: 3, fillOpacity: 1
    }).addTo(navMap)
      .bindPopup(`<b>${wp.name || 'Punto ' + (i + 1)}</b>`);
  });

  if (!geometry && !waypoints.length) navMap.setView([45.8, 10.0], 9);
}

function toggleNavigation() {
  if (isNavigating) stopNavigation();
  else startNavigation();
}

function startNavigation() {
  if (!navigator.geolocation) {
    alert('GPS non disponibile nel tuo browser.');
    return;
  }

  isNavigating = true;
  const btn = document.getElementById('btn-start-nav');
  btn.innerHTML = '<i class="bi bi-stop-fill me-1"></i>Stop navigazione';
  btn.classList.replace('btn-success', 'btn-danger');
  document.getElementById('btn-center').disabled = false;

  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onGpsError,
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 }
  );
}

function stopNavigation() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  isNavigating = false;
  const btn = document.getElementById('btn-start-nav');
  btn.innerHTML = '<i class="bi bi-compass-fill me-1"></i>Avvia navigazione GPS';
  btn.classList.replace('btn-danger', 'btn-success');
  document.getElementById('btn-center').disabled = true;
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
  currentPos = { lat, lng, accuracy, speed, heading };

  // Update or create position layers
  if (posCircle) navMap.removeLayer(posCircle);
  if (posMarker) navMap.removeLayer(posMarker);

  posCircle = L.circle([lat, lng], {
    radius: accuracy,
    color: '#0d6efd',
    fillColor: '#0d6efd',
    fillOpacity: 0.08,
    weight: 1
  }).addTo(navMap);

  posMarker = L.circleMarker([lat, lng], {
    radius: 10,
    fillColor: '#0d6efd',
    color: '#fff',
    weight: 3,
    fillOpacity: 1
  }).addTo(navMap);

  // Auto-center with heading if available
  if (heading != null && !isNaN(heading)) {
    navMap.setView([lat, lng], Math.max(navMap.getZoom(), 15));
  } else {
    navMap.panTo([lat, lng]);
  }

  updateHUD(lat, lng, accuracy, speed);
}

function updateHUD(lat, lng, accuracy, speed) {
  // Distance to destination
  const waypoints = route.waypoints || [];
  if (waypoints.length > 0) {
    const dest = findNextWaypoint(lat, lng, waypoints);
    const distToNext = haversine(lat, lng, dest.lat, dest.lng);
    const distToDest = haversine(lat, lng,
      waypoints[waypoints.length - 1].lat,
      waypoints[waypoints.length - 1].lng
    );

    document.getElementById('hud-dist').textContent =
      distToDest < 1 ? `${Math.round(distToDest * 1000)}m` : `${distToDest.toFixed(1)}km`;
    document.getElementById('hud-wp').textContent =
      distToNext < 1 ? `${Math.round(distToNext * 1000)}m` : `${distToNext.toFixed(1)}km`;
  }

  document.getElementById('hud-speed').textContent =
    speed != null ? (speed * 3.6).toFixed(1) : '—';
  document.getElementById('hud-acc').textContent =
    accuracy != null ? `±${Math.round(accuracy)}m` : '—';
}

function findNextWaypoint(lat, lng, waypoints) {
  // Find closest waypoint that is still "ahead" (simplified: just find closest)
  let minDist = Infinity, closest = waypoints[0];
  waypoints.forEach(wp => {
    const d = haversine(lat, lng, wp.lat, wp.lng);
    if (d < minDist) { minDist = d; closest = wp; }
  });
  // Return next after closest
  const idx = waypoints.indexOf(closest);
  return waypoints[Math.min(idx + 1, waypoints.length - 1)];
}

function onGpsError(err) {
  console.warn('GPS error:', err.message);
  document.getElementById('hud-acc').textContent = 'Errore GPS';
}

// ── Haversine distance (km) ───────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
