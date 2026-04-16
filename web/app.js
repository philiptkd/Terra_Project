// ─────────────────────────────────────────────────────────────────────────────
//  Data Center Drought Map — app.js
//  Map: Mapbox GL JS v3.20.0 with OpenStreetMap raster tiles
// ─────────────────────────────────────────────────────────────────────────────

mapboxgl.accessToken = MAPBOX_TOKEN; // defined in config.js

// ── OSM tile style (no Mapbox tile costs) ────────────────────────────────────
const OSM_STYLE = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
        osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
        }
    },
    layers: [
        {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm',
            minzoom: 0,
            maxzoom: 19
        }
    ]
};

// ── Initialise map ────────────────────────────────────────────────────────────
const map = new mapboxgl.Map({
    container: 'map',
    style: OSM_STYLE,
    center: [-98.5, 39.5], // contiguous US center
    zoom: 4.3,
    projection: 'globe',   // renders as a 3-D globe at low zoom levels
    antialias: true
});

// Navigation controls (zoom + compass)
map.addControl(new mapboxgl.NavigationControl(), 'top-right');

// Full-screen control
map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

// Scale bar
map.addControl(
    new mapboxgl.ScaleControl({ maxWidth: 120, unit: 'metric' }),
    'bottom-right'
);

// ── Globe atmosphere + datacenter layer ───────────────────────────────────────
map.on('style.load', () => {
    map.setFog({
        color: 'rgb(20, 26, 40)',
        'high-color': 'rgb(10, 15, 30)',
        'horizon-blend': 0.04,
        'space-color': 'rgb(5, 8, 18)',
        'star-intensity': 0.6
    });

    loadDroughtOverlay();
    loadDatacenters();
});

// ── U.S. Drought Monitor (USDM) overlay ──────────────────────────────────────
// Weekly drought classification polygons, DM = 0..4 (D0 Abnormally Dry → D4 Exceptional).
// Public ArcGIS FeatureServer, open CORS, updated Thursdays.
const USDM_URL =
    'https://services5.arcgis.com/0OTVzJS4K09zlixn/ArcGIS/rest/services/USDM_current/FeatureServer/0/query' +
    '?where=1%3D1&outSR=4326&f=geojson&returnGeometry=true&geometryPrecision=4';

const USDM_COLORS = {
    0: '#F7DFB1', // D0 Abnormally Dry
    1: '#FCD37F', // D1 Moderate
    2: '#FFAA00', // D2 Severe
    3: '#E60000', // D3 Extreme
    4: '#730000'  // D4 Exceptional
};

function loadDroughtOverlay() {
    map.addSource('usdm', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution:
            'Drought: <a href="https://droughtmonitor.unl.edu" target="_blank">U.S. Drought Monitor</a>'
    });

    map.addLayer({
        id: 'usdm-fill',
        type: 'fill',
        source: 'usdm',
        paint: {
            'fill-color': [
                'match', ['to-number', ['get', 'DM']],
                0, USDM_COLORS[0],
                1, USDM_COLORS[1],
                2, USDM_COLORS[2],
                3, USDM_COLORS[3],
                4, USDM_COLORS[4],
                '#888888'
            ],
            'fill-opacity': 0.25
        }
    });

    fetch(USDM_URL)
        .then(r => {
            if (!r.ok) throw new Error(`USDM HTTP ${r.status}`);
            return r.json();
        })
        .then(geojson => {
            const src = map.getSource('usdm');
            if (src) src.setData(geojson);
            wireDroughtToggle();
        })
        .catch(err => {
            console.error('Failed to load USDM overlay:', err);
            const toggle = document.getElementById('drought-toggle');
            if (toggle) toggle.disabled = true;
        });
}

function wireDroughtToggle() {
    const toggle = document.getElementById('drought-toggle');
    if (!toggle) return;
    toggle.disabled = false;
    toggle.addEventListener('change', () => {
        const vis = toggle.checked ? 'visible' : 'none';
        if (map.getLayer('usdm-fill')) {
            map.setLayoutProperty('usdm-fill', 'visibility', vis);
        }
    });
}

// ── Load + display datacenters ────────────────────────────────────────────────
let selectedDcId = null;

