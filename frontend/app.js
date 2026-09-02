'use strict';

/* SmartPlant frontend SPA — talks only to the backend API (source of truth). */

const $ = (sel) => document.querySelector(sel);
const state = {
  token: localStorage.getItem('sp_token') || null,
  user: null,
  permissions: [],
  demo: false,
  seededDemo: false,
  registrationOpen: false,
  aiEngine: 'fallback-deterministic',
  conv: [],
  convId: null,
  convs: [],
  widgetConv: [],
  widgetConvId: null,
  widgetOpen: false,
  notifTimer: null,
};

/* ---------------- API ---------------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (res.status === 401 && state.token) {
    state.token = null;
    localStorage.removeItem('sp_token');
    state.conv = [];
    state.convId = null;
    state.widgetConv = [];
    showLogin('Session expired — please sign in again. Your previous browser session no longer matches this server.');
    throw new Error('Session expired — sign in again.');
  }
  if (!res.ok) {
    const msg = json?.error?.message || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.code = json?.error?.code;
    throw err;
  }
  return json?.data !== undefined ? json.data : json;
}

async function downloadReport(kind, format) {
  const res = await fetch(`/api/reports/${kind}?format=${format}`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!res.ok) throw new Error('Report export failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.${format}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function can(perm) {
  return state.permissions.includes(perm);
}

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n, d = 1) { return n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }); }
function fmtAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}
function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
function fmtFresh(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}
function toLocalInput(date) {
  const d = date ? new Date(date) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sevClass(s) { return `badge-sev sev-${s}`; }
function statusTag(s) { return s ? `<span class="status-tag st-${esc(s)}">${esc(s)}</span>` : '—'; }
function healthBar(h) {
  const cls = h >= 70 ? 'hb-good' : h >= 40 ? 'hb-mid' : 'hb-bad';
  return `<span class="health-bar"><span class="${cls}" style="width:${Math.max(0, Math.min(100, h))}%"></span></span>${Math.round(h)}/100`;
}
function lineChart(canvas, labels, values, color = '#26a69a') {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!values.length) { ctx.fillStyle = '#8b949e'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No data in range', w / 2, h / 2); return; }
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => pad.l + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
  ctx.strokeStyle = '#2d3748'; ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + ((max - min) / 4) * g, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(fmt(v, 1), pad.l - 6, yy + 3);
  }
  ctx.textAlign = 'center';
  ctx.beginPath();
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  values.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
  ctx.stroke();
  ctx.fillStyle = color;
  values.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2.5, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = '#8b949e';
  if (labels.length > 12) {
    const step = Math.ceil(labels.length / 8);
    labels.forEach((l, i) => { if (i % step === 0) ctx.fillText(esc(l), x(i), h - 8); });
  } else {
    labels.forEach((l, i) => ctx.fillText(esc(l), x(i), h - 8));
  }
}

/* ---------------- markdown-lite (AI replies) ---------------- */
function renderMd(text) {
  return esc(text)
    .replace(/^### (.*)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^[-•] (.*)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast toast-${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, 3500);
}

function asList(x) {
  if (Array.isArray(x)) return x;
  return Array.isArray(x?.data) ? x.data : [];
}

/* ---------------- views registry ---------------- */
const views = {};

/* ============================================================ dashboard */
views.dashboard = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const d = await api('GET', '/api/dashboard');
  const k = d.kpis;
  el.innerHTML = `
    <div class="grid grid-4">
      <div class="kpi"><div class="kpi-label">Current load</div><div class="kpi-value">${fmt(k.current_load_kw)} kW</div></div>
      <div class="kpi"><div class="kpi-label">Machines</div><div class="kpi-value">${k.active_machines}<span class="muted" style="font-size:14px"> / ${k.total_machines}</span></div>
        <div class="kpi-sub">${k.stale_machines} stale · ${k.offline_machines ?? 0} offline</div></div>
      <div class="kpi"><div class="kpi-label">Energy today</div><div class="kpi-value">${fmt(k.energy_today_kwh, 0)} kWh</div>
        <div class="kpi-sub">≈ $${fmt(k.cost_today_usd, 2)} · monthly ≈ $${fmt(k.monthly_estimate_usd, 0)}</div></div>
      <div class="kpi"><div class="kpi-label">Active alerts</div><div class="kpi-value" style="color:${k.active_alerts ? 'var(--warn)' : '#57ab5a'}">${k.active_alerts}</div>
        <div class="kpi-sub">${k.critical_alerts || 0} critical · ${k.unread_notifications || 0} unread notifications</div></div>
    </div>
    <div class="grid grid-2 mt16">
      <div class="card"><h3>Energy — last 24h (kWh per half hour)</h3><canvas id="ch-energy" style="width:100%;height:200px"></canvas></div>
      <div class="card"><h3>Avg temperature — last 24h (°C)</h3><canvas id="ch-temp" style="width:100%;height:200px"></canvas></div>
    </div>
    <div class="card"><h3>Machines</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Machine</th><th>Status</th><th>Health</th><th>Temp (°C)</th><th>Power (kW)</th><th>Updated</th></tr></thead>
        <tbody>${d.machines.map((m) => `
          <tr class="row-link" data-id="${esc(m.id)}">
            <td><span class="machine-cell"><img class="machine-thumb" src="/${esc(m.image || 'images/logo.png')}" alt="" loading="lazy"><span class="mc-text"><b>${esc(m.name)}</b><br><span class="muted mono">${esc(m.id)}</span></span></span></td>
            <td>${statusTag(m.status)}</td>
            <td>${healthBar(m.health_score)}</td>
            <td>${fmt(m.temperature_c?.value)}</td>
            <td>${fmt(m.power_kw?.value)}</td>
            <td class="muted">${fmtFresh(m.data_freshness_seconds)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Active alerts (${(d.active_alerts || []).length})</h3>
        ${d.active_alerts?.length ? `<table><tbody>${d.active_alerts.slice(0, 8).map((a) => `
          <tr data-alert="${esc(a.id)}" class="row-link">
            <td><span class="${sevClass(a.severity)}">${a.severity}</span></td>
            <td><b>${esc(a.type.replace(/_/g, ' '))}</b> <span class="muted">· ${esc(a.machine_name || a.machine_id)}</span></td>
            <td class="muted">${fmtAgo(a.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No active alerts 🎉</div>'}
        <div class="mt8"><a class="link" href="#/alerts">Open alerts →</a></div>
      </div>
      <div class="card"><h3>Upcoming tasks (${(d.upcoming_tasks || []).length})</h3>
        ${d.upcoming_tasks?.length ? `<table><tbody>${d.upcoming_tasks.slice(0, 8).map((t) => `
          <tr><td><span class="${sevClass(t.priority)}">${t.priority}</span></td>
          <td><b>${esc(t.title)}</b><br><span class="muted">${esc(t.machine_name || t.machine_id || 'Plant-wide')}</span></td>
          <td class="muted">${fmtDate(t.due_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No upcoming tasks</div>'}
        <div class="mt8"><a class="link" href="#/tasks">Open tasks →</a></div>
      </div>
    </div>`;
  lineChart($('#ch-energy'), d.energy_series.map((p) => p.ts.slice(11, 16)), d.energy_series.map((p) => p.value), '#f0a500');
  lineChart($('#ch-temp'), d.temperature_series.map((p) => p.ts.slice(11, 16)), d.temperature_series.map((p) => p.value), '#58a6ff');
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/machines/${tr.dataset.id}`; }));
  el.querySelectorAll('tr[data-alert]').forEach((tr) => tr.addEventListener('click', () => { location.hash = '#/alerts'; }));
};

/* ============================================================ machines */
const MACHINE_TYPES = ['EXTRUSION', 'MILLING', 'MIXING', 'PRESSING', 'ROBOT', 'MOLDING', 'WELDING', 'CONVEYOR', 'PACKAGING', 'COOLING', 'LASER', 'LATHE', 'PALLETIZER', 'TESTBENCH', 'OTHER'];

function machineModal(machine, onSaved) {
  const isEdit = !!machine;
  openModal(isEdit ? `Edit machine — ${esc(machine.name)}` : 'Add machine', `
    <div class="field"><label>Name *</label><input id="m-name" class="input" value="${esc(machine?.name || '')}" placeholder="e.g. Primary Extruder" /></div>
    <div class="grid grid-2">
      <div class="field"><label>Type</label>
        <select id="m-type" class="select">${MACHINE_TYPES.map((t) => `<option ${machine?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label>
        <select id="m-status2" class="select">${['OFF', 'RUNNING', 'IDLE', 'MAINTENANCE', 'FAULT', 'OFFLINE'].map((s) => `<option ${machine?.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="grid grid-2">
      <div class="field"><label>Shift start (UTC)</label><input id="m-start" type="time" class="input" value="${esc(machine?.schedule?.startTime || '08:00')}" /></div>
      <div class="field"><label>Shift end / sleep (UTC)</label><input id="m-sleep" type="time" class="input" value="${esc(machine?.schedule?.sleepTime || '17:00')}" /></div>
    </div>
    <div class="grid grid-2">
      <div class="field"><label>Temp threshold max (°C)</label><input id="m-tmax" type="number" step="any" class="input" value="${machine?.thresholds?.temperature_c?.max ?? 60}" /></div>
      <div class="field"><label>Power threshold max (kW)</label><input id="m-pmax" type="number" step="any" class="input" value="${machine?.thresholds?.power_kw?.max ?? 12}" /></div>
    </div>
    <div class="field"><label>External device id (optional)</label><input id="m-dev" class="input" value="${esc(machine?.external_device_id || '')}" /></div>
    <div class="muted small-note">Thresholds drive the alert engine; schedule drives the AI shutdown estimate.</div>
  `, [
    { label: 'Cancel', cls: 'btn-ghost' },
    { label: isEdit ? 'Save changes' : 'Add machine', cls: 'btn-primary', action: async () => {
      const name = $('#m-name').value.trim();
      if (!name) throw new Error('Machine name is required');
      const body = {
        name,
        type: $('#m-type').value,
        status: $('#m-status2').value,
        external_device_id: $('#m-dev').value.trim() || null,
        thresholds: { temperature_c: { min: null, max: parseFloat($('#m-tmax').value) || 60 }, power_kw: { min: null, max: parseFloat($('#m-pmax').value) || 12 } },
        schedule: { startTime: $('#m-start').value || '08:00', sleepTime: $('#m-sleep').value || '17:00' },
      };
      if (isEdit) await api('PATCH', `/api/machines/${machine.id}`, body);
      else await api('POST', '/api/machines', body);
      closeModal(); toast(isEdit ? 'Machine updated' : 'Machine added — send telemetry to start monitoring'); onSaved();
    } },
  ]);
}

views.machines = async (el, id) => {
  if (id) return views.machineDetail(el, id);
  el.innerHTML = '<div class="spin"></div>';
  const filters = { status: '', search: '' };
  const load = async () => {
    el.innerHTML = '<div class="spin"></div>';
    const q = new URLSearchParams();
    if (filters.status) q.set('status', filters.status);
    if (filters.search) q.set('search', filters.search);
    const list = await api('GET', `/api/machines?${q}`);
    if (!list.data.length) {
      el.innerHTML = `
        <div class="card" style="text-align:center;padding:48px 24px">
          <div style="font-size:44px">🏭</div>
          <h3 style="margin:12px 0 6px">No machines in your plant yet</h3>
          <div class="muted">Nothing is pre-loaded — every machine, reading and answer comes from your live data.</div>
          <div class="flex mt16" style="justify-content:center;flex-wrap:wrap">
            ${can('machines.manage') ? '<button class="btn btn-primary" id="m-add-first">+ Add your first machine</button>' : ''}
            <a class="btn btn-ghost" href="#/ai" id="m-ai-first">✨ Generate a plant with the AI</a>
          </div>
          ${can('machines.manage') ? '<div class="muted mt8 small-note">Or ask the AI Copilot: “Set up my plant: 2 extruders and 1 conveyor”</div>' : ''}
        </div>`;
      if (can('machines.manage')) $('#m-add-first').addEventListener('click', () => machineModal(null, load));
      return;
    }
    const f = `
      <div class="filter-row">
        <input class="input" id="m-search" placeholder="Search name / id…" value="${esc(filters.search)}" />
        <select class="select" id="m-status">
          <option value="">All statuses</option>
          ${['RUNNING', 'IDLE', 'FAULT', 'MAINTENANCE', 'OFFLINE', 'OFF'].map((s) => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="m-refresh">Refresh</button>
        ${can('machines.manage') ? '<button class="btn btn-primary btn-sm" id="m-add">+ Add machine</button>' : ''}
      </div>`;
    el.innerHTML = `
      <div class="flex-between"><h3 style="margin:0">Machines (${list.data.length})</h3>
        <div><a class="link" href="#/alerts">Alerts</a> · <a class="link" href="#/tasks">Tasks</a> · <a class="link" href="#/ai">Ask AI</a></div></div>
      ${f}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Machine</th><th>Status</th><th>Health</th><th>Active alerts</th><th>Last reading</th><th></th></tr></thead>
        <tbody>${list.data.length ? list.data.map((m) => `
          <tr class="row-link" data-id="${esc(m.id)}">
            <td><span class="machine-cell"><img class="machine-thumb" src="/${esc(m.image || 'images/logo.png')}" alt="" loading="lazy"><span class="mc-text"><b>${esc(m.name)}</b><br><span class="muted mono">${esc(m.id)}</span></span></span></td>
            <td>${statusTag(m.status)}</td>
            <td>${healthBar(m.health_score)}</td>
            <td>${m.active_alerts ?? 0}</td>
            <td class="muted">${fmtFresh(m.latest?.data_freshness_seconds)}</td>
            <td>${can('machines.manage') ? `<div class="actions-cell">
              <button class="btn btn-sm" data-edit="${esc(m.id)}" data-m="${esc(JSON.stringify(m))}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-del="${esc(m.id)}" data-name="${esc(m.name)}">Delete</button>
            </div>` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="6" class="list-empty">No machines match the filters</td></tr>'}</tbody>
      </table></div></div>`;
    $('#m-search').addEventListener('input', (e) => { filters.search = e.target.value.trim(); clearTimeout(el._t); el._t = setTimeout(load, 350); });
    $('#m-status').addEventListener('change', (e) => { filters.status = e.target.value; load(); });
    $('#m-refresh').addEventListener('click', load);
    if (can('machines.manage')) $('#m-add').addEventListener('click', () => machineModal(null, load));
    el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/machines/${tr.dataset.id}`; }));
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      let m;
      try { m = JSON.parse(b.dataset.m); } catch { m = null; }
      machineModal(m, load);
    }));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete machine "${b.dataset.name}"? Its telemetry history stays for audit.`)) return;
      await api('DELETE', `/api/machines/${b.dataset.del}`);
      toast('Machine deleted'); load();
    }));
  };
  await load();
};

views.machineDetail = async (el, id) => {
  el.innerHTML = '<div class="spin"></div>';
  const [ov, alerts, maint, parts, docs, telT, telP, telL] = await Promise.all([
    api('GET', `/api/machines/${id}`),
    api('GET', `/api/machines/${id}/alerts?pageSize=50`).catch(() => null),
    api('GET', `/api/machines/${id}/maintenance`).catch(() => null),
    api('GET', `/api/machines/${id}/parts`).catch(() => null),
    api('GET', `/api/documents?machine_id=${encodeURIComponent(id)}&pageSize=50`).catch(() => null),
    api('GET', `/api/machines/${id}/telemetry?metric=temperature_c&agg=avg&bucketMinutes=30&hours=24`).catch(() => null),
    api('GET', `/api/machines/${id}/telemetry?metric=power_kw&agg=avg&bucketMinutes=30&hours=24`).catch(() => null),
    api('GET', `/api/machines/${id}/telemetry?metric=load_pct&agg=avg&bucketMinutes=30&hours=24`).catch(() => null),
  ]);
  const c = ov.current || {};
  const alertList = asList(alerts);
  const maintList = asList(maint);
  const partsList = asList(parts);
  const docsList = asList(docs);
  el.innerHTML = `
    <div class="flex-between">
      <div>
        <h3 style="margin:0"><img class="machine-thumb" src="/${esc(ov.machine.image || 'images/logo.png')}" alt="" style="width:52px;height:52px"> ${esc(ov.machine.name)} <span class="muted mono">${esc(ov.machine.id)}</span></h3>
        <div class="mt8">${statusTag(ov.machine.status)} &nbsp; ${healthBar(ov.health_score)} &nbsp;
          <span class="badge-sev sev-${ov.risk.risk_level}">RISK ${ov.risk.risk_level} (${fmt(ov.risk.risk_score, 2)})</span>
        </div>
        <div class="muted mt8">${esc(ov.machine.type || '')} · ${esc(ov.machine.external_device_id || '')}</div>
      </div>
      <a class="link" href="#/machines">← all machines</a>
    </div>
    <div class="grid grid-4 mt16">
      <div class="kpi"><div class="kpi-label">Temperature</div><div class="kpi-value">${fmt(c.temperature_c?.value)}°C</div><div class="kpi-sub">${fmtAgo(c.temperature_c?.ts)} · ${esc(c.temperature_c?.quality || '')}</div></div>
      <div class="kpi"><div class="kpi-label">Power</div><div class="kpi-value">${fmt(c.power_kw?.value)} kW</div><div class="kpi-sub">${fmtAgo(c.power_kw?.ts)}</div></div>
      <div class="kpi"><div class="kpi-label">Load</div><div class="kpi-value">${fmt(c.load_pct?.value)}%</div><div class="kpi-sub">${fmtAgo(c.load_pct?.ts)}</div></div>
      <div class="kpi"><div class="kpi-label">Operating today</div><div class="kpi-value">${fmt(ov.operating_hours_today, 1)}h</div>
        <div class="kpi-sub">${fmt(ov.energy_today_kwh, 1)} kWh · $${fmt(ov.cost_today_usd, 2)}</div></div>
    </div>
    <div class="grid grid-2 mt16">
      <div class="card"><h3>Temperature — last 24h (°C)</h3><canvas id="ch-m-temp" style="width:100%;height:180px"></canvas></div>
      <div class="card"><h3>Power — last 24h (kW)</h3><canvas id="ch-m-power" style="width:100%;height:180px"></canvas></div>
      <div class="card"><h3>Load — last 24h (%)</h3><canvas id="ch-m-load" style="width:100%;height:180px"></canvas></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Active alerts (${alertList.length})</h3>
        ${alertList.length ? `<table><tbody>${alertList.map((a) => `
          <tr><td><span class="${sevClass(a.severity)}">${a.severity}</span></td>
          <td><b>${esc(a.type.replace(/_/g, ' '))}</b><br><span class="muted">${esc(a.message || '')}</span></td>
          <td class="muted">${fmtAgo(a.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No active alerts</div>'}</div>
      <div class="card"><h3>Last maintenance</h3>
        ${ov.last_maintenance ? `<table><tbody>
          <tr><td class="muted">Type</td><td><b>${esc(ov.last_maintenance.type)}</b> · ${esc(ov.last_maintenance.outcome)}</td></tr>
          <tr><td class="muted">Completed</td><td>${fmtDate(ov.last_maintenance.completed_at)}</td></tr>
          <tr><td class="muted">Notes</td><td>${esc(ov.last_maintenance.notes || '—')}</td></tr></tbody></table>`
        : '<div class="empty">No maintenance recorded</div>'}
        <div class="mt8"><a class="link" href="#/maintenance">Maintenance history →</a></div></div>
    </div>
    <div class="card"><h3>Risk assessment</h3>
      <div class="muted">${esc(ov.risk.caveat || '')}</div>
      ${ov.risk.top_signals?.length ? `<div class="mt8">${ov.risk.top_signals.map((s) => `<span class="evidence-chip">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="muted mt8">confidence ${fmt(ov.risk.confidence, 2)} · model ${esc(ov.risk.model_version)}</div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Compatible spare parts (${partsList.length})</h3>
        ${partsList.length ? `<table><thead><tr><th>Part</th><th>SKU</th><th>Available</th><th>Supplier</th></tr></thead><tbody>${partsList.map((p) => `
          <tr><td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.sku)}</td><td>${p.available_qty}</td><td>${esc(p.supplier || '—')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No compatible parts listed</div>'}</div>
      <div class="card"><h3>Documents (${docsList.length})</h3>
        ${docsList.length ? `<table><thead><tr><th>Title</th><th>Type</th><th>Uploaded</th></tr></thead><tbody>${docsList.map((doc) => `
          <tr><td><b>${esc(doc.title)}</b></td><td class="mono">${esc(doc.type)}</td><td class="muted">${fmtAgo(doc.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No documents attached</div>'}</div>
    </div>
    <div class="card"><h3>Maintenance history (${maintList.length})</h3>
      ${maintList.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Diagnosis</th><th>Action</th><th>Outcome</th><th>Completed</th></tr></thead>
        <tbody>${maintList.map((e) => `
          <tr><td>${esc(e.type)}</td><td>${esc(e.diagnosis || '—')}</td><td>${esc(e.action || '—')}</td>
          <td>${statusTag(e.outcome)}</td><td class="muted">${fmtDate(e.completed_at || e.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No maintenance history</div>'}</div>`;
  if (asList(telT).length) lineChart($('#ch-m-temp'), telT.data.map((p) => p.bucket_ts.slice(11, 16)), telT.data.map((p) => p.value), '#58a6ff');
  if (asList(telP).length) lineChart($('#ch-m-power'), telP.data.map((p) => p.bucket_ts.slice(11, 16)), telP.data.map((p) => p.value), '#f0a500');
  if (asList(telL).length) lineChart($('#ch-m-load'), telL.data.map((p) => p.bucket_ts.slice(11, 16)), telL.data.map((p) => p.value), '#26a69a');
};

/* ============================================================ telemetry */
views.telemetry = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [machines, latest] = await Promise.all([
    api('GET', '/api/machines'),
    api('GET', '/api/telemetry/latest').catch(() => ({})),
  ]);
  const load = () => views.telemetry(el);
  const metrics = [
    ['temperature_c', 'Temperature (°C)'], ['power_kw', 'Power (kW)'], ['load_pct', 'Load (%)'],
    ['vibration_mm_s', 'Vibration (mm/s)'], ['rpm', 'Speed (rpm)'], ['pressure_bar', 'Pressure (bar)'],
  ];
  el.innerHTML = `
    <div class="grid grid-2">
      <div class="card"><h3>Ingest reading (IoT gateway)</h3>
        <div class="field"><label>Machine</label>
          <select id="t-mach" class="select">${machines.data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Metric</label>
          <select id="t-metric" class="select">${metrics.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Value *</label><input id="t-value" type="number" step="any" class="input" /></div>
        <div class="grid grid-2">
          <div class="field"><label>Quality</label>
            <select id="t-quality" class="select">${['good', 'suspect', 'bad', 'missing'].map((q) => `<option>${q}</option>`).join('')}</select></div>
          <div class="field"><label>Source</label>
            <select id="t-source" class="select">${['device', 'simulator', 'imported'].map((s) => `<option>${s}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Sequence (optional, for dedupe)</label><input id="t-seq" type="number" class="input" /></div>
        <button class="btn btn-primary" id="t-send">Send reading</button>
        <div class="muted mt8 small-note">The alert engine re-checks thresholds immediately. Duplicate machine+metric+sequence readings are ignored.</div>
      </div>
      <div class="card"><h3>Latest readings</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Machine</th><th>Temp (°C)</th><th>Power (kW)</th><th>Load (%)</th><th>Freshness</th></tr></thead>
          <tbody>${machines.data.map((m) => {
            const l = latest[m.id] || {};
            const fresh = l.temperature_c || l.power_kw ? Math.max(0, Math.round((Date.now() - new Date((l.temperature_c || l.power_kw).ts).getTime()) / 1000)) : null;
            return `<tr>
              <td><b>${esc(m.name)}</b><br><span class="muted mono">${esc(m.id)}</span></td>
              <td>${fmt(l.temperature_c?.value)}</td><td>${fmt(l.power_kw?.value)}</td><td>${fmt(l.load_pct?.value)}</td>
              <td class="muted">${fmtFresh(fresh)}</td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
    </div>`;
  $('#t-send').addEventListener('click', async () => {
    const value = parseFloat($('#t-value').value);
    if (!Number.isFinite(value)) { alert('Value must be a number'); return; }
    const body = {
      machine_id: $('#t-mach').value,
      metric: $('#t-metric').value,
      value,
      quality: $('#t-quality').value,
      source: $('#t-source').value,
    };
    const seq = parseInt($('#t-seq').value, 10);
    if (Number.isInteger(seq)) body.sequence = seq;
    const r = await api('POST', '/api/telemetry/ingest', { readings: [body] });
    toast(`Ingested: ${r.inserted} inserted, ${r.rejected?.length || 0} rejected`);
    $('#t-value').value = '';
    load();
  });
};

/* ============================================================ alerts */
views.alerts = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  let severity = '', status = 'ACTIVE';
  const load = async () => {
    el.innerHTML = '<div class="spin"></div>';
    const q = new URLSearchParams({ pageSize: '100' });
    if (severity) q.set('severity', severity);
    if (status) q.set('status', status);
    const d = await api('GET', `/api/alerts?${q}`);
    el.innerHTML = `
      <div class="flex-between"><h3 style="margin:0">Alerts (${d.data.length})</h3>
        <button class="btn btn-sm" id="alerts-refresh">Refresh</button></div>
      <div class="filter-row mt16">
        <select class="select" id="a-status">
          <option value="ACTIVE">Active</option><option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option>
          <option value="">All</option>
        </select>
        <select class="select" id="a-sev">
          <option value="">All severities</option>
          ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <a class="link" href="#/reports" style="font-size:13px">Export alerts →</a>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Severity</th><th>Type</th><th>Machine</th><th>Message</th><th>Triggered</th><th></th></tr></thead>
        <tbody>${d.data.length ? d.data.map((a) => `
          <tr>
            <td><span class="${sevClass(a.severity)}">${a.severity}</span></td>
            <td><b>${esc(a.type.replace(/_/g, ' '))}</b></td>
            <td>${esc(a.machine_name || a.machine_id)}</td>
            <td class="muted">${esc(a.message || '')}</td>
            <td class="muted">${fmtAgo(a.created_at)}</td>
            <td><div class="actions-cell">
              ${a.status === 'ACTIVE' || a.status === 'DETECTED' || a.status === 'ACKNOWLEDGED' ? `<button class="btn btn-sm" data-ack="${a.id}">Ack</button>` : ''}
              ${(a.status === 'ACTIVE' || a.status === 'DETECTED' || a.status === 'ACKNOWLEDGED') && can('alerts.resolve') ? `<button class="btn btn-sm btn-primary" data-resolve="${a.id}">Resolve</button>` : ''}
              ${(a.status === 'ACTIVE' || a.status === 'DETECTED' || a.status === 'ACKNOWLEDGED') && can('alerts.dismiss') ? `<button class="btn btn-sm btn-ghost" data-dismiss="${a.id}">Dismiss</button>` : ''}
            </div></td>
          </tr>`).join('') : '<tr><td colspan="6" class="list-empty">No alerts in this view 🎉</td></tr>'}</tbody>
      </table></div></div>`;
    $('#a-status').value = status;
    $('#a-sev').value = severity;
    $('#a-status').addEventListener('change', (e) => { status = e.target.value; load(); });
    $('#a-sev').addEventListener('change', (e) => { severity = e.target.value; load(); });
    $('#alerts-refresh').addEventListener('click', load);
    el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', `/api/alerts/${b.dataset.ack}/acknowledge`); toast('Alert acknowledged'); load();
    }));
    el.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', `/api/alerts/${b.dataset.resolve}/resolve`); toast('Alert resolved'); load();
    }));
    el.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', `/api/alerts/${b.dataset.dismiss}/dismiss`); toast('Alert dismissed'); load();
    }));
  };
  await load();
};

/* ============================================================ tasks */
views.tasks = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [tasks, machines, team] = await Promise.all([
    api('GET', '/api/tasks?pageSize=100').catch(() => ({ data: [] })),
    api('GET', '/api/machines').catch(() => ({ data: [] })),
    api('GET', '/api/team').catch(() => null),
  ]);
  const users = team?.data || [];
  const load = () => views.tasks(el);
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">Scheduled tasks (${tasks.data.length})</h3>
      ${can('tasks.create') ? '<button class="btn btn-primary btn-sm" id="task-new">+ New task</button>' : ''}</div>
    <div class="card mt16"><div class="table-wrap"><table>
      <thead><tr><th>Task</th><th>Machine</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th><th>Recurrence</th><th></th></tr></thead>
      <tbody>${tasks.data.length ? tasks.data.map((t) => `<tr>
        <td><b>${esc(t.title)}</b>${t.description ? `<br><span class="muted" style="font-size:12px">${esc(t.description)}</span>` : ''}</td>
        <td>${t.machine_name ? `<a class="link" href="#/machines/${esc(t.machine_id)}">${esc(t.machine_name)}</a>` : '—'}</td>
        <td><span class="${sevClass(t.priority)}">${t.priority}</span></td>
        <td>${statusTag(t.status)}</td>
        <td class="muted">${esc(t.assigned_name || 'Unassigned')}</td>
        <td class="muted">${fmtDate(t.due_at)}</td>
        <td class="muted">${esc((t.recurrence || 'none').replace(/_/g, ' '))}</td>
        <td><div class="actions-cell">
          ${['OPEN', 'ASSIGNED'].includes(t.status) && can('tasks.assign') ? `<button class="btn btn-sm" data-assign="${t.id}">Assign</button>` : ''}
          ${['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status) && can('tasks.complete') ? `<button class="btn btn-sm btn-primary" data-complete="${t.id}">Complete</button>` : ''}
          ${['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status) && can('tasks.complete') ? `<button class="btn btn-sm btn-ghost" data-cancel="${t.id}">Cancel</button>` : ''}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="8" class="list-empty">No scheduled tasks</td></tr>'}</tbody>
    </table></div></div>`;
  if (can('tasks.create')) {
    $('#task-new').addEventListener('click', () => {
      openModal('New scheduled task', `
        <div class="field"><label>Machine</label>
          <select id="t-machine" class="select"><option value="">Plant-wide</option>
          ${machines.data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Task type</label>
          <select id="t-type" class="select">${['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'PREDICTIVE', 'CALIBRATION', 'REPAIR', 'REPLACEMENT', 'GENERAL'].map((t) => `<option>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Title *</label><input id="t-title" class="input" placeholder="e.g. Lubricate drive bearings" /></div>
        <div class="field"><label>Description</label><textarea id="t-desc" rows="3" class="modal-select"></textarea></div>
        <div class="field"><label>Due date &amp; time *</label><input id="t-due" type="datetime-local" class="input" value="${toLocalInput(new Date(Date.now() + 24 * 3600000))}" /></div>
        <div class="field"><label>Priority</label>
          <select id="t-priority" class="select">${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => `<option ${p === 'MEDIUM' ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="field"><label>Recurrence</label>
          <select id="t-rec" class="select">${['none', 'daily', 'weekly', 'monthly', 'custom_days'].map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div class="field" id="t-rec-days-wrap" style="display:none"><label>Interval (days)</label><input id="t-rec-days" type="number" class="input" min="1" value="7" /></div>
        ${can('tasks.assign') && users.length ? `<div class="field"><label>Assign to</label>
          <select id="t-assignee" class="select"><option value="">Unassigned</option>
          ${users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)} (${esc(u.role)})</option>`).join('')}</select></div>` : ''}
      `, [
        { label: 'Cancel', cls: 'btn-ghost' },
        { label: 'Create task', cls: 'btn-primary', action: async () => {
          const title = $('#t-title').value.trim();
          if (!title) throw new Error('Title is required');
          const body = {
            machine_id: $('#t-machine').value || null,
            task_type: $('#t-type').value,
            title,
            description: $('#t-desc').value.trim() || null,
            due_at: new Date($('#t-due').value).toISOString(),
            priority: $('#t-priority').value,
            recurrence: $('#t-rec').value,
            assigned_to: $('#t-assignee')?.value || null,
          };
          if (body.recurrence === 'custom_days') body.recurrence_interval = parseInt($('#t-rec-days').value, 10);
          await api('POST', '/api/tasks', body);
          closeModal(); toast('Task created'); load();
        } },
      ]);
      $('#t-rec').addEventListener('change', (e) => { $('#t-rec-days-wrap').style.display = e.target.value === 'custom_days' ? '' : 'none'; });
    });
  }
  el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => {
    openModal('Assign task', `
      <div class="field"><label>Assignee</label>
        <select id="ta-user" class="select">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)} (${esc(u.role)})</option>`).join('')}</select></div>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Assign', cls: 'btn-primary', action: async () => {
        await api('POST', `/api/tasks/${b.dataset.assign}/assign`, { assigned_to: $('#ta-user').value });
        closeModal(); toast('Task assigned'); load();
      } }]);
  }));
  el.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Mark this task as completed?')) return;
    await api('POST', `/api/tasks/${b.dataset.complete}/complete`); toast('Task completed'); load();
  }));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this task?')) return;
    await api('POST', `/api/tasks/${b.dataset.cancel}/cancel`); toast('Task cancelled'); load();
  }));
};

/* ============================================================ maintenance */
views.maintenance = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [requests, machines, team] = await Promise.all([
    api('GET', '/api/maintenance-requests?pageSize=100'),
    api('GET', '/api/machines'),
    api('GET', '/api/team').catch(() => null),
  ]);
  const events = asList(await api('GET', '/api/maintenance-events').catch(() => []));
  const users = team?.data || [];
  const load = () => views.maintenance(el);
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">Maintenance requests (${requests.data.length})</h3>
      ${can('maintenance.create') ? '<button class="btn btn-primary btn-sm" id="mreq-new">+ New request</button>' : ''}</div>
    <div class="card mt16"><div class="table-wrap"><table>
      <thead><tr><th>Machine</th><th>Issue</th><th>Priority</th><th>Status</th><th>Technician</th><th>Created</th><th></th></tr></thead>
      <tbody>${requests.data.length ? requests.data.map((r) => `<tr>
        <td>${esc(r.machine_name || r.machine_id || '—')}</td>
        <td><b>${esc(r.issue)}</b></td>
        <td><span class="${sevClass(r.priority === 'HIGH' ? 'HIGH' : r.priority === 'MEDIUM' ? 'MEDIUM' : r.priority === 'CRITICAL' ? 'CRITICAL' : 'LOW')}">${r.priority}</span></td>
        <td>${statusTag(r.status)}</td>
        <td class="muted">${esc(r.technician_name || '—')}</td>
        <td class="muted">${fmtAgo(r.created_at)}</td>
        <td><div class="actions-cell">
          ${r.status === 'OPEN' && can('maintenance.triage') ? `<button class="btn btn-sm" data-triage="${r.id}">Triage</button>` : ''}
          ${['OPEN', 'TRIAGED', 'ASSIGNED'].includes(r.status) && can('maintenance.assign') ? `<button class="btn btn-sm" data-assign="${r.id}">Assign</button>` : ''}
          ${['TRIAGED', 'ASSIGNED'].includes(r.status) && can('maintenance.complete') ? `<button class="btn btn-sm" data-start="${r.id}">Start</button>` : ''}
          ${r.status === 'IN_PROGRESS' && can('maintenance.complete') ? `<button class="btn btn-sm" data-verify="${r.id}">Verify</button>` : ''}
          ${r.status === 'VERIFICATION' && can('maintenance.complete') ? `<button class="btn btn-sm btn-primary" data-complete="${r.id}">Complete</button>` : ''}
          ${['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS'].includes(r.status) && can('maintenance.complete') ? `<button class="btn btn-sm btn-ghost" data-cancel="${r.id}">Cancel</button>` : ''}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="list-empty">No maintenance requests</td></tr>'}</tbody>
    </table></div></div>
    <div class="card"><h3>Maintenance history (${events.length})</h3>
      ${events.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Machine</th><th>Type</th><th>Diagnosis</th><th>Action</th><th>Outcome</th><th>Technician</th><th>Completed</th></tr></thead>
        <tbody>${events.map((e) => `<tr>
          <td>${esc(e.machine_name || e.machine_id || '—')}</td><td>${esc(e.type)}</td>
          <td>${esc(e.diagnosis || '—')}</td><td>${esc(e.action || '—')}</td>
          <td>${statusTag(e.outcome)}</td><td class="muted">${esc(e.technician_name || '—')}</td>
          <td class="muted">${fmtDate(e.completed_at || e.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No maintenance history</div>'}
      <div class="mt8"><a class="link" href="#/reports">Export maintenance report →</a></div>
    </div>`;
  if (can('maintenance.create')) {
    $('#mreq-new').addEventListener('click', () => {
      openModal('New maintenance request', `
        <div class="field"><label>Machine</label><select id="mreq-machine" class="select">
          <option value="">Plant-wide</option>
          ${machines.data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Issue *</label><textarea id="mreq-issue" rows="3" class="modal-select" placeholder="Describe the problem"></textarea></div>
        <div class="field"><label>Priority</label>
          <select id="mreq-priority" class="select">${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => `<option ${p === 'MEDIUM' ? 'selected' : ''}>${p}</option>`).join('')}</select></div>`,
        [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Create request', cls: 'btn-primary', action: async () => {
          const issue = $('#mreq-issue').value.trim();
          if (!issue) throw new Error('Issue is required');
          await api('POST', '/api/maintenance-requests', { machine_id: $('#mreq-machine').value || null, issue, priority: $('#mreq-priority').value });
          closeModal(); toast('Maintenance request created'); load();
        } }]);
    });
  }
  el.querySelectorAll('[data-triage]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/maintenance-requests/${b.dataset.triage}/triage`, { ai_triage: null });
    toast('Request triaged'); load();
  }));
  el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => {
    openModal('Assign technician', `
      <div class="field"><label>Technician</label>
        <select id="mt-user" class="select">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)} (${esc(u.role)})</option>`).join('')}</select></div>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Assign', cls: 'btn-primary', action: async () => {
        await api('POST', `/api/maintenance-requests/${b.dataset.assign}/assign`, { technician_id: $('#mt-user').value });
        closeModal(); toast('Technician assigned'); load();
      } }]);
  }));
  el.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/maintenance-requests/${b.dataset.start}/start`); toast('Work started'); load();
  }));
  el.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/maintenance-requests/${b.dataset.verify}/verify`); toast('Sent for verification'); load();
  }));
  el.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', () => {
    openModal('Complete maintenance', `
      <div class="field"><label>Event type</label>
        <select id="mc-type" class="select">${['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'PREDICTIVE', 'CALIBRATION', 'REPAIR', 'REPLACEMENT'].map((t) => `<option>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Diagnosis</label><input id="mc-diagnosis" class="input" /></div>
      <div class="field"><label>Action taken</label><textarea id="mc-action" rows="3" class="modal-select"></textarea></div>
      <div class="field"><label>Outcome</label>
        <select id="mc-outcome" class="select">${['SUCCESS', 'PARTIAL', 'FAILED', 'DEFERRED'].map((o) => `<option>${o}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><input id="mc-notes" class="input" /></div>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Complete & record', cls: 'btn-primary', action: async () => {
        await api('POST', `/api/maintenance-requests/${b.dataset.complete}/complete`, {
          type: $('#mc-type').value, diagnosis: $('#mc-diagnosis').value.trim() || null,
          action: $('#mc-action').value.trim() || null, outcome: $('#mc-outcome').value,
          notes: $('#mc-notes').value.trim() || null,
        });
        closeModal(); toast('Maintenance completed'); load();
      } }]);
  }));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this maintenance request?')) return;
    await api('POST', `/api/maintenance-requests/${b.dataset.cancel}/cancel`); toast('Request cancelled'); load();
  }));
};

/* ============================================================ parts */
views.parts = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [parts, requests] = await Promise.all([
    api('GET', '/api/parts'),
    api('GET', '/api/spare-requests?pageSize=50'),
  ]);
  const load = () => views.parts(el);
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">Inventory (${parts.data.length})</h3>
      ${can('inventory.manage') ? '<button class="btn btn-primary btn-sm" id="part-new">+ New part</button>' : ''}</div>
    <div class="card mt16"><div class="table-wrap"><table>
      <thead><tr><th>Part</th><th>SKU</th><th>Avail.</th><th>Stock</th><th>Reserved</th><th>Min</th><th>Supplier</th><th></th></tr></thead>
      <tbody>${parts.data.map((p) => `<tr>
        <td><b>${esc(p.name)}</b>${p.available_qty <= p.reorder_level ? ' <span class="badge badge-demo">LOW</span>' : ''}</td>
        <td class="mono">${esc(p.sku)}</td><td><b>${p.available_qty}</b></td><td>${p.stock_qty}</td><td>${p.reserved_qty}</td>
        <td>${p.reorder_level}</td><td class="muted">${esc(p.supplier || '—')}</td>
        <td><div class="actions-cell">
          ${can('spare.request') ? `<button class="btn btn-sm" data-req="${p.id}" data-name="${esc(p.name)}">Request</button>` : ''}
          ${can('inventory.manage') ? `<button class="btn btn-sm" data-restock="${p.id}" data-name="${esc(p.name)}">Restock</button>` : ''}
        </div></td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="card"><h3>Spare requests (${requests.data.length})</h3>
      ${requests.data.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Part</th><th>Qty</th><th>Status</th><th>Requested</th><th></th></tr></thead>
        <tbody>${requests.data.map((r) => `<tr>
          <td>${esc(r.part_name || r.part_id)}</td><td>${r.quantity}</td><td>${statusTag(r.status)}</td>
          <td class="muted">${fmtAgo(r.created_at)}</td>
          <td><div class="actions-cell">
            ${r.status === 'PENDING' && can('spare.approve') ? `<button class="btn btn-sm" data-approve="${r.id}">Approve</button>
              <button class="btn btn-sm btn-ghost" data-reject="${r.id}">Reject</button>` : ''}
            ${r.status === 'APPROVED' && can('inventory.manage') ? `<button class="btn btn-sm" data-deliver="${r.id}">Deliver</button>` : ''}
            ${r.status === 'DELIVERED' && (r.requester_id === state.user.id || can('inventory.manage')) ? `<button class="btn btn-sm" data-use="${r.id}">Mark used</button>` : ''}
            ${r.status === 'PENDING' && can('spare.request') ? `<button class="btn btn-sm btn-ghost" data-spcancel="${r.id}">Cancel</button>` : ''}
          </div></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No spare requests</div>'}</div>`;
  if (can('inventory.manage')) {
    $('#part-new').addEventListener('click', () => {
      openModal('New spare part', `
        <div class="field"><label>Name *</label><input id="p-name" class="input" /></div>
        <div class="field"><label>SKU *</label><input id="p-sku" class="input" placeholder="e.g. SP-0001" /></div>
        <div class="field"><label>Description</label><textarea id="p-desc" rows="2" class="modal-select"></textarea></div>
        <div class="field"><label>Stock</label><input id="p-stock" type="number" min="0" value="0" class="input" /></div>
        <div class="field"><label>Reorder level</label><input id="p-reorder" type="number" min="0" value="5" class="input" /></div>
        <div class="field"><label>Supplier</label><input id="p-supplier" class="input" /></div>`,
        [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Create part', cls: 'btn-primary', action: async () => {
          const name = $('#p-name').value.trim(), sku = $('#p-sku').value.trim();
          if (!name || !sku) throw new Error('Name and SKU are required');
          await api('POST', '/api/parts', {
            name, sku, description: $('#p-desc').value.trim() || null,
            stock_qty: parseInt($('#p-stock').value, 10) || 0,
            reorder_level: parseInt($('#p-reorder').value, 10) || 0,
            supplier: $('#p-supplier').value.trim() || null,
          });
          closeModal(); toast('Part created'); load();
        } }]);
    });
  }
  el.querySelectorAll('[data-req]').forEach((b) => b.addEventListener('click', () => {
    openModal(`Request spare part — ${b.dataset.name}`, `
      <div class="field"><label>Quantity</label><input id="req-qty" type="number" min="1" value="1" class="input" /></div>
      <div class="field"><label>ETA (optional)</label><input id="req-eta" type="datetime-local" class="input" /></div>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Submit request', cls: 'btn-primary', action: async () => {
        const qty = parseInt($('#req-qty').value, 10);
        if (!qty || qty < 1) throw new Error('Quantity must be ≥ 1');
        const body = { part_id: b.dataset.req, quantity: qty };
        if ($('#req-eta').value) body.eta = new Date($('#req-eta').value).toISOString();
        await api('POST', '/api/spare-requests', body);
        closeModal(); toast('Spare request submitted'); load();
      } }]);
  }));
  el.querySelectorAll('[data-restock]').forEach((b) => b.addEventListener('click', () => {
    openModal(`Restock — ${b.dataset.name}`, `
      <div class="field"><label>Quantity</label><input id="rs-qty" type="number" min="1" value="10" class="input" /></div>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Restock', cls: 'btn-primary', action: async () => {
        const qty = parseInt($('#rs-qty').value, 10);
        if (!qty || qty < 1) throw new Error('Quantity must be ≥ 1');
        await api('POST', `/api/parts/${b.dataset.restock}/restock`, { quantity: qty });
        closeModal(); toast('Stock updated'); load();
      } }]);
  }));
  el.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/spare-requests/${b.dataset.approve}/approve`); toast('Request approved (stock reserved)'); load();
  }));
  el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/spare-requests/${b.dataset.reject}/reject`); toast('Request rejected'); load();
  }));
  el.querySelectorAll('[data-deliver]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/spare-requests/${b.dataset.deliver}/deliver`); toast('Delivered'); load();
  }));
  el.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/spare-requests/${b.dataset.use}/use`); toast('Marked as used'); load();
  }));
  el.querySelectorAll('[data-spcancel]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/spare-requests/${b.dataset.spcancel}/cancel`); toast('Request cancelled'); load();
  }));
};

