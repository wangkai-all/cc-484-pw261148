/**
 * Retention Studio front end.
 * Plain ES modules, no build step. All DOM text is inserted with textContent.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  boot: null,
  config: {
    convention: 'calendar',
    reportingZone: 'UTC',
    businessZone: 'America/New_York',
    from: '2026-08-03',
    to: '2026-11-05',
    days: 14,
    segments: {},
    latePolicy: 'include',
    lateGraceHours: 72,
    cohortEvent: 'signup',
    asOf: null,
    version: 'latest',
  },
  report: null,
  compare: null,
  matrixMode: 'rate',
  tableView: false,
  changedCohorts: new Set(),
  selectedVersion: null,
  planDomain: null,
  caseOpen: null,
  caseKey: null,
  compareVersion: null,
};

const CONVENTION_COLORS = {
  calendar: 'var(--series-1)',
  rolling24h: 'var(--series-2)',
  business: 'var(--series-3)',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------- utilities

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtPct(rate, digits = 1) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

function fmtCompact(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  return Number(n).toLocaleString('en-US');
}

function fmtDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }) + ' UTC';
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') throw new Error('Refusing innerHTML');
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, v);
  }
  return node;
}

let toastTimer = null;
function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast visible${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 3200);
}

const tooltip = {
  node: null,
  show(htmlNodes, x, y) {
    if (!this.node) this.node = $('#tooltip');
    this.node.replaceChildren(...htmlNodes);
    this.node.classList.add('visible');
    this.node.setAttribute('aria-hidden', 'false');
    const rect = this.node.getBoundingClientRect();
    const pad = 12;
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
    this.node.style.left = `${Math.max(8, left)}px`;
    this.node.style.top = `${Math.max(8, top)}px`;
  },
  hide() {
    if (!this.node) return;
    this.node.classList.remove('visible');
    this.node.setAttribute('aria-hidden', 'true');
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(body.details) ? body.details.join('; ') : body.error || res.statusText;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return body;
}

function reportPayload() {
  return {
    convention: state.config.convention,
    reportingZone: state.config.reportingZone,
    businessZone: state.config.businessZone,
    from: state.config.from,
    to: state.config.to,
    days: state.config.days,
    segments: state.config.segments,
    latePolicy: state.config.latePolicy,
    lateGraceHours: state.config.lateGraceHours,
    cohortEvent: state.config.cohortEvent,
    asOf: state.config.asOf,
    version: state.config.version,
  };
}

// ---------------------------------------------------------------- colour

const SEQ = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700'];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Sequential blue ramp for a retention rate in [0, max]. */
function rateColor(rate, max = 0.7) {
  if (rate === null || rate === undefined) return null;
  const t = Math.max(0, Math.min(1, rate / max));
  if (t < 0.02) return cssVar('--surface-2');
  const idx = Math.min(SEQ.length - 1, Math.floor(t * (SEQ.length - 1) + 0.0001));
  return cssVar(SEQ[idx]);
}

function inkFor(bg) {
  // White ink on the darker half of the ramp, near-black on the light half.
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return 'var(--text-primary)';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 140 ? '#ffffff' : '#0b0b0b';
}

// ---------------------------------------------------------------- controls

function buildControls() {
  const sw = $('#convention-switch');
  sw.replaceChildren(
    ...state.boot.conventions.map((c) =>
      el('button', {
        class: 'seg-btn',
        type: 'button',
        'aria-pressed': String(c.id === state.config.convention),
        title: c.hint,
        dataset: { convention: c.id },
        text: c.label,
        onclick: () => setConvention(c.id),
      }),
    ),
  );

  const zoneOptions = state.boot.zones.map((z) => el('option', { value: z, text: z }));
  $('#zone-select').replaceChildren(...zoneOptions);
  const bizOptions = state.boot.zones.map((z) => el('option', { value: z, text: z }));
  $('#business-zone-select').replaceChildren(...bizOptions);
  $('#zone-select').value = state.config.reportingZone;
  $('#business-zone-select').value = state.config.businessZone;
  $('#range-from').value = state.config.from;
  $('#range-to').value = state.config.to;

  $('#zone-select').addEventListener('change', (e) => {
    state.config.reportingZone = e.target.value;
    refresh({ compare: true });
  });
  $('#business-zone-select').addEventListener('change', (e) => {
    state.config.businessZone = e.target.value;
    refresh({ compare: true });
  });
  $('#range-from').addEventListener('change', (e) => {
    if (e.target.value > state.config.to) {
      toast('"From" must not be after "to"', 'error');
      e.target.value = state.config.from;
      return;
    }
    state.config.from = e.target.value;
    refresh();
  });
  $('#range-to').addEventListener('change', (e) => {
    if (e.target.value < state.config.from) {
      toast('"To" must not be before "from"', 'error');
      e.target.value = state.config.to;
      return;
    }
    state.config.to = e.target.value;
    refresh();
  });
  $('#cohort-select').addEventListener('change', (e) => {
    state.config.cohortEvent = e.target.value;
    refresh({ compare: true });
  });
  $('#horizon-select').addEventListener('change', (e) => {
    state.config.days = Number(e.target.value);
    refresh();
  });
  $('#late-select').addEventListener('change', (e) => {
    state.config.latePolicy = e.target.value;
    refresh({ compare: true });
  });
  $('#plan-select').addEventListener('change', (e) => {
    const plan = e.target.value;
    if (plan) state.config.segments = { ...state.config.segments, plan: [plan] };
    else {
      const { plan: _, ...rest } = state.config.segments;
      state.config.segments = rest;
    }
    refresh({ compare: true });
  });
  $('#matrix-mode').addEventListener('click', () => {
    state.matrixMode = state.matrixMode === 'rate' ? 'count' : 'rate';
    $('#matrix-mode').textContent = state.matrixMode === 'rate' ? 'Show counts' : 'Show rates';
    $('#matrix-mode').setAttribute('aria-pressed', String(state.matrixMode === 'count'));
    renderMatrix();
  });
  $('#table-toggle').addEventListener('click', () => {
    state.tableView = !state.tableView;
    $('#table-toggle').textContent = state.tableView ? 'Matrix view' : 'Table view';
    $('#table-toggle').setAttribute('aria-pressed', String(state.tableView));
    renderMatrix();
  });
  $('#reset-btn').addEventListener('click', resetData);
  updateBusinessZoneVisibility();
}

