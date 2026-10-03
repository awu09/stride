/* global L */
export const OPTION_COLORS = { A: '#2f6bff', B: '#f2762e', C: '#a64dff' };

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const pin = (html, className) => L.divIcon({ html, className, iconSize: null, iconAnchor: [0, 0] });

export class RunMap {
  constructor(el, center) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 15);
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    this.optionLayer = L.layerGroup().addTo(this.map);
    this.runLayer = L.layerGroup().addTo(this.map);
    this.padding = { topLeft: [24, 96], bottomRight: [24, 320] };

    // Dark mode is a CSS filter on the tile pane (see .leaflet-tile-pane in styles.css).
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(this.map);
  }

  onClick(cb) {
    this.map.on('click', (e) => cb({ lat: e.latlng.lat, lng: e.latlng.lng }));
  }

  // Start point flag. Hidden when the run starts from the runner's own location (the blue dot).
  setStart(pos, { recenter = true, visible = true } = {}) {
    if (!this.startMarker) {
      this.startMarker = L.marker([pos.lat, pos.lng], { icon: pin('<div class="start-flag">Start</div>', 'pin-start'), interactive: false, zIndexOffset: 500 });
    }
    this.startMarker.setLatLng([pos.lat, pos.lng]);
    this.startVisible = visible;
    if (visible && !this.running) this.startMarker.addTo(this.map);
    else this.startMarker.remove();
    if (recenter) this.map.setView([pos.lat, pos.lng], Math.max(this.map.getZoom(), 15));
  }

  // Live "you are here" blue dot with an accuracy halo, like Google Maps.
  setMe(pos, accuracy) {
    const latlng = Array.isArray(pos) ? pos : [pos.lat, pos.lng];
    if (!this.meMarker) {
      this.meHalo = L.circle(latlng, { radius: accuracy || 10, stroke: false, fillColor: '#2f6bff', fillOpacity: 0.15, interactive: false }).addTo(this.map);
      this.meMarker = L.marker(latlng, { icon: pin('<div class="me-dot"></div>', 'pin-me'), interactive: false, zIndexOffset: 2000 }).addTo(this.map);
    }
    this.meMarker.setLatLng(latlng);
    this.meHalo.setLatLng(latlng);
    if (accuracy) this.meHalo.setRadius(Math.min(accuracy, 200));
  }

  fit(latlngs) {
    if (!latlngs.length) return;
    this.map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: this.padding.topLeft, paddingBottomRight: this.padding.bottomRight });
  }

  showOptions(options, selectedId, onSelect, { fit = true } = {}) {
    this.optionLayer.clearLayers();
    this.runLayer.clearLayers();
    // Draw unselected first so the selected route sits on top.
    const ordered = [...options].sort((a, b) => (a.id === selectedId) - (b.id === selectedId));
    for (const o of ordered) {
      const selected = o.id === selectedId;
      const color = OPTION_COLORS[o.id];
      const line = L.polyline(o.geometry, {
        color,
        weight: selected ? 7 : 4,
        opacity: selectedId && !selected ? 0.35 : 0.9,
        lineCap: 'round',
        lineJoin: 'round',
        bubblingMouseEvents: false,
      }).addTo(this.optionLayer);
      line.on('click', () => onSelect(o.id));
      const marker = L.marker([o.place.lat, o.place.lng], {
        icon: pin(`<div class="place-pin${selected ? ' selected' : ''}" style="--pin:${color}"><span>${o.id}</span></div>`, 'pin-place'),
        zIndexOffset: selected ? 1000 : 0,
        keyboard: false,
      }).addTo(this.optionLayer);
      marker.on('click', () => onSelect(o.id));
    }
    if (fit) this.fit(options.flatMap((o) => o.geometry));
  }

  showRun(route) {
    this.optionLayer.clearLayers();
    this.runLayer.clearLayers();
    const color = OPTION_COLORS[route.id] || OPTION_COLORS.A;
    L.polyline(route.geometry, { color, weight: 7, opacity: 0.35, lineCap: 'round', lineJoin: 'round' }).addTo(this.runLayer);
    this.doneLine = L.polyline([], { color, weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(this.runLayer);
    L.marker([route.place.lat, route.place.lng], {
      icon: pin(`<div class="place-pin selected" style="--pin:${color}"><span>${route.id}</span></div>`, 'pin-place'),
      interactive: false,
    }).addTo(this.runLayer);
    // During a run the blue dot is the runner (real GPS or the simulated runner).
    this.running = true;
    this.startMarker?.remove();
    this.setMe(route.geometry[0]);
    this.following = true;
    this.map.setView(route.geometry[0], 17);
  }

  updateRun(position, doneCoords, accuracy) {
    if (!this.running) return;
    this.setMe(position, accuracy);
    this.doneLine.setLatLngs(doneCoords);
    if (this.following) this.map.panTo(position, { animate: true, duration: 0.25 });
  }

  clearRun() {
    this.runLayer.clearLayers();
    this.running = false;
    if (this.startVisible) this.startMarker?.addTo(this.map);
  }

  get isRunning() {
    return Boolean(this.running);
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