/* ============================================================ documents */
views.documents = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  let search = '', type = '';
  const load = async () => {
    el.innerHTML = '<div class="spin"></div>';
    const q = new URLSearchParams({ pageSize: '100' });
    if (search) q.set('search', search);
    if (type) q.set('type', type);
    const d = await api('GET', `/api/documents?${q}`);
    el.innerHTML = `
      <div class="flex-between"><h3 style="margin:0">Machine documents (${d.data.length})</h3>
        ${can('documents.upload') ? '<button class="btn btn-primary btn-sm" id="doc-new">+ Upload document</button>' : ''}</div>
      <div class="filter-row mt16">
        <input class="input" id="doc-search" placeholder="Search title / content…" value="${esc(search)}" />
        <select class="select" id="doc-type">
          <option value="">All types</option>
          ${['MACHINE_MANUAL', 'MAINTENANCE_MANUAL', 'SOP', 'SAFETY', 'TROUBLESHOOTING', 'SPECIFICATION', 'WIRING_DIAGRAM', 'SERVICE', 'PARTS_MANUAL', 'OTHER'].map((t) => `<option ${type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <a class="link" href="#/ai" style="font-size:13px">Ask the AI Copilot about them →</a>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Title</th><th>Type</th><th>Machine</th><th>Uploaded by</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${d.data.length ? d.data.map((doc) => `<tr>
          <td><b>${esc(doc.title)}</b></td><td class="mono">${esc(doc.type)}</td>
          <td>${doc.machine_id ? `<a class="link" href="#/machines/${esc(doc.machine_id)}">${esc(doc.machine_name || doc.machine_id)}</a>` : '—'}</td>
          <td class="muted">${esc(doc.uploader_name || '—')}</td><td class="muted">${fmtAgo(doc.created_at)}</td>
          <td><div class="actions-cell">${can('documents.upload') ? `<button class="btn btn-sm btn-ghost" data-del="${doc.id}">Delete</button>` : ''}</div></td>
        </tr>`).join('') : '<tr><td colspan="6" class="list-empty">No documents match</td></tr>'}</tbody>
      </table></div></div>`;
    $('#doc-search').addEventListener('input', (e) => { search = e.target.value.trim(); clearTimeout(el._t); el._t = setTimeout(load, 350); });
    $('#doc-type').addEventListener('change', (e) => { type = e.target.value; load(); });
    if (can('documents.upload')) {
      $('#doc-new').addEventListener('click', async () => {
        const machines = await api('GET', '/api/machines');
        openModal('Upload document', `
          <div class="field"><label>Machine *</label>
            <select id="doc-machine" class="select">${machines.data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Type</label>
            <select id="doc-dtype" class="select">${['MACHINE_MANUAL', 'MAINTENANCE_MANUAL', 'SOP', 'SAFETY', 'TROUBLESHOOTING', 'SPECIFICATION', 'WIRING_DIAGRAM', 'SERVICE', 'PARTS_MANUAL', 'OTHER'].map((t) => `<option>${t}</option>`).join('')}</select></div>
          <div class="field"><label>Title *</label><input id="doc-title" class="input" /></div>
          <div class="field"><label>Filename (optional, for text extraction)</label><input id="doc-filename" class="input" placeholder="manual.txt" /></div>
          <div class="field"><label>Content * (paste or type the document text)</label><textarea id="doc-content" rows="7" class="modal-select"></textarea></div>`,
          [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Upload', cls: 'btn-primary', action: async () => {
            const title = $('#doc-title').value.trim();
            const content = $('#doc-content').value;
            if (!title) throw new Error('Title is required');
            if (!content.trim()) throw new Error('Content is required');
            await api('POST', '/api/documents', {
              machine_id: $('#doc-machine').value,
              type: $('#doc-dtype').value,
              title,
              filename: $('#doc-filename').value.trim() || null,
              content,
            });
            closeModal(); toast('Document uploaded'); load();
          } }]);
      });
    }
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this document?')) return;
      await api('DELETE', `/api/documents/${b.dataset.del}`); toast('Document deleted'); load();
    }));
  };
  await load();
};

/* ============================================================ AI copilot */
views.ai = async (el) => {
  const convs = await api('GET', '/api/ai/conversations').catch(() => []);
  state.convs = Array.isArray(convs) ? convs : [];
  state.convId = state.convId || null;
  el.innerHTML = `
    <div class="chat-layout">
      <div class="chat-convs">
        <h4>Conversations</h4>
        <button class="conv-item active" id="conv-new">＋ New conversation</button>
        ${state.convs.map((c) => `<button class="conv-item" data-conv="${esc(c.id)}">${esc(c.title || 'Untitled')}<span class="conv-del" data-delconv="${esc(c.id)}" title="Delete">✕</span></button>`).join('')}
      </div>
      <div class="card chat-wrap">
        <div class="chat-log" id="chat-log"></div>
        <div class="chat-chips" id="chat-chips">
          <button class="chip" data-q="What is the temperature of the first machine?">🌡 Temperature of first machine</button>
          <button class="chip" data-q="When will the first machine turn off?">⏰ When will it turn off?</button>
          <button class="chip" data-q="Does the first machine have any errors?">⚠️ Any errors?</button>
          <button class="chip" data-q="Will the first machine go wrong after some weeks?">🔮 Will it fail in weeks?</button>
          <button class="chip" data-q="Set up my plant: 2 extruders and 1 conveyor">✨ Generate a plant (AI)</button>
        </div>
        <div class="chat-input-row">
          <input id="chat-input" placeholder="Ask about machines, alerts, parts, documents… (e.g. “Is the Primary Extruder okay?”)" />
          <button class="btn btn-primary" id="chat-send">Send</button>
        </div>
      </div>
    </div>`;
  const log = $('#chat-log');
  const input = $('#chat-input');
  const render = () => {
    log.innerHTML = state.conv.map((m, idx) => m.role === 'user'
      ? `<div class="msg msg-user">${esc(m.text)}</div>`
      : `<div class="msg msg-ai">${renderMd(m.text)}
          <div class="msg-meta">
            <span class="mono">${esc(m.model || '')}</span>
            ${m.evidence ? m.evidence.map((e) => `<span class="evidence-chip">${esc(e.tool)}</span>`).join('') : ''}
            ${m.confidence ? `<span>confidence: ${esc(m.confidence)}</span>` : ''}
            ${m.pending ? `<span class="action-card" style="margin:0">
              <div class="action-kind">⚠ Action requires confirmation</div>
              <div>${esc(m.pending.label)}</div>
              <div class="flex mt8">
                <button class="btn btn-sm btn-primary" data-confirm="${esc(m.pending.token)}" data-idx="${idx}">Confirm &amp; execute</button>
                <button class="btn btn-sm btn-ghost" data-cancel>Cancel</button>
              </div></span>` : ''}
          </div></div>`).join('') ||
      (state.conv.length ? '' : '<div class="empty" style="padding:20px">Ask a question — the copilot uses live machine, alert, inventory and document data.</div>');
    log.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      const idx = parseInt(b.dataset.idx, 10);
      try {
        const r = await api('POST', '/api/ai/actions/confirm', { token: b.dataset.confirm });
        b.closest('.action-card').outerHTML = `<div class="muted mt8">✅ Executed: <b>${esc(r.kind)}</b>${r.result?.id ? ` (${esc(r.result.id.slice(0, 8))})` : ''}</div>`;
        if (Number.isFinite(idx) && state.conv[idx]) state.conv[idx].pending = null; // don't replay a stale confirm card
        toast('AI action executed');
      } catch (err) {
        b.closest('.action-card').outerHTML = `<div class="muted mt8" style="color:var(--danger)">❌ ${esc(err.message)}</div>`;
      }
    }));
    log.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.idx, 10);
      if (Number.isFinite(idx) && state.conv[idx]) state.conv[idx].pending = null;
      b.closest('.action-card').remove();
    }));
    log.scrollTop = log.scrollHeight;
  };
  render();
  const refreshConvs = async () => {
    const list = await api('GET', '/api/ai/conversations').catch(() => []);
    state.convs = Array.isArray(list) ? list : [];
    el.querySelectorAll('.conv-item[data-conv]').forEach((btn) => {
      btn.dataset.conv && btn.classList.toggle('active', btn.dataset.conv === state.convId);
    });
    $('#conv-new').classList.toggle('active', !state.convId);
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    state.conv.push({ role: 'user', text });
    render();
    const typing = state.conv.length;
    state.conv.push({ role: 'ai', text: '…' });
    render();
    try {
      const r = await api('POST', '/api/ai/chat', { message: text, conversation_id: state.convId || undefined });
      state.convId = r.conversation_id || state.convId;
      const pending = r.pendingActions?.[0];
      state.conv[typing] = {
        role: 'ai', text: r.reply, model: r.model, evidence: r.evidence, confidence: r.confidence,
        pending: pending ? { label: pending.label, token: pending.confirmToken } : null,
      };
      refreshConvs();
    } catch (err) {
      state.conv[typing] = { role: 'ai', text: `⚠ ${err.message}` };
    }
    render();
  };
  $('#chat-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#chat-chips').querySelectorAll('[data-q]').forEach((c) => c.addEventListener('click', () => {
    input.value = c.dataset.q;
    send();
  }));
  $('#conv-new').addEventListener('click', async () => {
    state.convId = null; state.conv = [];
    el.querySelectorAll('.conv-item').forEach((b) => b.classList.remove('active'));
    $('#conv-new').classList.add('active');
    render(); input.focus();
  });
  el.querySelectorAll('[data-conv]').forEach((btn) => btn.addEventListener('click', async () => {
    state.convId = btn.dataset.conv;
    el.querySelectorAll('.conv-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.conv = [];
    try {
      const msgs = await api('GET', `/api/ai/conversations/${state.convId}/messages`);
      for (const m of msgs) {
        if (m.role === 'user') { state.conv.push({ role: 'user', text: m.content }); continue; }
        let parsed = null;
        try { parsed = JSON.parse(m.content); } catch { /* raw */ }
        state.conv.push({
          role: 'ai',
          text: parsed?.reply || m.content,
          model: parsed?.model || '',
          evidence: parsed?.evidence || [],
          confidence: parsed?.confidence || '',
        });
      }
    } catch (err) { state.conv.push({ role: 'ai', text: `⚠ ${err.message}` }); }
    render();
  }));
  el.querySelectorAll('[data-delconv]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    await api('DELETE', `/api/ai/conversations/${btn.dataset.delconv}`);
    if (state.convId === btn.dataset.delconv) { state.convId = null; state.conv = []; }
    views.ai(el); toast('Conversation deleted');
  }));
};

/* ============================================================ floating chatbot */
function widgetRender() {
  const log = $('#chatbot-log');
  if (!log) return;
  log.innerHTML = (state.widgetConv.length ? state.widgetConv : [{ role: 'ai', text: 'Ask me anything about your plant — temperature, status, errors, shutdown times, or the outlook for the coming weeks. I answer only from your live data.' }])
    .map((m, wi) => m.role === 'user'
      ? `<div class="msg msg-user">${esc(m.text)}</div>`
      : `<div class="msg msg-ai">${renderMd(m.text)}<div class="msg-meta">${m.model ? `<span class="mono">${esc(m.model)}</span>` : ''}
        ${m.pending ? `<span class="action-card" style="margin:0">
          <div class="action-kind">⚠ Action requires confirmation</div>
          <div>${esc(m.pending.label)}</div>
          <div class="flex mt8">
            <button class="btn btn-sm btn-primary" data-wconfirm="${esc(m.pending.token)}" data-widx="${wi}">Confirm &amp; execute</button>
            <button class="btn btn-sm btn-ghost" data-wcancel>Cancel</button>
          </div></span>` : ''}</div></div>`).join('');
  log.querySelectorAll('[data-wconfirm]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('POST', '/api/ai/actions/confirm', { token: b.dataset.wconfirm });
      b.closest('.action-card').outerHTML = `<div class="muted mt8">✅ Executed: <b>${esc(r.kind)}</b> (${Array.isArray(r.result) ? `${r.result.length} created` : ''})</div>`;
      const wi = parseInt(b.dataset.widx, 10);
      if (Number.isFinite(wi) && state.widgetConv[wi]) state.widgetConv[wi].pending = null;
      toast('AI action executed');
    } catch (err) {
      b.closest('.action-card').outerHTML = `<div class="muted mt8" style="color:var(--danger)">❌ ${esc(err.message)}</div>`;
    }
  }));
  log.querySelectorAll('[data-wcancel]').forEach((b) => b.addEventListener('click', () => {
    const wi = parseInt(b.dataset.widx, 10);
    if (Number.isFinite(wi) && state.widgetConv[wi]) state.widgetConv[wi].pending = null;
    b.closest('.action-card').remove();
  }));
  log.scrollTop = log.scrollHeight;
}

async function widgetSend(text) {
  const input = $('#chatbot-input');
  const message = text || input.value.trim();
  if (!message) return;
  input.value = '';
  state.widgetConv.push({ role: 'user', text: message });
  widgetRender();
  state.widgetConv.push({ role: 'ai', text: '…' });
  widgetRender();
  try {
    const r = await api('POST', '/api/ai/chat', { message, conversation_id: state.widgetConvId || undefined });
    state.widgetConvId = r.conversation_id || state.widgetConvId;
    const pending = r.pendingActions?.[0];
    state.widgetConv[state.widgetConv.length - 1] = {
      role: 'ai', text: r.reply, model: r.model,
      pending: pending ? { label: pending.label, token: pending.confirmToken } : null,
    };
  } catch (err) {
    state.widgetConv[state.widgetConv.length - 1] = { role: 'ai', text: `⚠ ${err.message}` };
  }
  widgetRender();
}

function initChatbot() {
  const toggle = $('#chatbot-toggle');
  const panel = $('#chatbot-panel');
  toggle.addEventListener('click', () => {
    state.widgetOpen = !state.widgetOpen;
    panel.classList.toggle('hidden', !state.widgetOpen);
    toggle.classList.toggle('chatbot-toggle-open', state.widgetOpen);
    if (state.widgetOpen) { widgetRender(); setTimeout(() => $('#chatbot-input').focus(), 60); }
  });
  $('#chatbot-close').addEventListener('click', () => {
    state.widgetOpen = false;
    panel.classList.add('hidden');
    toggle.classList.remove('chatbot-toggle-open');
  });
  $('#chatbot-send').addEventListener('click', () => widgetSend());
  $('#chatbot-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') widgetSend(); });
  $('#chatbot-chips').querySelectorAll('[data-q]').forEach((c) => c.addEventListener('click', () => widgetSend(c.dataset.q)));
}

/* ============================================================ AI insights */
views.insights = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const d = await api('GET', '/api/ai/insights?pageSize=100').catch(() => ({ data: [] }));
  const load = () => views.insights(el);
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">AI insights (${d.data.length})</h3>
      <a class="link" href="#/reports" style="font-size:13px">Export insights report →</a></div>
    <div class="card mt16">${d.data.length ? d.data.map((i) => `
      <div class="insight">
        <div><span class="${sevClass(i.severity)}">${i.severity}</span>
          <span class="evidence-chip">${esc(i.category)}</span>
          <span class="evidence-chip">${esc(i.machine_name || i.machine_id || 'Plant-wide')}</span>
          <span class="muted" style="font-size:12px">${fmtAgo(i.created_at)} · conf ${fmt(i.confidence, 2)}</span></div>
        <div class="mt8">${esc(i.description)}</div>
        ${i.evidence_refs?.length ? `<div class="mt8 muted" style="font-size:12px">evidence: ${i.evidence_refs.map((r) => esc(r)).join(', ')}</div>` : ''}
        ${i.feedback ? `<div class="mt8"><span class="evidence-chip">feedback: ${esc(i.feedback)}</span></div>`
        : `<div class="flex mt8"><button class="btn btn-sm" data-fb="${esc(i.id)}" data-v="useful">👍 Useful</button>
            <button class="btn btn-sm" data-fb="${esc(i.id)}" data-v="not_useful">👎 Not useful</button>
            <button class="btn btn-sm btn-ghost" data-fb="${esc(i.id)}" data-v="correct">Correct</button>
            <button class="btn btn-sm btn-ghost" data-fb="${esc(i.id)}" data-v="incorrect">Incorrect</button></div>`}
      </div>`).join('') : '<div class="empty">No AI insights yet — insights are generated when machines have active alerts.</div>'}</div>`;
  el.querySelectorAll('[data-fb]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/ai/insights/${b.dataset.fb}/feedback`, { feedback: b.dataset.v });
    toast('Feedback recorded'); load();
  }));
};