function updateBusinessZoneVisibility() {
  $('#business-zone-group').classList.toggle('is-hidden', state.config.convention !== 'business');
  $('#plan-select').value = state.config.segments.plan?.[0] ?? '';
  $('#cohort-select').value = state.config.cohortEvent;
}

function setConvention(convention) {
  if (state.config.convention === convention) return;
  state.config.convention = convention;
  for (const btn of $$('#convention-switch .seg-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.convention === convention));
  }
  updateBusinessZoneVisibility();
  refresh({ compare: false });
}

// ---------------------------------------------------------------- loading

async function loadReport() {
  document.body.classList.add('is-loading');
  try {
    state.report = await api('/api/report', {
      method: 'POST',
      body: JSON.stringify(reportPayload()),
    });
    state.changedCohorts.clear();
  } finally {
    document.body.classList.remove('is-loading');
  }
}

async function loadCompare() {
  try {
    state.compare = await api('/api/compare', {
      method: 'POST',
      body: JSON.stringify({ ...reportPayload(), version: undefined }),
    });
  } catch (err) {
    console.warn('compare failed', err);
    state.compare = null;
  }
}

let refreshToken = 0;
async function refresh({ compare = true } = {}) {
  const token = ++refreshToken;
  try {
    await loadReport();
    if (token !== refreshToken) return;
    if (compare || !state.compare) await loadCompare();
    if (token !== refreshToken) return;
    renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- render

function renderAll() {
  renderHero();
  renderMatrix();
  renderCompare();
  renderBreakdown();
  renderSampleLedger();
  renderDstLedger();
  renderAlerts();
  renderVersions();
  renderCases();
  renderDatasetMeta();
  renderComposition();
}

function renderDatasetMeta() {
  const d = state.boot.dataset;
  const live = state.report?.meta;
  // When a historical version is selected the live dataset stats describe the
  // latest state, so label the version explicitly as a snapshot view.
  const viewing = live?.version !== undefined && live.version !== d.version;
  const parts = [
    `${fmtInt(d.events)} events`,
    `${fmtInt(d.identities)} identities`,
    viewing ? `viewing v${live.version} of v${d.version}` : `v${d.version}`,
  ];
  $('#dataset-summary').textContent = parts.join(' · ');
  $('#asof-value').textContent = live ? fmtDateTime(live.asOfIso) : fmtDateTime(state.boot.nowIso);
}

function renderHero() {
  const report = state.report;
  const target = state.config.days;
  const meta = report.meta;
  // If the requested horizon is not observable yet for any cohort (a very
  // recent range), show the furthest day that is, and say so, rather than a
  // bare em dash.
  let day = target;
  let agg = report.aggregates[target];
  let fallback = null;
  if (!agg || agg.rate === null) {
    const observed = report.aggregates.filter((a) => a.rate !== null);
    const last = observed.at(-1);
    if (last) {
      day = last.offset;
      agg = last;
      fallback = target;
    }
  }
  $('#hero-day').textContent = String(day);
  $('#hero-title').classList.toggle('is-fallback', fallback !== null);
  const entryLabel = { signup: 'signup', app_open: 'first app open', purchase: 'first purchase' }[meta.cohortEvent] ?? meta.cohortEvent;
  $('#hero-sub').textContent =
    `${meta.conventionLabel} · ${meta.note} · by ${entryLabel} · cohorts ${fmtDate(meta.from)} – ${fmtDate(meta.to)}`;
  $('#convention-badge').textContent =
    meta.convention === 'business' ? `Business · ${meta.businessZone}` : meta.slotZone;
  $('#hero-value').textContent = agg && agg.rate !== null ? fmtPct(agg.rate) : '—';
  $('#hero-day').title = fallback !== null ? `Day ${fallback} is not observable yet for these cohorts` : '';
  $('#hero-eligible').textContent = fmtInt(agg?.eligibleUsers);
  $('#hero-active').textContent = fmtInt(agg?.activeUsers);
  $('#hero-cohorts').textContent = fmtInt(agg?.eligibleCohorts);

  const day1 = report.aggregates[1];
  const delta = $('#hero-delta');
  if (fallback !== null) {
    delta.textContent = `day ${fallback} not observable yet`;
  } else if (agg && agg.rate !== null && day1?.rate != null) {
    delta.textContent = `vs ${fmtPct(day1.rate)} on day 1`;
  } else {
    delta.textContent = '';
  }

  renderSparkline();
}

function renderSparkline() {
  const svg = $('#sparkline');
  svg.replaceChildren();
  const data = state.report.aggregates.filter((d) => d.rate !== null);
  if (data.length < 2) return;
  const width = svg.clientWidth || 600;
  const height = 76;
  const pad = { t: 8, r: 4, b: 16, l: 4 };
  const maxRate = Math.max(...data.map((d) => d.rate));
  const x = (i) => pad.l + (i / (data.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / Math.max(maxRate, 0.01)) * (height - pad.t - pad.b);

  const grid = svgEl('line', {
    x1: pad.l, x2: width - pad.r, y1: y(maxRate), y2: y(maxRate),
    stroke: 'var(--grid)', 'stroke-width': 1,
  });
  svg.append(grid);

  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.rate).toFixed(1)}`).join(' ');
  const area = `${path} L${x(data.length - 1).toFixed(1)},${(height - pad.b).toFixed(1)} L${x(0).toFixed(1)},${(height - pad.b).toFixed(1)} Z`;
  svg.append(svgEl('path', { d: area, fill: 'var(--accent)', opacity: 0.1 }));
  svg.append(svgEl('path', { d: path, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  const last = data[data.length - 1];
  svg.append(svgEl('circle', { cx: x(data.length - 1), cy: y(last.rate), r: 4, fill: 'var(--accent)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));

  for (const d of data) {
    const cx = x(data.indexOf(d));
    const g = svgEl('circle', { cx, cy: y(d.rate), r: 10, fill: 'transparent', tabindex: 0, role: 'img', 'aria-label': `Day ${d.offset}: ${fmtPct(d.rate)}` });
    const show = (ev) => {
      const rect = ev.target.getBoundingClientRect();
      tooltip.show(
        [
          el('div', { class: 'tt-kicker', text: `Day ${d.offset}` }),
          el('div', { class: 'tt-value', text: fmtPct(d.rate) }),
          el('div', { class: 'tt-row', text: `${fmtInt(d.activeUsers)} of ${fmtInt(d.eligibleUsers)} eligible` }),
        ],
        rect.left + rect.width / 2,
        rect.top,
      );
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tooltip.hide());
    g.addEventListener('blur', () => tooltip.hide());
    svg.append(g);
  }

  const day14 = data.find((d) => d.offset === state.config.days);
  if (day14) {
    svg.append(svgEl('line', { x1: x(data.indexOf(day14)), x2: x(data.indexOf(day14)), y1: pad.t, y2: height - pad.b, stroke: 'var(--axis)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: Math.min(x(data.indexOf(day14)), width - 30), y: height - 3, 'font-size': 10.5, fill: 'var(--text-muted)' });
    label.textContent = `day ${day14.offset}`;
    svg.append(label);
  }
}

function renderMatrix() {
  const host = $('#matrix');
  const report = state.report;
  if (!report) return;
  host.replaceChildren();

  if (state.tableView) {
    // #matrix is a grid in heatmap mode; collapse it so the table gets full width.
    host.classList.add('table-mode');
    host.style.gridTemplateColumns = '1fr';
    host.append(buildMatrixTable());
    $('#matrix-legend').replaceChildren(el('span', { class: 'flow-note', text: 'Counts and rates are also available in the matrix view. Blank = not yet observable.' }));
    return;
  }

  const cohorts = report.cohorts;
  const dayCount = state.config.days + 1;
  const observed = cohorts.flatMap((c) => c.days.filter((d) => d.offset > 0).map((d) => d.rate ?? 0));
  const maxRate = Math.max(0.05, ...observed);
  host.classList.remove('table-mode');
  host.style.gridTemplateColumns = `128px repeat(${dayCount}, minmax(26px, 1fr))`;
  host.classList.toggle('wide', dayCount > 16);

  host.append(el('div', { class: 'matrix-corner', text: 'Cohort' }));
  for (let d = 0; d <= state.config.days; d += 1) {
    host.append(el('div', { class: 'matrix-colhead', text: d === 0 ? 'D0' : `D${d}` }));
  }

  for (const cohort of cohorts) {
    const head = el('div', { class: 'matrix-rowhead' }, [
      el('span', { class: 'coh-date', text: `${WEEKDAYS[cohort.weekday]} ${fmtDate(cohort.cohort)}` }),
      el('span', { class: 'coh-size', text: fmtInt(cohort.size) }),
    ]);
    head.title = `${cohort.cohort} · ${cohort.size} users`;
    host.append(head);

    for (const day of cohort.days) {
      const value = day.rate;
      const bg = value === null ? null : rateColor(value, maxRate);
      const cell = el('div', {
        class: `cell ${value === null ? (day.eligible ? 'has-value' : 'pending') : 'has-value'}${state.changedCohorts.has(cohort.cohort) ? ' changed' : ''}`,
        role: 'gridcell',
        tabindex: value === null ? -1 : 0,
        'aria-label': `${cohort.cohort} day ${day.offset}: ${value === null ? 'not observable' : fmtPct(value)}`,
      });
      if (value === null) {
        cell.classList.add('empty');
        cell.title = day.eligible ? 'No active users' : 'Not yet observable';
      } else {
        cell.style.background = bg;
        cell.style.color = state.matrixMode === 'count' ? inkFor(bg) : inkFor(bg);
        cell.textContent = String(state.matrixMode === 'rate' ? Math.round(value * 100) : day.active);
        const show = (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect();
          tooltip.show(
            [
              el('div', { class: 'tt-kicker', text: `Cohort ${cohort.cohort} · day ${day.offset}` }),
              el('div', { class: 'tt-value', text: fmtPct(value) }),
              el('div', { class: 'tt-row' }, [
                el('span', { text: 'Active' }),
                el('b', { text: `${fmtInt(day.active)} of ${fmtInt(day.eligibleUsers ?? cohort.size)}` }),
              ]),
              el('div', { class: 'tt-row' }, [
                el('span', { text: 'Repeat events' }),
                el('b', { text: fmtInt(day.repeatEvents) }),
              ]),
              el('div', { class: 'tt-row' }, [
                el('span', { text: 'Slot' }),
                el('b', { text: cohort.anchoredAtEntry ? '24h from entry' : `${(day.slotLengthMs / 3_600_000).toFixed(day.slotLengthMs % 3_600_000 ? 1 : 0)}h` }),
              ]),
              el('div', { class: 'tt-note', text: `${fmtDateTime(day.slotStart)} → ${fmtDateTime(day.slotEnd)}` }),
            ].filter(Boolean),
            rect.right,
            rect.top,
          );
        };
        cell.addEventListener('pointerenter', show);
        cell.addEventListener('focus', show);
        cell.addEventListener('pointerleave', () => tooltip.hide());
        cell.addEventListener('blur', () => tooltip.hide());
        cell.addEventListener('click', () => {
          tooltip.hide();
          openCohortCohort(cohort.cohort);
        });
      }
      host.append(cell);
    }
  }

  renderMatrixLegend(maxRate);
}

function renderMatrixLegend(maxRate) {
  const legend = $('#matrix-legend');
  legend.replaceChildren();
  legend.append(el('span', { text: state.matrixMode === 'rate' ? 'Rate' : 'Active users' }));
  const scale = el('div', { class: 'legend-scale' });
  const steps = 7;
  for (let i = 0; i < steps; i += 1) {
    const rate = ((i + 0.5) / steps) * maxRate;
    scale.append(el('span', { class: 'legend-swatch', style: `background:${rateColor(rate, maxRate)}` }));
  }
  legend.append(scale);
  const labels = el('div', { class: 'legend-labels' });
  const topRate = Math.max(0.05, ...state.report.cohorts.flatMap((c) => c.days.filter((d) => d.offset > 0).map((d) => d.rate ?? 0)));
  labels.append(
    el('span', { text: state.matrixMode === 'rate' ? '0%' : '0' }),
    el('span', { text: state.matrixMode === 'rate' ? fmtPct(topRate, 0) : fmtInt(Math.max(...state.report.cohorts.flatMap((c) => c.days.filter((d) => d.offset > 0).map((d) => d.active)))) }),
  );
  legend.append(labels);
  legend.append(
    el('span', { class: 'chip', text: 'Blank = not yet observable' }),
    el('span', { class: 'chip', text: 'Orange outline = changed by last revision' }),
  );
}

function buildMatrixTable() {
  const report = state.report;
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'matrix-table' });
  const thead = el('thead');
  const headRow = el('tr', {}, [el('th', { text: 'Cohort' }), el('th', { text: 'Users' })]);
  for (let d = 0; d <= state.config.days; d += 1) headRow.append(el('th', { text: `D${d}` }));
  thead.append(headRow);
  const tbody = el('tbody');
  for (const cohort of report.cohorts) {
    const row = el('tr', {}, [
      el('td', { text: `${WEEKDAYS[cohort.weekday]} ${cohort.cohort}` }),
      el('td', { text: fmtInt(cohort.size) }),
    ]);
    for (const day of cohort.days) {
      row.append(
        el('td', {
          text: day.rate === null ? '—' : state.matrixMode === 'rate' ? fmtPct(day.rate) : fmtInt(day.active),
        }),
      );
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function openCohortCohort() {
  /* Cohort drill-down is represented by the boundary-case inspector. */
}

// ---------------------------------------------------------------- compare

function renderCompare() {
  const host = $('#compare-chart');
  host.replaceChildren();
  if (!state.compare) return;
  const report = state.report;
  const day = state.config.days;
  const width = host.clientWidth || 700;
  const height = 260;
  const pad = { t: 14, r: 52, b: 26, l: 40 };
  const series = ['calendar', 'rolling24h', 'business'].map((key) => ({
    key,
    name: state.compare[key].label,
    color: cssVar(CONVENTION_COLORS[key].replace('var(', '').replace(')', '')) || CONVENTION_COLORS[key],
    points: state.compare[key].aggregates.filter((d) => d.rate !== null && d.offset >= 1),
  }));

  const maxOffset = Math.min(state.config.days, Math.max(...series.map((s) => s.points.at(-1)?.offset ?? 0)));
  const rates = series.flatMap((s) => s.points.map((d) => d.rate));
  const maxRate = Math.max(0.05, ...rates) * 1.08;
  const minOffset = 1;
  const x = (offset) => pad.l + ((offset - minOffset) / Math.max(1, maxOffset - minOffset)) * (width - pad.l - pad.r);
  const y = (rate) => pad.t + (1 - rate / maxRate) * (height - pad.t - pad.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Day retention by convention' });

  // Gridlines, solid hairlines.
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (i / ticks) * maxRate;
    const gy = y(value);
    svg.append(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: gy, y2: gy, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: pad.l - 8, y: gy + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--text-muted)' });
    label.textContent = `${Math.round(value * 100)}%`;
    svg.append(label);
  }
  for (let d = minOffset; d <= maxOffset; d += maxOffset <= 14 ? 2 : 5) {
    const label = svgEl('text', { x: x(d), y: height - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--text-muted)' });
    label.textContent = `D${d}`;
    svg.append(label);
  }

  for (const s of series) {
    if (s.points.length < 2) continue;
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.offset).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.key === report.meta.convention ? 1 : 0.9 }));
    const last = s.points.at(-1);
    svg.append(svgEl('circle', { cx: x(last.offset), cy: y(last.rate), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  }

  // Selected day marker.
  const markerX = x(Math.min(day, maxOffset));
  svg.append(svgEl('line', { x1: markerX, x2: markerX, y1: pad.t, y2: height - pad.b, stroke: 'var(--axis)', 'stroke-width': 1 }));

  // Hover layer: snap to nearest day offset, show all three series.
  const overlay = svgEl('rect', { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b, fill: 'transparent' });
  const crosshair = svgEl('line', { y1: pad.t, y2: height - pad.b, stroke: 'var(--text-muted)', 'stroke-width': 1, opacity: 0 });
  svg.append(crosshair, overlay);
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    const offset = Math.max(minOffset, Math.min(maxOffset, Math.round(minOffset + ((px - pad.l) / (width - pad.l - pad.r)) * (maxOffset - minOffset))));
    crosshair.setAttribute('x1', x(offset));
    crosshair.setAttribute('x2', x(offset));
    crosshair.setAttribute('opacity', 0.5);
    const rows = series.map((s) => {
      const point = s.points.find((p) => p.offset === offset);
      return el('div', { class: 'tt-row' }, [
        el('span', {}, [el('span', { class: 'legend-line', style: `display:inline-block;background:${s.color};width:12px;height:2px;border-radius:1px;margin-right:6px` }), s.name]),
        el('b', { text: point ? fmtPct(point.rate) : '—' }),
      ]);
    });
    tooltip.show([el('div', { class: 'tt-kicker', text: `Day ${offset} · all conventions` }), ...rows], ev.clientX, ev.clientY);
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', 0);
    tooltip.hide();
  });

  host.append(svg);

  const legend = $('#compare-legend');
  legend.replaceChildren(
    ...series.map((s) => {
      const atDay = s.points.find((p) => p.offset === Math.min(day, maxOffset)) ?? s.points.at(-1);
      return el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-line', style: `background:${s.color}` }),
        `${s.name}`,
        el('b', { text: atDay ? fmtPct(atDay.rate, 1) : '—', style: 'font-variant-numeric:tabular-nums' }),
        el('span', { class: 'flow-note', text: `at D${atDay?.offset ?? '—'}`, style: 'padding:0' }),
      ]);
    }),
    el('span', { class: 'chip info', text: `Selected: ${report.meta.conventionLabel}` }),
  );
}

// ---------------------------------------------------------------- breakdown

function renderBreakdown() {
  const host = $('#breakdown');
  host.replaceChildren();
  const report = state.report;
  const dimensions = ['plan', 'platform', 'appVersion'].filter((d) => report.breakdowns[d]?.length);
  const focusDays = [1, 7].filter((d) => d <= state.config.days);
  for (const dim of dimensions) {
    const rows = [...report.breakdowns[dim]].slice(0, 6);
    const panel = el('div', { class: 'bd-panel' });
    panel.append(el('div', { class: 'bd-title', text: dim === 'appVersion' ? 'App version at entry' : dim }));
    const head = el('div', { class: 'bd-head' }, [
      el('span', { text: '' }),
      el('span', { text: 'Share of cohort' }),
      ...focusDays.map((d) => el('span', { text: `D${d}` })),
    ]);
    panel.append(head);
    const total = rows.reduce((s, r) => s + r.users, 0) || 1;
    for (const row of rows) {
      const share = row.users / total;
      const line = el('div', { class: 'bd-row' }, [
        el('span', { class: 'bd-name', text: row.value, title: `${row.users} users` }),
        el('span', { class: 'bd-bar' }, [el('i', { style: `width:${(share * 100).toFixed(1)}%` })]),
        ...focusDays.map((d) => {
          const rate = row.days[d]?.rate;
          return el('span', {
            class: `bd-val${rate === null || rate === undefined ? ' muted' : ''}`,
            text: rate === null || rate === undefined ? '—' : fmtPct(rate, 0),
            title: row.days[d] ? `${row.days[d].active} of ${row.days[d].eligible}` : '',
          });
        }),
      ]);
      panel.append(line);
    }
    host.append(panel);
  }
}

// ---------------------------------------------------------------- sample ledger

function renderSampleLedger() {
  const host = $('#sample-ledger');
  const report = state.report;
  const users = report.exclusions.users;
  const events = report.exclusions.events;
  host.replaceChildren();

  const flow = el('div', { class: 'ledger-flow' });
  flow.append(
    flowRow('Identities in dataset', fmtInt(users.totalIdentities), 'total'),
    flowRow('No qualifying cohort event', `−${fmtInt(users.noCohortEvent)}`, 'deduct'),
    flowRow('Outside selected segment', `−${fmtInt(users.filteredBySegment)}`, 'deduct'),
    flowRow('Cohort outside date range', `−${fmtInt(users.outsideRange)}`, 'deduct'),
    flowRow('Cohort users in report', fmtInt(users.included), 'total'),
  );
  host.append(flow);
  host.append(
    el('div', { class: 'flow-note', text: `${fmtInt(report.meta.cohortCount)} cohort days · ${fmtInt(report.meta.cohortUsers)} users · ${fmtInt(events.adoptedEvents)} events adopted from ${fmtInt(events.mergedIdentities)} merged anonymous identities` }),
  );

  const reasons = el('div', { class: 'reason-list' });
  reasons.append(el('div', { class: 'bd-title', text: 'Excluded or adjusted' }));
  for (const reason of report.exclusions.reasons) {
    reasons.append(
      el('div', { class: `reason-row${reason.count === 0 ? ' zero' : ''}`, title: reason.label }, [
        el('span', { text: reason.label }),
        el('span', { class: 'n', text: `${fmtInt(reason.count)} ${reason.unit === 'events' ? 'ev' : reason.unit === 'identities' ? 'ids' : 'users'}` }),
      ]),
    );
  }
  host.append(reasons);
}

function flowRow(label, value, kind) {
  return el('div', { class: `flow-row ${kind}` }, [el('span', { text: label }), el('span', { class: 'count', text: value })]);
}

// ---------------------------------------------------------------- DST ledger

function renderDstLedger() {
  const report = state.report;
  const host = $('#dst-ledger');
  const dst = report.dst;
  host.replaceChildren();
  $('#dst-sub').textContent = report.meta.convention === 'rolling24h'
    ? 'Rolling windows never stretch; civil days near a transition still do.'
    : `Slot calendar: ${dst.slotZone}`;

  const chips = el('div', { class: 'chip-row' });
  if (!dst.transitions.length && report.meta.convention !== 'rolling24h') {
    const hint = el('button', {
      class: 'chip info',
      type: 'button',
      text: 'No DST in this zone — try America/New_York',
      style: 'cursor:pointer',
      onclick: () => {
        state.config.reportingZone = 'America/New_York';
        $('#zone-select').value = 'America/New_York';
        refresh({ compare: true });
      },
    });
    chips.append(hint);
  }
  chips.append(el('span', { class: 'chip', text: dst.slotZone }));
  if (dst.transitions.length) chips.append(el('span', { class: 'chip warn', text: `${dst.transitions.length} DST transition${dst.transitions.length > 1 ? 's' : ''}` }));
  if (dst.shiftedDays.length) chips.append(el('span', { class: 'chip info', text: `${dst.shiftedDays.length} shifted day${dst.shiftedDays.length > 1 ? 's' : ''}` }));
  if (!dst.transitions.length && !dst.shiftedDays.length) chips.append(el('span', { class: 'chip', text: 'No transitions in range' }));
  host.append(chips);

  for (const t of dst.transitions) {
    host.append(
      el('div', { class: 'dst-row' }, [
        el('span', { class: 'dst-date', text: t.date }),
        el('span', { class: 'dst-what' }, [
          `${t.fromOffsetLabel} → ${t.toOffsetLabel}`,
          el('small', { text: `${t.direction.replace('-', ' ')} at ${fmtDateTime(t.atIso)} · ${t.hours}h day` }),
        ]),
      ]),
    );
  }
  for (const day of dst.shiftedDays.slice(0, 6)) {
    host.append(
      el('div', { class: 'dst-row' }, [
        el('span', { class: 'dst-date', text: day.date }),
        el('span', { class: 'dst-what' }, [
          `${day.hours}h day`,
          el('small', { text: `${fmtDateTime(day.slotStart)} → ${fmtDateTime(day.slotEnd)}` }),
        ]),
      ]),
    );
  }

  const notes = el('div', { class: 'reason-list' });
  notes.append(el('div', { class: 'bd-title', text: 'How this convention reads' }));
  for (const note of dst.notes) notes.append(el('div', { class: 'flow-note', text: note }));
  host.append(notes);
}

function renderAlerts() {
  const host = $('#dst-ledger');
  for (const alert of state.report.alerts) {
    host.append(
      el('div', { class: `alert${alert.level === 'warn' ? ' warn' : ''}` }, [
        el('span', { class: 'dot' }),
        el('div', {}, [
          el('div', { class: 'alert-title', text: alert.title }),
          el('div', { class: 'alert-detail', text: alert.detail }),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- versions

function renderVersions() {
  const host = $('#version-list');
  const versions = state.boot.versions;
  host.replaceChildren();
  for (const v of [...versions].reverse()) {
    const row = el('div', {
      class: `version-row${state.selectedVersion === v.version ? ' selected' : ''}`,
      role: 'button',
      tabindex: 0,
      title: 'Show this version as-of the current filters',
      onclick: () => selectVersion(v.version),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') selectVersion(v.version);
      },
    }, [
      el('span', { class: 'version-tag', text: `v${v.version}` }),
      el('span', { class: 'version-label', text: v.label }),
      el('span', { class: 'version-events', text: fmtInt(v.events) }),
    ]);
    host.append(row);
  }
}

async function selectVersion(version) {
  state.selectedVersion = version;
  state.config.version = version === state.boot.dataset.version ? 'latest' : version;
  await refresh({ compare: false });
  state.changedCohorts = new Set(
    state.report.cohorts.filter((c) => c.size > 0).map((c) => c.cohort),
  );
  // Diff against the previous version to highlight what actually moved.
  const previous = state.boot.versions.find((v) => v.version === version - 1);
  if (previous) {
    try {
      const diff = await api('/api/diff', {
        method: 'POST',
        body: JSON.stringify({ ...reportPayload(), version: undefined, a: previous.version, b: version }),
      });
      state.changedCohorts = new Set(diff.cohorts.filter((c) => c.changed).map((c) => c.cohort));
      renderMatrix();
      renderVersionDiff(diff, previous.version, version);
      showRecomputeReadout({
        headline: `v${version} viewed`,
        detail: `Compared with v${previous.version}.`,
        changed: diff.changedCohorts,
        total: diff.changedCohorts + diff.unchangedCohorts,
        mode: 'diff',
      });
    } catch (err) {
      console.warn(err);
    }
  } else {
    renderVersionDiff(null);
  }
  renderVersions();
}

/**
 * Per-cohort, per-day deltas between two versions. The matrix only marks whole
 * rows; this is where the actual movement (which day gained or lost users) is
 * readable.
 */
function renderVersionDiff(diff, fromVersion, toVersion) {
  const host = $('#version-diff');
  host.replaceChildren();
  if (!diff) {
    host.hidden = true;
    return;
  }
  const changed = diff.cohorts.filter((c) => c.changed);
  const attrChanged = changed.filter((c) => c.compositionChanged?.length);
  if (!changed.length) {
    host.hidden = false;
    host.append(el('p', { class: 'flow-note', text: `v${toVersion} matches v${fromVersion} under these filters.` }));
    return;
  }
  host.hidden = false;
  if (attrChanged.length) {
    const rows = attrChanged.slice(0, 4).map((c) =>
      el('div', { class: 'diff-attr-row' }, [
        el('span', { class: 'diff-attr-cohort', text: fmtDate(c.cohort) }),
        el('span', {
          text: Object.entries(c.compositionDelta)
            .map(([dim, delta]) => `${dim}: ${Object.entries(delta).map(([v, n]) => `${v} ${n > 0 ? '+' : ''}${n}`).join(', ')}`)
            .join(' · '),
        }),
      ]),
    );
    host.append(el('div', { class: 'diff-attr' }, [
      el('strong', { text: 'Entry attributes restated' }),
      ...rows,
      attrChanged.length > 4 ? el('div', { class: 'flow-note', text: `+${attrChanged.length - 4} more cohorts` }) : '',
    ]));
  }
  const table = el('table', { class: 'diff-table' });
  const headRow = el('tr', {}, [
    el('th', { text: 'Cohort' }),
    el('th', { text: 'Users' }),
  ]);
  for (const d of changed[0].days) headRow.append(el('th', { class: 'num', text: `D${d.offset}` }));
  table.append(el('thead', {}, [headRow]));
  const tbody = el('tbody');
  const totals = new Array(changed[0].days.length).fill(0);
  for (const c of changed) {
    const sizeDelta = c.sizeB - c.sizeA;
    const row = el('tr', {}, [
      el('td', { text: fmtDate(c.cohort) }),
      el('td', { class: 'num', text: sizeDelta ? `${fmtInt(c.sizeA)} → ${fmtInt(c.sizeB)}` : fmtInt(c.sizeB) }),
    ]);
    for (const d of c.days) {
      totals[d.offset] += d.delta;
      row.append(el('td', {
        class: `num${d.delta > 0 ? ' up' : d.delta < 0 ? ' down' : ''}`,
        text: d.delta === 0 ? '·' : d.delta > 0 ? `+${d.delta}` : String(d.delta),
        title: `Day ${d.offset}: ${d.activeA} → ${d.activeB}`,
      }));
    }
    tbody.append(row);
  }
  const totalRow = el('tr', { class: 'diff-total' }, [
    el('td', { text: `${changed.length} cohort${changed.length > 1 ? 's' : ''}` }),
    el('td', { class: 'num', text: 'net' }),
  ]);
  for (const t of totals) {
    totalRow.append(el('td', {
      class: `num${t > 0 ? ' up' : t < 0 ? ' down' : ''}`,
      text: t === 0 ? '·' : t > 0 ? `+${t}` : String(t),
    }));
  }
  tbody.append(totalRow);
  table.append(tbody);
  host.append(
    el('div', { class: 'diff-head' }, [
      el('strong', { text: `v${fromVersion} → v${toVersion}` }),
      el('span', { class: 'flow-note', text: 'Active users per cohort-day; · means unchanged.' }),
    ]),
    el('div', { class: 'table-wrap' }, [table]),
  );
}

function renderRevisionForm() {
  const host = $('#revision-form');
  const kinds = [
    { id: 'delete', label: 'Delete an event' },
    { id: 'shift', label: 'Skew one timestamp' },
    { id: 'restate', label: 'Restate plan for a cohort' },
    { id: 'backfill', label: 'Backfill two cohorts' },
    { id: 'merge', label: 'Merge anonymous id' },
  ];
  host.replaceChildren(
    ...kinds.map((k) =>
      el('button', {
        class: 'btn ghost',
        type: 'button',
        text: k.label,
        onclick: () => applyRevision(k.id),
      }),
    ),
  );
}

async function applyRevision(kind) {
  const args = {};
  if (kind === 'restate') {
    // Pick a cohort that still has entrants on the source plan, so repeated
    // clicks move different cohorts instead of failing on an already-restated one.
    const cohorts = state.report?.cohorts ?? [];
    const withPlan = (plan) => cohorts.filter((c) => (c.composition?.plan?.[plan] ?? 0) > 0);
    const free = withPlan('free');
    const pro = withPlan('pro');
    const [from, to, pool] = free.length ? ['free', 'pro', free] : pro.length ? ['pro', 'free', pro] : [];
    if (!pool) return toast('Every cohort has already been restated', 'error');
    args.cohortKey = pool[Math.floor(pool.length / 2)].cohort;
    args.dimension = 'plan';
    args.from = from;
    args.to = to;
    args.zone = state.report.meta.cohortZone;
    args.cohortEvent = state.config.cohortEvent;
  }
  if (kind === 'backfill') {
    const cohorts = state.report?.cohorts ?? [];
    if (cohorts.length < 3) return;
    args.cohortKeys = cohorts.slice(1, 3).map((c) => c.cohort);
    args.zone = state.report.meta.cohortZone;
    args.cohortEvent = state.config.cohortEvent;
  }
  try {
    const out = await api('/api/revisions', {
      method: 'POST',
      body: JSON.stringify({ kind, args, config: reportPayload() }),
    });
    state.boot.versions = out.versions;
    state.boot.dataset = out.dataset;
    state.selectedVersion = out.revision.version;
    state.config.version = 'latest';
    await refresh({ compare: true });
    state.changedCohorts = new Set(out.recompute.affectedCohorts ?? []);
    renderMatrix();
    showRecomputeReadout({
      headline: `v${out.revision.version} · ${out.revision.label}`,
      detail: out.revision.summary,
      changed: out.recompute.recomputedCohorts,
      total: out.recompute.recomputedCohorts + out.recompute.reusedCohorts,
      users: out.recompute.affectedUsers,
      durationMs: out.recompute.durationMs,
      mode: out.recompute.mode,
    });
    toast(`Recomputed ${out.recompute.recomputedCohorts} of ${out.recompute.recomputedCohorts + out.recompute.reusedCohorts} cohorts`);
  } catch (err) {
    toast(err.message, 'error');
    showRecomputeReadout({ headline: 'Revision rejected', detail: err.message, changed: 0, total: 0, mode: 'error' });
  }
}

function showRecomputeReadout({ headline, detail, changed, total, users, durationMs, mode }) {
  const host = $('#recompute-readout');
  host.replaceChildren();
  const label = mode === 'diff' ? 'Changed' : 'Recomputed';
  host.append(el('div', {}, [el('strong', { text: headline })]));
  host.append(el('div', { text: `${label} ${changed} of ${total} cohorts${users !== undefined ? ` · ${users} users touched` : ''}${durationMs !== undefined ? ` · ${durationMs.toFixed(1)} ms` : ''}` }));
  host.append(el('div', { class: 'flow-note', text: detail || '', style: 'padding-left:0' }));
  const bar = el('div', { class: 'bar' });
  const pct = total > 0 ? (changed / total) * 100 : 0;
  bar.append(el('i', { style: `width:${pct.toFixed(1)}%;background:${mode === 'full' || mode === 'rebuild' ? 'var(--series-2)' : 'var(--accent)'}` }));
  host.append(bar);
}

async function resetData() {
  state.planDomain = null;
  try {
    const out = await api('/api/reset', { method: 'POST', body: '{}' });
    state.boot.dataset = out.dataset;
    state.boot.versions = out.versions;
    state.selectedVersion = null;
    state.config.version = 'latest';
    state.changedCohorts.clear();
    $('#recompute-readout').replaceChildren(el('div', { class: 'flow-note', text: 'Dataset restored to the seeded version.' }));
    await refresh({ compare: true });
    toast('Dataset reset');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- cases

function renderCases() {
  const host = $('#cases-grid');
  host.replaceChildren();
  const cases = state.boot.cases ?? [];
  // A case's offsets depend on the report's zones and cohort rule, so an open
  // case is re-fetched only when one of those actually changed.
  if (state.caseOpen) {
    const open = cases.find((c) => c.id === state.caseOpen);
    if (!open?.identity) {
      state.caseOpen = null;
      state.caseKey = null;
      $('#case-detail').hidden = true;
    } else if (state.caseKey !== caseParams(open).toString()) {
      renderCaseDetail(open);
    }
  }
  for (const c of cases) {
    if (!c.identity) continue;
    const btn = el('button', {
      class: 'case-card',
      type: 'button',
      'aria-expanded': String(state.caseOpen === c.id),
      onclick: () => openCase(c),
    }, [
      el('span', { class: 'case-kind', text: c.kind }),
      el('span', { class: 'case-title', text: c.title }),
      el('span', { class: 'case-desc', text: c.description }),
    ]);
    host.append(btn);
  }
}

function caseParams(c) {
  return new URLSearchParams({
    identity: c.identity,
    reportingZone: state.config.reportingZone,
    businessZone: state.config.businessZone,
    cohortEvent: state.config.cohortEvent,
  });
}

async function openCase(c) {
  if (state.caseOpen === c.id) {
    state.caseOpen = null;
    state.caseKey = null;
    $('#case-detail').hidden = true;
    renderCases();
    return;
  }
  const detail = $('#case-detail');
  detail.hidden = false;
  detail.replaceChildren(el('div', { class: 'skeleton', text: 'Loading case…' }));
  state.caseOpen = c.id;
  state.caseKey = caseParams(c).toString();
  renderCases();
  await renderCaseDetail(c);
}

async function renderCaseDetail(c) {
  const detail = $('#case-detail');
  const params = caseParams(c);
  state.caseKey = params.toString();
  try {
    const data = await api(`/api/case?${params}`);
    const events = data.events;
    const entry = events.find((e) => e.name === 'signup') ?? events[0];
    const heading = el('h3', { text: `${c.title} · ${data.canonicalUser}` });
    const sub = el('p', {
      class: 'sub',
      text: `Canonical identities: ${data.knownIdentities.join(', ')}. Entry ${fmtDateTime(data.entryAt)}. Day offsets are relative to each user's own entry.`,
    });
    const table = el('table', { class: 'event-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: `Local (${state.config.reportingZone})` }),
          el('th', { text: 'Event time (UTC)' }),
          el('th', { text: 'Local offset' }),
          el('th', { text: 'Received lag' }),
          el('th', { text: 'Natural day' }),
          el('th', { text: 'Rolling 24h' }),
          el('th', { text: 'Business' }),
        ]),
      ]),
    );
    const tbody = el('tbody');
    for (const e of events) {
      const cal = e.offsets.calendar?.offset;
      const roll = e.offsets.rolling24h?.offset;
      const biz = e.offsets.business?.offset;
      const values = [cal, roll, biz];
      const settled = values.filter((v) => v !== null && v !== undefined);
      const diverges = new Set(settled).size > 1;
      const row = el('tr', { class: `${e.eventId === entry.eventId ? 'entry' : ''}${diverges ? ' diff-row' : ''}` }, [
        el('td', { text: e.local }),
        el('td', { text: e.iso.slice(0, 19).replace('T', ' ') }),
        el('td', { text: e.offsetLabel }),
        el('td', { class: 'num', text: e.lagHours >= 24 ? `${Math.round(e.lagHours / 24)}d` : `${e.lagHours}h` }),
        ...values.map((v) =>
          el('td', {}, [
            el('span', {
              class: `offset-badge${v === null || v === undefined ? ' null' : ''}${diverges ? ' diff' : ''}`,
              text: v === null || v === undefined ? '—' : String(v),
            }),
          ]),
        ),
      ]);
      tbody.append(row);
    }
    table.append(tbody);
    const diverging = events.filter((e) => {
      const v = [e.offsets.calendar?.offset, e.offsets.rolling24h?.offset, e.offsets.business?.offset]
        .filter((x) => x !== null && x !== undefined);
      return new Set(v).size > 1;
    });
    const hasNull = events.some((e) =>
      Object.values(e.offsets).some((o) => o?.offset === null || o?.offset === undefined),
    );
    let noteText;
    if (diverging.length) {
      noteText = `${diverging.length} event${diverging.length > 1 ? 's land' : ' lands'} on a different day under at least one convention (highlighted). An em dash means the event precedes that convention's cohort start, so it cannot be a retention hit.`;
    } else if (hasNull) {
      noteText = 'An em dash means the event happened before that convention\'s cohort start, so it cannot be a retention hit.';
    } else {
      noteText = 'All three conventions agree on this case.';
    }
    const note = el('p', { class: 'sub', text: noteText, style: 'margin-top:10px;margin-bottom:0' });
    detail.replaceChildren(heading, sub, el('div', { class: 'table-wrap' }, [table]), note);
  } catch (err) {
    detail.replaceChildren(el('p', { class: 'sub', text: err.message }));
  }
}

