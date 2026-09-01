'use strict';

/* SmartPlant frontend SPA — talks only to the backend API (source of truth). */

const $ = (sel) => document.querySelector(sel);
const state = { token: localStorage.getItem('sp_token') || null, user: null, demo: false, conv: [] };

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
    showLogin();
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
  return `${(s / 3600).toFixed(1)}h ago`;
}
function fmtFresh(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function sevClass(s) { return `badge-sev sev-${s}`; }
function statusTag(s) { return `<span class="status-tag st-${s}">${esc(s)}</span>`; }
function healthBar(h) {
  const cls = h >= 70 ? 'hb-good' : h >= 40 ? 'hb-mid' : 'hb-bad';
  return `<span class="health-bar"><span class="${cls}" style="width:${Math.max(0, Math.min(100, h))}%"></span></span>${Math.round(h)}/100`;
}

function lineChart(canvas, labels, values, color = '#26a69a') {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!values.length) { return; }
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

/* ---------------- views ---------------- */
const views = {};

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
      <div class="kpi"><div class="kpi-label">Active alerts</div><div class="kpi-value" style="color:${k.active_alerts ? 'var(--warn)' : '#57ab5a'}">${k.active_alerts}</div></div>
    </div>
    <div class="grid grid-2 mt16">
      <div class="card"><h3>Energy — last 24h (kWh per half hour)</h3><canvas id="ch-energy" style="width:100%;height:200px"></canvas></div>
      <div class="card"><h3>Avg temperature — last 24h (°C)</h3><canvas id="ch-temp" style="width:100%;height:200px"></canvas></div>
    </div>
    <div class="card"><h3>Machines</h3>
      <table>
        <thead><tr><th>Machine</th><th>Status</th><th>Health</th><th>Temp (°C)</th><th>Power (kW)</th><th>Updated</th></tr></thead>
        <tbody>${d.machines.map((m) => `
          <tr class="row-link" data-id="${esc(m.id)}">
            <td><b>${esc(m.name)}</b><br><span class="muted mono">${esc(m.id)}</span></td>
            <td>${statusTag(m.status)}</td>
            <td>${healthBar(m.health_score)}</td>
            <td>${fmt(m.temperature_c?.value)}</td>
            <td>${fmt(m.power_kw?.value)}</td>
            <td class="muted">${fmtFresh(m.data_freshness_seconds)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  lineChart($('#ch-energy'), d.energy_series.map((p) => p.ts.slice(11, 16)), d.energy_series.map((p) => p.value), '#f0a500');
  lineChart($('#ch-temp'), d.temperature_series.map((p) => p.ts.slice(11, 16)), d.temperature_series.map((p) => p.value), '#58a6ff');
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/machines/${tr.dataset.id}`; }));
};