/* ============================================================ reports */
views.reports = async (el) => {
  const kinds = [
    ['machines', 'Machines overview'], ['energy', 'Energy & cost'], ['alerts', 'Alerts'],
    ['maintenance', 'Maintenance events'], ['inventory', 'Inventory'], ['requests', 'Requests'], ['insights', 'AI insights'],
  ];
  el.innerHTML = `
    <div class="card"><h3>Export reports</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Report</th><th>CSV</th><th>XLSX</th><th>PDF</th></tr></thead>
        <tbody>${kinds.map(([k, label]) => `
          <tr><td><b>${label}</b></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="csv">Download</button></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="xlsx">Download</button></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="pdf">Download</button></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="muted mt8" style="font-size:12px">Every export is audited (REPORT.EXPORT).</div>
    </div>`;
  el.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await downloadReport(b.dataset.kind, b.dataset.fmt); } catch (err) { alert(err.message); }
    b.disabled = false;
  }));
};

/* ============================================================ notifications */
views.notifications = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const load = async () => {
    el.innerHTML = '<div class="spin"></div>';
    const d = await api('GET', '/api/notifications?pageSize=100');
    el.innerHTML = `
      <div class="flex-between"><h3 style="margin:0">Notifications</h3>
        <div class="flex">
          <button class="btn btn-sm" id="notif-readall">Mark all read</button>
          <button class="btn btn-sm" id="notif-refresh">Refresh</button>
        </div></div>
      <div class="card mt16">${d.data.length ? d.data.map((n) => `
        <div class="notif ${n.read_at ? '' : 'unread'}" data-nid="${esc(n.id)}">
          <div class="flex-between">
            <div><b>${esc(n.title)}</b> <span class="evidence-chip">${esc(n.type)}</span></div>
            <span class="muted" style="font-size:12px">${fmtAgo(n.created_at)}</span>
          </div>
          ${n.body ? `<div class="muted mt8" style="font-size:13px">${esc(n.body)}</div>` : ''}
          ${!n.read_at ? '<div class="mt8"><button class="btn btn-sm" data-markread="' + esc(n.id) + '">Mark read</button></div>' : ''}
        </div>`).join('') : '<div class="empty">No notifications</div>'}</div>`;
    $('#notif-refresh').addEventListener('click', load);
    $('#notif-readall').addEventListener('click', async () => {
      await api('POST', '/api/notifications/read-all'); toast('All notifications marked read'); load();
    });
    el.querySelectorAll('[data-markread]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', `/api/notifications/${b.dataset.markread}/read`); load();
    }));
  };
  await load();
};

/* ============================================================ admin */
views.admin = async (el) => {
  if (!can('users.view')) {
    el.innerHTML = `<div class="empty">⚠ You don't have permission to view this page.<br><a class="link" href="#/dashboard">← back to dashboard</a></div>`;
    return;
  }
  el.innerHTML = '<div class="spin"></div>';
  let tab = 'overview';
  const load = async () => {
    el.innerHTML = '<div class="spin"></div>';
    const results = await Promise.allSettled([
      api('GET', '/api/admin/health'), api('GET', '/api/admin/users'),
      api('GET', '/api/admin/ai/usage').catch(() => null),
      api('GET', '/api/admin/audit?pageSize=100'),
    ]);
    const health = results[0].status === 'fulfilled' ? results[0].value : { counts: {} };
    const users = results[1].status === 'fulfilled' ? results[1].value : { data: [], meta: {} };
    const usage = results[2].status === 'fulfilled' ? results[2].value : null;
    const auditData = results[3].status === 'fulfilled' ? results[3].value : { data: [] };
    const c = health.counts || {};
    const s = usage?.summary || {};
    el.innerHTML = `
      <div class="tabs">
        <button class="tab ${tab === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>
        <button class="tab ${tab === 'users' ? 'active' : ''}" data-tab="users">Users</button>
        <button class="tab ${tab === 'audit' ? 'active' : ''}" data-tab="audit">Audit log</button>
      </div>
      ${tab === 'overview' ? `
        <div class="grid grid-4">
          <div class="kpi"><div class="kpi-label">Telemetry readings</div><div class="kpi-value">${(c.telemetry_readings ?? 0).toLocaleString()}</div></div>
          <div class="kpi"><div class="kpi-label">Active alerts</div><div class="kpi-value">${c.active_alerts ?? 0}</div><div class="kpi-sub">${(c.audit_events ?? 0).toLocaleString()} audit events</div></div>
          <div class="kpi"><div class="kpi-label">Users</div><div class="kpi-value">${c.users ?? 0}</div><div class="kpi-sub">${c.machines ?? 0} machines</div></div>
          <div class="kpi"><div class="kpi-label">AI usage (30d)</div><div class="kpi-value">${(s.requests ?? 0).toLocaleString()}</div>
            <div class="kpi-sub">${fmt(s.cost_usd, 2) !== '—' ? `$${fmt(s.cost_usd, 2)}` : ''} · avg ${fmt(s.avg_latency_ms, 0)} ms · ${s.failures ?? 0} failures</div></div>
        </div>
        <div class="card mt16"><h3>System</h3>
          <table><tbody>
            <tr><td class="muted">Mode</td><td>${esc(health.mode || '—')}</td></tr>
            <tr><td class="muted">AI engine</td><td>${esc(health.ai_engine || 'fallback-deterministic')}</td></tr>
            <tr><td class="muted">Uptime</td><td>${fmt((health.uptime_s || 0) / 3600, 1)} h</td></tr>
            <tr><td class="muted">Database</td><td>${fmt((health.db_bytes || 0) / 1024, 0)} KB</td></tr>
            <tr><td class="muted">AI insights</td><td>${c.ai_insights ?? 0}</td></tr>
          </tbody></table></div>
        <div class="card"><h3>Telemetry by source</h3>
          <div>${Object.entries(c.telemetry_by_source || {}).map(([s2, n]) => `<span class="evidence-chip">${esc(s2)}: ${n.toLocaleString()}</span>`).join('') || '<span class="muted">none</span>'}</div>
        </div>
        ${usage?.byModel?.length ? `<div class="card"><h3>AI usage by model</h3>
          <table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr></thead>
          <tbody>${usage.byModel.map((u) => `<tr><td>${esc(u.provider)}</td><td class="mono">${esc(u.model)}</td>
            <td>${u.requests}</td><td>${(u.input_tokens ?? 0).toLocaleString()}</td><td>${(u.output_tokens ?? 0).toLocaleString()}</td><td>$${fmt(u.cost_usd, 2)}</td></tr>`).join('')}</tbody></table></div>` : ''}` : ''}
      ${tab === 'users' ? `
        <div class="flex-between"><h3 style="margin:0">Users (${users.data.length})</h3>
          ${can('users.manage') ? '<button class="btn btn-primary btn-sm" id="user-new">+ Add user</button>' : ''}</div>
        <div class="card mt16"><div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>${users.data.map((u) => `<tr>
            <td><b>${esc(u.display_name)}</b></td><td>${esc(u.email)}</td>
            <td><span class="evidence-chip">${esc(u.role)}</span></td><td>${statusTag(u.status)}</td>
            <td class="muted">${fmtDate(u.last_login_at)}</td>
            <td><div class="actions-cell">${can('users.manage') && u.id !== state.user.id ? `
              <button class="btn btn-sm" data-edit-user="${esc(u.id)}" data-name="${esc(u.display_name)}" data-role="${esc(u.role)}" data-status="${esc(u.status)}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-reset="${esc(u.id)}" data-name="${esc(u.display_name)}">Reset pw</button>` : ''}</div></td>
          </tr>`).join('')}</tbody></table></div></div>` : ''}
      ${tab === 'audit' ? `
        <div class="card"><h3>Audit log (${auditData.data.length})</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>${auditData.data.map((a) => `<tr>
              <td class="muted">${fmtDate(a.ts)}</td><td>${esc(a.actor_name || a.actor_id || 'system')}</td>
              <td class="mono">${esc(a.action)}</td>
              <td>${esc(a.entity_type || '')}${a.entity_id ? `<br><span class="muted mono">${esc(a.entity_id)}</span>` : ''}</td>
              <td class="muted" style="max-width:320px">${esc(JSON.stringify(a.after || a.before || a.metadata || ''))}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="list-empty">No audit events</td></tr>'}</tbody></table></div></div>` : ''}`;
    el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; load(); }));
    if (can('users.manage') && tab === 'users') {
      $('#user-new').addEventListener('click', () => {
        openModal('Add user', `
          <div class="field"><label>Full name *</label><input id="u-name" class="input" /></div>
          <div class="field"><label>Email *</label><input id="u-email" type="email" class="input" /></div>
          <div class="field"><label>Role</label>
            <select id="u-role" class="select">${['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'].map((r) => `<option>${r}</option>`).join('')}</select></div>
          <div class="field"><label>Password * (min 8 chars)</label><input id="u-pass" type="password" class="input" /></div>`,
          [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Create user', cls: 'btn-primary', action: async () => {
            await api('POST', '/api/admin/users', {
              email: $('#u-email').value.trim(), display_name: $('#u-name').value.trim(),
              role: $('#u-role').value, password: $('#u-pass').value,
            });
            closeModal(); toast('User created'); load();
          } }]);
      });
    }
    el.querySelectorAll('[data-edit-user]').forEach((b) => b.addEventListener('click', () => {
      openModal(`Edit user — ${b.dataset.name}`, `
        <div class="field"><label>Role</label>
          <select id="ue-role" class="select">${['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'].map((r) => `<option ${r === b.dataset.role ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select id="ue-status" class="select">${['ACTIVE', 'INACTIVE'].map((s) => `<option ${s === b.dataset.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`,
        [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Save', cls: 'btn-primary', action: async () => {
          await api('PATCH', `/api/admin/users/${b.dataset.editUser}`, { role: $('#ue-role').value, status: $('#ue-status').value });
          closeModal(); toast('User updated'); load();
        } }]);
    }));
    el.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Reset password for ${b.dataset.name}?`)) return;
      const r = await api('POST', `/api/admin/users/${b.dataset.reset}/reset-password`);
      openModal('Temporary password', `
        <p>The user can sign in with this temporary password:</p>
        <p class="mono" style="font-size:18px;background:var(--bg);padding:10px;border-radius:8px">${esc(r.temporary_password)}</p>
        <p class="muted small-note">They will be required to change it on next login (production behavior).</p>`,
        [{ label: 'Done', cls: 'btn-primary', action: () => closeModal() }]);
    }));
  };
  await load();
};

/* ============================================================ profile */
views.profile = async (el) => {
  const me = await api('GET', '/api/me');
  const u = me.user;
  el.innerHTML = `
    <h3 style="margin:0">Profile &amp; settings</h3>
    <div class="grid grid-2 mt16">
      <div class="card">
        <div class="avatar">${esc((u.display_name || '?')[0].toUpperCase())}</div>
        <table><tbody>
          <tr><td class="muted">Name</td><td><b>${esc(u.display_name)}</b></td></tr>
          <tr><td class="muted">Email</td><td>${esc(u.email)}</td></tr>
          <tr><td class="muted">Role</td><td>${statusTag(u.role)}</td></tr>
          <tr><td class="muted">Status</td><td>${statusTag(u.status)}</td></tr>
          <tr><td class="muted">Last login</td><td>${fmtDate(u.last_login_at)}</td></tr>
          <tr><td class="muted">Member since</td><td>${fmtDate(u.created_at)}</td></tr>
        </tbody></table>
        <div class="mt16"><a class="link" href="#/reports">My permissions → Reports</a></div>
      </div>
      <div class="card"><h3>Account</h3>
        <div class="field"><label>Display name</label><input id="p-name" class="input" value="${esc(u.display_name)}" /></div>
        <button class="btn btn-primary" id="p-save">Save profile</button>
        <hr style="border-color:var(--border);margin:18px 0" />
        <h3>Change password</h3>
        <div class="field"><label>Current password</label><input id="p-cur" type="password" class="input" /></div>
        <div class="field"><label>New password (min 8 chars)</label><input id="p-new" type="password" class="input" /></div>
        <button class="btn btn-primary" id="p-pass">Update password</button>
      </div>
    </div>`;
  $('#p-save').addEventListener('click', async () => {
    const name = $('#p-name').value.trim();
    if (!name) { alert('Name is required'); return; }
    const r = await api('PATCH', '/api/me', { display_name: name });
    state.user = { ...state.user, ...r };
    $('#user-name').textContent = r.display_name;
    toast('Profile saved');
  });
  $('#p-pass').addEventListener('click', async () => {
    const cur = $('#p-cur').value, nw = $('#p-new').value;
    if (nw.length < 8) { alert('New password must be at least 8 characters'); return; }
    const r = await api('POST', '/api/auth/change-password', { current_password: cur, new_password: nw });
    state.token = r.token;
    localStorage.setItem('sp_token', r.token);
    $('#p-cur').value = ''; $('#p-new').value = '';
    toast('Password changed');
  });
};

/* ---------------- router ---------------- */
const PAGE_TITLES = {
  dashboard: 'Dashboard', machines: 'Machines', telemetry: 'Telemetry', alerts: 'Alerts', tasks: 'Tasks & Schedule',
  maintenance: 'Maintenance', parts: 'Spare Parts', documents: 'Documents', ai: 'AI Copilot',
  insights: 'AI Insights', reports: 'Reports', notifications: 'Notifications', admin: 'Admin', profile: 'Profile & Settings',
};

function showView(name, param) {
  const v = views[name];
  if (!v) { $('#content').innerHTML = '<div class="empty">Unknown view</div>'; return; }
  $('#page-title').textContent = PAGE_TITLES[name] || 'SmartPlant';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const el = $('#content');
  el.innerHTML = '';
  v(el, param).catch((err) => {
    el.innerHTML = `<div class="empty">⚠ ${esc(err.message)}</div>`;
    if (err.code === 'UNAUTHORIZED_ACTION') {
      el.innerHTML = `<div class="empty">⚠ You don't have permission to view this page.<br><a class="link" href="#/dashboard">← back to dashboard</a></div>`;
    }
  });
}