function loadDatacenters() {
    map.addSource('datacenters', {
        type: 'geojson',
        data: window.DATACENTER_GEOJSON
    });

    map.addLayer({
        id: 'datacenters-circles',
        type: 'circle',
        source: 'datacenters',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                3, 4,
                10, 9
            ],
            'circle-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                '#ff6b35',
                '#4f8ef7'
            ],
            'circle-stroke-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                2.5,
                1.5
            ],
            'circle-stroke-color': '#ffffff',
            'circle-opacity': 0.9
        }
    });

    map.on('mouseenter', 'datacenters-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'datacenters-circles', () => {
        map.getCanvas().style.cursor = '';
    });

    map.on('click', 'datacenters-circles', async (e) => {
        const feature = e.features[0];

        if (selectedDcId !== null) {
            map.setFeatureState({ source: 'datacenters', id: selectedDcId }, { selected: false });
        }
        selectedDcId = feature.id;
        map.setFeatureState({ source: 'datacenters', id: selectedDcId }, { selected: true });

        showLoadingState();

        try {
            const res = await fetch(`/.netlify/functions/datacenter?id=${feature.id}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const props = await res.json();
            updateSidebar(props, feature.geometry.coordinates);
        } catch (err) {
            console.error('Failed to fetch datacenter details:', err);
            showErrorState();
        }
    });
}

// ── Sidebar states ────────────────────────────────────────────────────────────
function showLoadingState() {
    document.getElementById('selected-location').innerHTML = `
        <div class="location-badge">
            <span class="dot"></span>
            <span>Loading…</span>
        </div>`;
    document.getElementById('charts-container').innerHTML = `
        <div class="empty-state">
            <p>Fetching datacenter details…</p>
        </div>`;
}

function showErrorState() {
    document.getElementById('charts-container').innerHTML = `
        <div class="empty-state">
            <p>Could not load datacenter details.</p>
        </div>`;
}

// Streamflow percentile categories (WaterWatch convention, 1991–2020 baseline).
const FLOW_CATEGORY_COLORS = {
    'Much Below Normal': '#8B0000',
    'Below Normal':      '#E65100',
    'Normal':            '#4CAF50',
    'Above Normal':      '#1565C0',
    'Much Above Normal': '#0D47A1'
};

function categoryFromPct(pct) {
    if (pct === null || pct === undefined) return null;
    if (pct < 10)  return 'Much Below Normal';
    if (pct < 25)  return 'Below Normal';
    if (pct <= 75) return 'Normal';
    if (pct <= 90) return 'Above Normal';
    return 'Much Above Normal';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function formatAsOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function renderStreamflowCard(sf, gage) {
    if (!gage?.id) return '';

    const cfs  = sf?.current_cfs;
    const pct  = sf?.percentile;
    const cat  = sf?.category;
    const err  = sf?.current_error || sf?.stats_error;
    const color = cat ? FLOW_CATEGORY_COLORS[cat] : 'var(--text-muted)';

    const liveBlock = err
        ? `<div class="sf-note">Live reading unavailable (${escapeHtml(err)}).</div>`
        : cfs !== undefined
          ? `
            <div class="sf-readout">
                <div class="sf-main">
                    <span class="sf-value">${cfs.toLocaleString()}</span>
                    <span class="sf-unit">cfs</span>
                </div>
                ${pct !== undefined ? `
                <div class="sf-pct-row">
                    <div class="sf-pct-bar">
                        <div class="sf-pct-fill" style="width:${Math.max(1, Math.min(100, pct))}%;background:${color}"></div>
                    </div>
                    <div class="sf-pct-text">
                        <span class="sf-pct-num">${pct}<span class="sf-pct-small">th</span></span>
                        <span class="sf-pct-cat" style="color:${color}">${escapeHtml(cat || '')}</span>
                    </div>
                </div>` : ''}
            </div>`
          : '';

    return `
        <div class="chart-card">
            <div class="card-header">
                <h3>Current Streamflow</h3>
                <button class="info-btn" data-info="streamflow" aria-label="About this data">i</button>
            </div>
            <div class="info-tooltip" id="info-streamflow">
                Latest daily-mean discharge (cfs) from the nearest USGS streamgage, ranked as a percentile against the 1991–2020 historical distribution for that day of year.
                <br>
                <ul class="legend-scale" style="margin-top:8px">
                    <li><span class="swatch" style="background:#8B0000"></span>&lt; 10th — Much Below Normal</li>
                    <li><span class="swatch" style="background:#E65100"></span>10th–25th — Below Normal</li>
                    <li><span class="swatch" style="background:#4CAF50"></span>25th–75th — Normal</li>
                    <li><span class="swatch" style="background:#1565C0"></span>75th–90th — Above Normal</li>
                    <li><span class="swatch" style="background:#0D47A1"></span>&gt; 90th — Much Above Normal</li>
                </ul>
                <br><strong>Source:</strong> <a href="https://waterservices.usgs.gov" target="_blank" rel="noopener" style="color:var(--accent)">USGS WaterServices</a>
            </div>
            ${liveBlock}
            <div class="sf-meta">
                <div class="dc-row">
                    <span class="dc-label">Nearest USGS Gage</span>
                    <span class="dc-value">${escapeHtml(gage.name || gage.id)}</span>
                </div>
                <div class="dc-row">
                    <span class="dc-label">Gage ID · Distance</span>
                    <span class="dc-value">
                        <a href="https://waterdata.usgs.gov/monitoring-location/${gage.id}"
                           target="_blank" rel="noopener">${gage.id}</a>
                        · ${gage.distance_km} km
                    </span>
                </div>
                ${sf?.as_of ? `
                <div class="dc-row">
                    <span class="dc-label">Observed</span>
                    <span class="dc-value">${formatAsOf(sf.as_of)}${sf.baseline_years ? ` · percentile vs ${sf.baseline_years}` : ''}</span>
                </div>` : ''}
            </div>
        </div>`;
}

function renderForecastCard(forecast) {
    if (!forecast || forecast.length === 0) return '';

    const W = 320, H = 140, PAD_L = 28, PAD_R = 8, PAD_T = 10, PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const n = forecast.length;
    const barW = innerW / n * 0.7;
    const step = innerW / n;

    const hatchDefs = `
        <defs>
            <pattern id="hatch-o" width="8" height="8" patternUnits="userSpaceOnUse">
                <circle cx="4" cy="4" r="2.5" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="0.8"/>
            </pattern>
            <pattern id="hatch-dot" width="5" height="5" patternUnits="userSpaceOnUse">
                <circle cx="2.5" cy="2.5" r="0.8" fill="rgba(0,0,0,0.3)"/>
            </pattern>
        </defs>`;

    const bars = forecast.map((f, i) => {
        const x = PAD_L + i * step + (step - barW) / 2;
        const v = f.median_pct == null ? 0 : Math.max(0, Math.min(100, f.median_pct));
        const h = (v / 100) * innerH;
        const y = PAD_T + innerH - h;
        const cat = categoryFromPct(f.median_pct);
        const color = cat ? FLOW_CATEGORY_COLORS[cat] : '#555';

        const p05 = f.p05 == null ? null : Math.max(0, Math.min(100, f.p05));
        const p95 = f.p95 == null ? null : Math.max(0, Math.min(100, f.p95));
        const ci = (p05 !== null && p95 !== null) ? `
            <line x1="${x + barW / 2}" x2="${x + barW / 2}"
                  y1="${PAD_T + innerH - (p95 / 100) * innerH}"
                  y2="${PAD_T + innerH - (p05 / 100) * innerH}"
                  stroke="#8892a8" stroke-width="1" opacity="0.6"/>` : '';

        let hatchOverlay = '';
        if (i >= 1 && i <= 6) {
            hatchOverlay = `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="url(#hatch-o)" rx="1"/>`;
        } else if (i >= 7) {
            hatchOverlay = `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="url(#hatch-dot)" rx="1"/>`;
        }

        return `
            <g>
                <title>${f.date} — ${f.median_pct == null ? '—' : f.median_pct + 'th percentile'}</title>
                <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="1"/>
                ${hatchOverlay}
                ${ci}
            </g>`;
    }).join('');

    const yTicks = [0, 25, 50, 75, 100].map(v => {
        const y = PAD_T + innerH - (v / 100) * innerH;
        return `
            <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}"
                  stroke="#2a2f45" stroke-width="0.5"/>
            <text x="${PAD_L - 4}" y="${y + 3}" fill="#8892a8" font-size="9"
                  text-anchor="end">${v}</text>`;
    }).join('');

    // Month-aware x labels: show month abbreviation when it changes.
    let lastMonth = null;
    const xLabels = forecast.map((f, i) => {
        const d = new Date(f.date);
        const month = d.getUTCMonth();
        const show = month !== lastMonth;
        lastMonth = month;
        if (!show) return '';
        const x = PAD_L + i * step + step / 2;
        const label = d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
        return `<text x="${x}" y="${H - 10}" fill="#8892a8" font-size="9" text-anchor="middle">${label}</text>`;
    }).join('');

    return `
        <div class="chart-card">
            <div class="card-header">
                <h3>13-Week Streamflow Forecast</h3>
                <button class="info-btn" data-info="forecast" aria-label="About this data">i</button>
            </div>
            <div class="info-tooltip" id="info-forecast">
                <ul class="legend-scale">
                    <li>First Bar: Current Week</li>
                    <li>"○" Bars: High Confidence Weeks</li>
                    <li>"." Bars: Low Confidence Weeks</li>
                </ul>
                <br>
                <ul class="legend-scale" style="margin-top:8px">
                    <li><span class="swatch" style="background:#8B0000"></span>&lt; 10th — Much Below Normal</li>
                    <li><span class="swatch" style="background:#E65100"></span>10th–25th — Below Normal</li>
                    <li><span class="swatch" style="background:#4CAF50"></span>25th–75th — Normal</li>
                    <li><span class="swatch" style="background:#1565C0"></span>75th–90th — Above Normal</li>
                    <li><span class="swatch" style="background:#0D47A1"></span>&gt; 90th — Much Above Normal</li>
                </ul>
                <br><strong>Source:</strong> <a href="https://www.usgs.gov/tools/river-droughtcast" target="_blank" rel="noopener" style="color:var(--accent)">USGS River DroughtCast</a>
            </div>
            <svg class="forecast-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
                ${hatchDefs}
                ${yTicks}
                ${bars}
                ${xLabels}
                <text x="${PAD_L - 20}" y="${PAD_T + innerH / 2}" fill="#8892a8" font-size="9"
                      text-anchor="middle" transform="rotate(-90 ${PAD_L - 20} ${PAD_T + innerH / 2})">
                    percentile
                </text>
            </svg>
        </div>`;
}

function updateSidebar(props, coords) {
    const locationEl = document.getElementById('selected-location');
    const chartsEl   = document.getElementById('charts-container');

    locationEl.innerHTML = `
        <div class="location-badge">
            <span class="dot"></span>
            <span>${escapeHtml(props.Name || 'Unknown Datacenter')}</span>
        </div>`;

    const fields = [
        { label: 'Operator',    value: props.Operator },
        { label: 'Location',    value: [props.City, props.State, props.Country].filter(Boolean).join(', ') },
        { label: 'Address',     value: props.Address },
        { label: 'Status',      value: props.Status },
        { label: 'Power',       value: props.Power },
        { label: 'Size',        value: props.Size },
        { label: 'Established', value: props.Established },
    ].filter(f => f.value);

    const rows = fields.map(f => `
        <div class="dc-row">
            <span class="dc-label">${f.label}</span>
            <span class="dc-value">${escapeHtml(f.value)}</span>
        </div>`).join('');

    const [lng, lat] = coords;
    const streamflowCard = renderStreamflowCard(props.streamflow, props.gage);
    const forecastCard   = renderForecastCard(props.forecast);

    chartsEl.innerHTML = `
        ${streamflowCard}
        ${forecastCard}
        <div class="chart-card dc-info">
            <h3>Datacenter Info</h3>
            ${rows}
            <div class="dc-row">
                <span class="dc-label">Coordinates</span>
                <span class="dc-value">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
            </div>
        </div>`;
}

// ── Info-tooltip toggle (click to show/hide) ─────────────────────────────────
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.info-btn');
    if (btn) {
        const key = btn.getAttribute('data-info');
        const tip = document.getElementById(`info-${key}`);
        if (tip) {
            const isOpen = tip.classList.contains('visible');
            document.querySelectorAll('.info-tooltip.visible').forEach(t => t.classList.remove('visible'));
            document.querySelectorAll('.info-btn.active').forEach(b => b.classList.remove('active'));
            if (!isOpen) {
                tip.classList.add('visible');
                btn.classList.add('active');
            }
        }
        return;
    }
    if (!e.target.closest('.info-tooltip')) {
        document.querySelectorAll('.info-tooltip.visible').forEach(t => t.classList.remove('visible'));
        document.querySelectorAll('.info-btn.active').forEach(b => b.classList.remove('active'));
    }
});

// ── Expose map for future modules ─────────────────────────────────────────────
window.terraMap = map;