views.machines = async (el, id) => {
  if (id) return views.machineDetail(el, id);
  el.innerHTML = '<div class="spin"></div>';
  const list = await api('GET', '/api/machines');
  el.innerHTML = `
    <div class="card"><h3>Machines (${list.data.length})</h3>
      <table>
        <thead><tr><th>Machine</th><th>Status</th><th>Health</th><th>Active alerts</th><th>Last reading</th></tr></thead>
        <tbody>${list.data.map((m) => `
          <tr class="row-link" data-id="${esc(m.id)}">
            <td><b>${esc(m.name)}</b><br><span class="muted mono">${esc(m.id)}</span></td>
            <td>${statusTag(m.status)}</td>
            <td>${healthBar(m.health_score)}</td>
            <td>${m.active_alerts ?? 0}</td>
            <td class="muted">${fmtFresh(m.latest?.data_freshness_seconds)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  el.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/machines/${tr.dataset.id}`; }));
};

views.machineDetail = async (el, id) => {
  el.innerHTML = '<div class="spin"></div>';
  const [ov, tel] = await Promise.all([
    api('GET', `/api/machines/${id}`),
    api('GET', `/api/machines/${id}/telemetry?metric=temperature_c&agg=avg&bucketMinutes=30`).catch(() => null),
  ]);
  const c = ov.current || {};
  const alerts = ov.active_alerts || [];
  el.innerHTML = `
    <div class="flex-between">
      <div>
        <h3 style="margin:0">${esc(ov.machine.name)} <span class="muted mono">${esc(ov.machine.id)}</span></h3>
        <div class="mt8">${statusTag(ov.machine.status)} &nbsp; ${healthBar(ov.health_score)} &nbsp;
          <span class="badge-sev sev-${ov.risk.risk_level === 'LOW' ? 'LOW' : ov.risk.risk_level === 'MEDIUM' ? 'MEDIUM' : 'HIGH'}">RISK ${ov.risk.risk_level} (${fmt(ov.risk.risk_score, 2)})</span>
        </div>
      </div>
      <a class="link" href="#/machines">← all machines</a>
    </div>
    <div class="grid grid-4 mt16">
      <div class="kpi"><div class="kpi-label">Temperature</div><div class="kpi-value">${fmt(c.temperature_c?.value)}°C</div><div class="kpi-sub">${fmtAgo(c.temperature_c?.ts)}</div></div>
      <div class="kpi"><div class="kpi-label">Power</div><div class="kpi-value">${fmt(c.power_kw?.value)} kW</div><div class="kpi-sub">${fmtAgo(c.power_kw?.ts)}</div></div>
      <div class="kpi"><div class="kpi-label">Load</div><div class="kpi-value">${fmt(c.load_pct?.value)}%</div><div class="kpi-sub">${fmtAgo(c.load_pct?.ts)}</div></div>
      <div class="kpi"><div class="kpi-label">Operating today</div><div class="kpi-value">${fmt(ov.operating_hours_today, 1)}h</div>
        <div class="kpi-sub">${fmt(ov.energy_today_kwh, 1)} kWh · $${fmt(ov.cost_today_usd, 2)}</div></div>
    </div>
    <div class="grid grid-2 mt16">
      <div class="card"><h3>Temperature — last 24h</h3><canvas id="ch-m-temp" style="width:100%;height:180px"></canvas></div>
      <div class="card"><h3>Active alerts (${alerts.length})</h3>
        ${alerts.length ? `<table><tbody>${alerts.map((a) => `
          <tr><td><span class="${sevClass(a.severity)}">${a.severity}</span></td>
          <td><b>${esc(a.type.replace(/_/g, ' '))}</b><br><span class="muted">${esc(a.message || '')}</span></td>
          <td class="muted">${fmtAgo(a.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No active alerts</div>'}
      </div>
    </div>
    <div class="card"><h3>Risk assessment</h3><div class="muted">${esc(ov.risk.caveat || '')}</div></div>`;
  if (tel?.data?.length) {
    lineChart($('#ch-m-temp'), tel.data.map((p) => p.bucket_ts.slice(11, 16)), tel.data.map((p) => p.value), '#58a6ff');
  }
};

views.alerts = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const d = await api('GET', '/api/alerts?status=ACTIVE&pageSize=100');
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">Active alerts (${d.data.length})</h3>
      <button class="btn btn-sm" id="alerts-refresh">Refresh</button></div>
    <div class="card mt16">
      ${d.data.length ? `<table>
        <thead><tr><th>Severity</th><th>Type</th><th>Machine</th><th>Message</th><th>Triggered</th><th></th></tr></thead>
        <tbody>${d.data.map((a) => `
          <tr>
            <td><span class="${sevClass(a.severity)}">${a.severity}</span></td>
            <td><b>${esc(a.type.replace(/_/g, ' '))}</b></td>
            <td>${esc(a.machine_name || a.machine_id)}</td>
            <td class="muted">${esc(a.message || '')}</td>
            <td class="muted">${fmtAgo(a.created_at)}</td>
            <td style="text-align:right">
              ${a.status === 'ACTIVE' ? `<button class="btn btn-sm" data-ack="${a.id}">Ack</button>` : ''}
              <button class="btn btn-sm btn-primary" data-resolve="${a.id}">Resolve</button>
            </td>
          </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No active alerts 🎉</div>'}
    </div>`;
  el.querySelector('#alerts-refresh').addEventListener('click', () => views.alerts(el));
  el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/alerts/${b.dataset.ack}/acknowledge`); views.alerts(el);
  }));
  el.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/alerts/${b.dataset.resolve}/resolve`); views.alerts(el);
  }));
};

views.maintenance = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [requests, machines] = await Promise.all([api('GET', '/api/maintenance-requests?pageSize=50'), api('GET', '/api/machines')]);
  el.innerHTML = `
    <div class="flex-between"><h3 style="margin:0">Maintenance requests</h3>
      <button class="btn btn-primary btn-sm" id="mreq-new">+ New request</button></div>
    <div class="card mt16">
      ${requests.data.length ? `<table>
        <thead><tr><th>Machine</th><th>Issue</th><th>Priority</th><th>Status</th><th>Technician</th><th>Created</th></tr></thead>
        <tbody>${requests.data.map((r) => `
          <tr>
            <td>${esc(r.machine_name || r.machine_id || '—')}</td>
            <td>${esc(r.issue)}</td>
            <td><span class="${sevClass(r.priority === 'HIGH' ? 'HIGH' : r.priority === 'MEDIUM' ? 'MEDIUM' : 'LOW')}">${r.priority}</span></td>
            <td>${statusTag(r.status)}</td>
            <td class="muted">${esc(r.technician_name || '—')}</td>
            <td class="muted">${fmtAgo(r.created_at)}</td>
          </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No maintenance requests</div>'}
    </div>`;
  el.querySelector('#mreq-new').addEventListener('click', () => {
    openModal('New maintenance request', `
      <label class="muted" style="font-size:13px">Machine</label>
      <select id="mreq-machine" class="modal-select">
        ${machines.data.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}
      </select>
      <label class="muted" style="font-size:13px;margin-top:10px">Issue</label>
      <textarea id="mreq-issue" rows="3" class="modal-select" placeholder="Describe the problem"></textarea>
      <label class="muted" style="font-size:13px;margin-top:10px">Priority</label>
      <select id="mreq-priority" class="modal-select">
        <option value="LOW">LOW</option><option value="MEDIUM" selected>MEDIUM</option><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option>
      </select>`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Create request', cls: 'btn-primary', action: async () => {
        const issue = $('#mreq-issue').value.trim();
        if (!issue) throw new Error('Issue is required');
        await api('POST', '/api/maintenance-requests', { machine_id: $('#mreq-machine').value, issue, priority: $('#mreq-priority').value });
        closeModal(); views.maintenance(el);
      } }]);
  });
};