function route() {
  // location.hash is "#/machines/xyz"; strip the "#", leading "/", then split.
  const parts = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = PAGE_TITLES[parts[0]] ? parts[0] : 'dashboard';
  const param = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : undefined;
  showView(name, param);
}

function refreshNav() {
  document.querySelectorAll('.nav a[data-perm]').forEach((a) => {
    a.classList.toggle('hidden', !can(a.dataset.perm));
  });
}

/* ---------------- notifications badge ---------------- */
let notifPolling = false;
async function refreshNotifBadge() {
  if (!state.token || notifPolling) return;
  notifPolling = true;
  try {
    const d = await api('GET', '/api/notifications?unread=true&pageSize=1');
    const n = d.meta?.total || 0;
    const badge = $('#notif-badge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', n === 0);
    }
  } catch { /* ignore */ }
  notifPolling = false;
}

/* ---------------- login / shell ---------------- */
function showLogin(message = null) {
  $('#shell').classList.add('hidden');
  $('#chatbot').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  const errEl = $('#login-error');
  if (message) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
  const hint = $('#demo-hint');
  // Demo account shortcuts only exist when the demo seed was actually loaded.
  if (state.demo && state.seededDemo) {
    hint.classList.remove('hidden');
    $('#demo-badge').classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    $('#demo-badge').classList.add('hidden');
  }
  $('#register-tag').classList.toggle('hidden', !state.registrationOpen);
  const toggle = $('#auth-toggle');
  const note = $('#auth-note');
  if (state.registrationOpen) {
    toggle.textContent = 'Create an account';
    note.textContent = 'No demo data — start with your own plant:';
  } else {
    toggle.textContent = '';
    note.textContent = '';
  }
  const users = ['admin', 'manager', 'supervisor', 'technician', 'worker', 'viewer'];
  $('#demo-users').innerHTML = users.map((r) =>
    `<button type="button" class="demo-user-btn" data-u="${r}">${r}</button>`).join('');
  $('#demo-users').querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => {
    $('#login-email').value = `${b.dataset.u}@smartplant.local`;
    $('#login-password').value = `${b.dataset.u[0].toUpperCase()}${b.dataset.u.slice(1)}123!`;
  }));
}

