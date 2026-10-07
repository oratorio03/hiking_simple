(function () {
  function haversineKm(lat1, lng1, lat2, lng2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatKm(km) {
    const m = Math.round(km * 1000);
    return m < 1000 ? `${m} m` : `${km.toFixed(1)} km`;
  }

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocalizzazione non supportata'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        reject,
        { timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  function startOf(el) {
    const lat = parseFloat(el.dataset.startLat);
    const lng = parseFloat(el.dataset.startLng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  function initNearSort(btn) {
    const list = document.querySelector('.route-list');
    if (!list) return;
    const msg = document.getElementById('near-msg');
    const label = btn.querySelector('.btn-label');
    const original = Array.from(list.children);
    let sorted = false;

    function setSorted(active) {
      sorted = active;
      btn.classList.toggle('active', active);
      btn.classList.toggle('btn-success', active);
      btn.classList.toggle('btn-outline-success', !active);
      btn.setAttribute('aria-pressed', String(active));
      label.textContent = active ? 'Ordinato per distanza' : 'Vicino a me';
    }

    function addBadge(card, km) {
      const badge = document.createElement('span');
      badge.className = 'near-badge badge rounded-pill bg-success-subtle text-success-emphasis';
      const icon = document.createElement('i');
      icon.className = 'bi bi-geo-alt';
      badge.append(icon, `a ${formatKm(km)}`);
      card.querySelector('.route-meta')?.prepend(badge);
    }

    btn.addEventListener('click', async () => {
      if (sorted) {
        list.querySelectorAll('.near-badge').forEach(b => b.remove());
        list.append(...original);
        setSorted(false);
        return;
      }
      msg.hidden = true;
      btn.disabled = true;
      let here;
      try {
        here = await locate();
      } catch {
        msg.hidden = false;
        return;
      } finally {
        btn.disabled = false;
      }
      const ranked = original.map(card => {
        const start = startOf(card);
        if (!start) return { card, km: Infinity };
        const km = haversineKm(here.lat, here.lng, start.lat, start.lng);
        addBadge(card, km);
        return { card, km };
      });
      ranked.sort((a, b) => (a.km === b.km ? 0 : a.km - b.km));
      list.append(...ranked.map(r => r.card));
      setSorted(true);
    });
  }

  function initStartDistance(card) {
    const start = startOf(card);
    const out = document.getElementById('start-distance');
    const btn = document.getElementById('btn-start-distance');
    if (!start) return;

    async function show() {
      btn.hidden = true;
      out.hidden = false;
      out.textContent = 'Calcolo…';
      try {
        const here = await locate();
        out.textContent = formatKm(haversineKm(here.lat, here.lng, start.lat, start.lng));
      } catch {
        out.textContent = 'Posizione non disponibile';
        btn.hidden = false;
      }
    }

    btn.addEventListener('click', show);
    // Only compute on load when it cannot trigger a permission prompt.
    if (!navigator.permissions?.query) {
      btn.hidden = false;
      return;
    }
    navigator.permissions.query({ name: 'geolocation' }).then(
      status => {
        if (status.state === 'granted') show();
        else btn.hidden = false;
      },
      () => { btn.hidden = false; }
    );
  }

  const nearBtn = document.getElementById('btn-sort-near');
  if (nearBtn) initNearSort(nearBtn);
  const startCard = document.getElementById('start-card');
  if (startCard) initStartDistance(startCard);
})();