views.parts = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [parts, requests] = await Promise.all([api('GET', '/api/parts'), api('GET', '/api/spare-requests?pageSize=30')]);
  el.innerHTML = `
    <div class="card"><h3>Inventory (${parts.data.length})</h3>
      <table>
        <thead><tr><th>Part</th><th>SKU</th><th>Available</th><th>Stock</th><th>Reserved</th><th>Reorder level</th><th></th></tr></thead>
        <tbody>${parts.data.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b>${p.available_qty <= p.reorder_level ? ' <span class="badge badge-demo">LOW</span>' : ''}</td>
            <td class="mono">${esc(p.sku)}</td>
            <td><b>${p.available_qty}</b></td>
            <td>${p.stock_qty}</td>
            <td>${p.reserved_qty}</td>
            <td>${p.reorder_level}</td>
            <td style="text-align:right"><button class="btn btn-sm" data-req="${p.id}" data-name="${esc(p.name)}">Request</button></td>
          </tr>`).join('')}</tbody></table>
    </div>
    <div class="card"><h3>Spare requests</h3>
      ${requests.data.length ? `<table>
        <thead><tr><th>Part</th><th>Qty</th><th>Status</th><th>Requested</th></tr></thead>
        <tbody>${requests.data.map((r) => `
          <tr><td>${esc(r.part_name || r.part_id)}</td><td>${r.quantity}</td><td>${statusTag(r.status)}</td><td class="muted">${fmtAgo(r.created_at)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No spare requests</div>'}
    </div>`;
  el.querySelectorAll('[data-req]').forEach((b) => b.addEventListener('click', () => {
    openModal(`Request spare part — ${b.dataset.name}`, `
      <label class="muted" style="font-size:13px">Quantity</label>
      <input id="req-qty" type="number" min="1" value="1" class="modal-select" />`,
      [{ label: 'Cancel', cls: 'btn-ghost' }, { label: 'Submit request', cls: 'btn-primary', action: async () => {
        const qty = parseInt($('#req-qty').value, 10);
        if (!qty || qty < 1) throw new Error('Quantity must be ≥ 1');
        await api('POST', '/api/spare-requests', { part_id: b.dataset.req, quantity: qty });
        closeModal(); views.parts(el);
      } }]);
  }));
};

views.ai = async (el) => {
  el.innerHTML = `
    <div class="card chat-wrap">
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-input-row">
        <input id="chat-input" placeholder="Ask about machines, alerts, parts, documents… (e.g. “Is the Primary Extruder okay?”)" />
        <button class="btn btn-primary" id="chat-send">Send</button>
      </div>
    </div>`;
  const log = $('#chat-log');
  const input = $('#chat-input');
  const render = () => {
    log.innerHTML = state.conv.map((m) => m.role === 'user'
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
                <button class="btn btn-sm btn-primary" data-confirm="${esc(m.pending.token)}">Confirm &amp; execute</button>
                <button class="btn btn-sm btn-ghost" data-cancel>Cancel</button>
              </div></span>` : ''}
          </div></div>`).join('');
    log.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api('POST', '/api/ai/actions/confirm', { token: b.dataset.confirm });
        b.closest('.action-card').outerHTML = `<div class="muted mt8">✅ Executed: <b>${esc(r.kind)}</b>${r.result?.id ? ` (${esc(r.result.id.slice(0, 8))})` : ''}</div>`;
      } catch (err) {
        b.closest('.action-card').outerHTML = `<div class="muted mt8" style="color:var(--danger)">❌ ${esc(err.message)}</div>`;
      }
    }));
    log.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => { b.closest('.action-card').remove(); }));
    log.scrollTop = log.scrollHeight;
  };
  render();
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
      const r = await api('POST', '/api/ai/chat', { message: text });
      const pending = r.pendingActions?.[0];
      state.conv[typing] = {
        role: 'ai', text: r.reply, model: r.model, evidence: r.evidence, confidence: r.confidence,
        pending: pending ? { label: pending.label, token: pending.confirmToken } : null,
      };
    } catch (err) {
      state.conv[typing] = { role: 'ai', text: `⚠ ${err.message}` };
    }
    render();
  };
  $('#chat-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
};

views.reports = async (el) => {
  const kinds = [
    ['machines', 'Machines overview'], ['energy', 'Energy & cost'], ['alerts', 'Alerts'],
    ['maintenance', 'Maintenance events'], ['inventory', 'Inventory'], ['requests', 'Requests'], ['insights', 'AI insights'],
  ];
  el.innerHTML = `
    <div class="card"><h3>Export reports</h3>
      <table>
        <thead><tr><th>Report</th><th>CSV</th><th>XLSX</th><th>PDF</th></tr></thead>
        <tbody>${kinds.map(([k, label]) => `
          <tr><td><b>${label}</b></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="csv">Download</button></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="xlsx">Download</button></td>
          <td><button class="btn btn-sm" data-kind="${k}" data-fmt="pdf">Download</button></td></tr>`).join('')}</tbody></table>
      <div class="muted mt8" style="font-size:12px">Every export is audited (REPORT.EXPORT).</div>
    </div>`;
  el.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await downloadReport(b.dataset.kind, b.dataset.fmt); } catch (err) { alert(err.message); }
    b.disabled = false;
  }));
};

views.admin = async (el) => {
  el.innerHTML = '<div class="spin"></div>';
  const [health, users, usage] = await Promise.all([
    api('GET', '/api/admin/health'), api('GET', '/api/admin/users'),
    api('GET', '/api/admin/ai/usage').catch(() => null),
  ]);
  const c = health.counts;
  const s = usage?.summary || {};
  el.innerHTML = `
    <div class="grid grid-4">
      <div class="kpi"><div class="kpi-label">Telemetry readings</div><div class="kpi-value">${(c.telemetry_readings ?? 0).toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">Active alerts</div><div class="kpi-value">${c.active_alerts ?? 0}</div><div class="kpi-sub">${(c.audit_events ?? 0).toLocaleString()} audit events</div></div>
      <div class="kpi"><div class="kpi-label">Users</div><div class="kpi-value">${c.users ?? 0}</div><div class="kpi-sub">${c.machines ?? 0} machines</div></div>
      <div class="kpi"><div class="kpi-label">AI usage (30d)</div><div class="kpi-value">${(s.requests ?? 0).toLocaleString()}</div>
        <div class="kpi-sub">${fmt(s.cost_usd, 2) !== '—' ? `$${fmt(s.cost_usd, 2)}` : ''} · avg ${fmt(s.avg_latency_ms, 0)} ms · ${s.failures ?? 0} failures</div></div>
    </div>
    <div class="card mt16"><h3>Telemetry by source</h3>
      <div>${Object.entries(c.telemetry_by_source || {}).map(([s2, n]) => `<span class="evidence-chip">${esc(s2)}: ${n.toLocaleString()}</span>`).join('')}</div>
    </div>
    <div class="card"><h3>Users</h3>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>${users.data.map((u) => `
        <tr><td><b>${esc(u.display_name)}</b></td><td>${esc(u.email)}</td>
        <td><span class="evidence-chip">${esc(u.role)}</span></td><td>${esc(u.status)}</td></tr>`).join('')}</tbody></table>
    </div>
    ${usage?.byModel?.length ? `<div class="card"><h3>AI usage by model</h3>
      <table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr></thead>
      <tbody>${usage.byModel.map((u) => `
        <tr><td>${esc(u.provider)}</td><td class="mono">${esc(u.model)}</td>
        <td>${u.requests}</td><td>${(u.input_tokens ?? 0).toLocaleString()}</td><td>${(u.output_tokens ?? 0).toLocaleString()}</td>
        <td>$${fmt(u.cost_usd, 2)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
};

/* ---------------- router ---------------- */
function showView(name, param) {
  const v = views[name];
  if (!v) { $('#content').innerHTML = '<div class="empty">Unknown view</div>'; return; }
  const titles = { dashboard: 'Dashboard', machines: 'Machines', alerts: 'Alerts', maintenance: 'Maintenance', parts: 'Spare Parts', ai: 'AI Copilot', reports: 'Reports', admin: 'Admin' };
  $('#page-title').textContent = titles[name] || 'SmartPlant';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const el = $('#content');
  el.innerHTML = '';
  v(el, param).catch((err) => { el.innerHTML = `<div class="empty">⚠ ${esc(err.message)}</div>`; });
}

function route() {
  const h = location.hash || '#/dashboard';
  const [base, param] = h.slice(1).split('/');
  const name = ['dashboard', 'machines', 'alerts', 'maintenance', 'parts', 'ai', 'reports', 'admin'].includes(base) ? base : 'dashboard';
  showView(name, param ? decodeURIComponent(param) : undefined);
}

/* ---------------- login / shell ---------------- */
function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  const hint = $('#demo-hint');
  if (state.demo !== false) {
    hint.classList.remove('hidden');
    $('#demo-badge').classList.remove('hidden');
  }
  const users = ['admin', 'manager', 'supervisor', 'technician', 'worker', 'viewer'];
  $('#demo-users').innerHTML = users.map((r) =>
    `<button type="button" class="demo-user-btn" data-u="${r}">${r}</button>`).join('');
  $('#demo-users').querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => {
    $('#login-email').value = `${b.dataset.u}@smartplant.local`;
    $('#login-password').value = `${b.dataset.u[0].toUpperCase()}${b.dataset.u.slice(1)}123!`;
  }));
}

async function enterShell() {
  $('#login-view').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#user-name').textContent = state.user.display_name;
  $('#user-role').textContent = state.user.role;
  $('#demo-badge-shell').classList.toggle('hidden', !state.demo);
  $('#nav-admin').classList.toggle('hidden', !['ADMIN', 'MANAGER'].includes(state.user.role));
  if (!location.hash) location.hash = '#/dashboard';
  route();
}

async function boot() {
  try {
    if (state.token) {
      const me = await api('GET', '/api/auth/me');
      state.user = me.user;
      state.demo = !!me.demo_mode;
      await enterShell();
      return;
    }
  } catch { /* fall through to login */ }
  // detect demo mode for the login hint
  try {
    const h = await fetch('/health').then((r) => r.json());
    state.demo = h.mode === 'demo';
  } catch { state.demo = false; }
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
    try {
      const h = await fetch('/health').then((x) => x.json());
      state.demo = h.mode === 'demo';
    } catch { state.demo = false; }
    await enterShell();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  state.token = null; state.user = null; state.conv = [];
  localStorage.removeItem('sp_token');
  showLogin();
});

$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
window.addEventListener('hashchange', route);

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