function showAuthForm(mode) {
  const reg = mode === 'register';
  $('#login-form').classList.toggle('hidden', reg);
  $('#register-form').classList.toggle('hidden', !reg);
  const toggle = $('#auth-toggle');
  $('#register-note').textContent = state.registrationOpen
    ? 'The first account created on an empty system becomes the plant Administrator. Later accounts start as Worker and can be promoted in Admin → Users.'
    : '';
  toggle.textContent = reg ? '← Back to sign in' : 'Create an account';
}

async function enterShell() {
  $('#login-view').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#chatbot').classList.remove('hidden');
  $('#user-name').textContent = state.user.display_name;
  $('#user-role').textContent = state.user.role;
  $('#demo-badge-shell').classList.toggle('hidden', !state.demo || !state.seededDemo);
  $('#chatbot-engine').textContent = state.aiEngine.includes('openai') || state.aiEngine.includes('anthropic')
    ? `${state.aiEngine} · live data`
    : 'deterministic engine · live data';
  refreshNav();
  if (!location.hash) location.hash = '#/dashboard';
  route();
  refreshNotifBadge();
  if (state.notifTimer) clearInterval(state.notifTimer);
  state.notifTimer = setInterval(refreshNotifBadge, 30000);
}

async function readAuthStatus() {
  try {
    const s = await api('GET', '/api/auth/status');
    state.demo = !!s.demo_mode;
    state.seededDemo = !!s.seeded_demo_data;
    state.registrationOpen = !!s.registration_open;
    state.aiEngine = s.ai_engine || 'fallback-deterministic';
  } catch { /* defaults */ }
}