// ---------------------------------------------------------------- composition

function renderComposition() {
  const host = $('#matrix-sub');
  const report = state.report;
  const plan = report.composition.totals.plan ?? {};
  renderPlanOptions(plan);
  const parts = Object.entries(plan)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${Math.round((v / (report.meta.cohortUsers || 1)) * 100)}%`);
  host.textContent = `${fmtInt(report.meta.cohortCount)} cohorts · ${fmtInt(report.meta.cohortUsers)} users (${parts.join(' · ')}). Blank cells are not yet observable.`;
}

/**
 * Plan values come from the report itself, so the filter never offers a plan
 * with no users. The selected value is preserved across refreshes.
 */
function renderPlanOptions(totals) {
  const select = $('#plan-select');
  const current = state.config.segments.plan?.[0] ?? '';
  // Keep a union with what we have already seen. A filtered report only
  // contains the selected plan, so deriving options from it alone would strand
  // the user inside that filter.
  state.planDomain = state.planDomain || new Map();
  if (!current) for (const [value, count] of Object.entries(totals)) state.planDomain.set(value, count);
  const domain = Object.fromEntries(state.planDomain);
  const values = Object.keys({ ...domain, ...(current ? {} : totals) })
    .sort((a, b) => (domain[b] ?? 0) - (domain[a] ?? 0));
  const wanted = ['', ...values].join('|');
  if (select.dataset.options === wanted) {
    if (select.value !== current) select.value = current;
    return;
  }
  select.replaceChildren(el('option', { value: '', text: 'All plans' }));
  for (const value of values) {
    select.append(el('option', { value, text: `${value} (${fmtInt(domain[value] ?? 0)})` }));
  }
  select.dataset.options = wanted;
  select.value = values.includes(current) ? current : '';
  if (select.value !== current) {
    const { plan: _, ...rest } = state.config.segments;
    state.config.segments = rest;
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    state.boot = await api('/api/bootstrap');
    state.config.asOf = state.boot.now;
    state.config.from = state.boot.dataset.signupStart ?? addDays(state.boot.todayLocal, -75);
    state.config.to = state.boot.dataset.signupEnd ?? state.boot.todayLocal;
    buildControls();
    renderRevisionForm();
    await refresh({ compare: true });
    window.addEventListener('resize', () => {
      renderSparkline();
      renderCompare();
    });
  } catch (err) {
    document.body.replaceChildren(
      el('div', { class: 'app' }, [el('p', { text: `Failed to load: ${err.message}` })]),
    );
  }
}

function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

boot();