async function loadMe() {
  const me = await api('GET', '/api/me');
  state.user = me.user;
  state.permissions = me.permissions || [];
}

async function boot() {
  if (state.token) {
    try {
      await loadMe();
      await readAuthStatus();
      await enterShell();
      return;
    } catch {
      // api() already cleared the stale token and showed the login screen
      // with a "session expired" notice; don't hide it again.
      return;
    }
  }
  await readAuthStatus();
  showLogin();
}

/* ---------------- modal ---------------- */
function openModal(title, body, actions = []) {
  const m = $('#modal');
  $('#modal-body').innerHTML = `<h3>${esc(title)}</h3>${body}`;
  const wrap = $('#modal-actions');
  wrap.innerHTML = '';
  actions.forEach((a) => {
    const btn = document.createElement('button');
    btn.className = `btn ${a.cls || ''}`;
    btn.textContent = a.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await a.action(); } catch (err) { btn.disabled = false; alert(err.message); }
    });
    wrap.appendChild(btn);
  });
  m.classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

/* ---------------- events ---------------- */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  try {
    const r = await api('POST', '/api/auth/login', { email: $('#login-email').value.trim(), password: $('#login-password').value });
    state.token = r.token;
    localStorage.setItem('sp_token', r.token);
    state.user = r.user;
    await loadMe();
    await readAuthStatus();
    await enterShell();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#register-error');
  errEl.classList.add('hidden');
  try {
    const r = await api('POST', '/api/auth/register', {
      email: $('#reg-email').value.trim(),
      password: $('#reg-password').value,
      display_name: $('#reg-name').value.trim(),
    });
    state.token = r.token;
    localStorage.setItem('sp_token', r.token);
    state.user = r.user;
    await loadMe();
    await readAuthStatus();
    if (r.first_user) toast('Welcome! You are the plant administrator.', 'ok');
    await enterShell();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#auth-toggle').addEventListener('click', () => {
  const reg = $('#register-form').classList.contains('hidden');
  $('#login-error').classList.add('hidden');
  $('#register-error').classList.add('hidden');
  showAuthForm(reg ? 'register' : 'login');
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  state.token = null; state.user = null; state.permissions = []; state.conv = [];
  state.convId = null; state.convs = [];
  localStorage.removeItem('sp_token');
  if (state.notifTimer) clearInterval(state.notifTimer);
  showLogin();
});

$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
window.addEventListener('hashchange', route);

initChatbot();

(async () => {
  try { await boot(); } catch (err) { console.error(err); showLogin(); }
  setInterval(async () => {
    try {
      const r = await fetch('/health');
      const ok = r.ok && $('#conn-status');
      $('#conn-status').className = 'conn-status ' + (r.ok ? 'ok' : 'down');
    } catch { $('#conn-status').className = 'conn-status down'; }
  }, 15000);
})();
