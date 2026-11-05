/* global document, window, fetch, AbortController, performance, navigator, Blob, URL */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const endpoints = [
    { id: 'api', path: '/ping', name: 'Server merespons tanpa database', expected: [200] },
    { id: 'database', path: '/health', name: 'Server dan database tersambung', expected: [200] },
    { id: 'docs', path: '/docs/json', name: 'Dokumentasi API dapat dibaca', expected: [200] },
    { id: 'session', path: '/api/auth/me', name: 'Sesi login dan proteksi akses', expected: [200, 401] },
  ];
  const state = { busy: false, automatic: false, next: 0, timer: null, samples: [], checks: new Map(), controllers: new Set() };
  const rows = new Map();
  const formatMs = value => Number.isFinite(value) ? new Intl.NumberFormat('id-ID').format(Math.round(value)) : '—';
  const time = date => new Date(date).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => $('toast').classList.remove('visible'), 2800);
  }
  function setBanner(kind, label, title, description) {
    $('status-panel').dataset.state = kind;
    $('status-label').textContent = label;
    $('status-title').textContent = title;
    $('status-description').textContent = description;
  }
  function classify(check) {
    if (!check) return { kind: '', label: 'Belum dites' };
    if (check.checking) return { kind: '', label: 'Memeriksa…' };
    if (!check.passed) return { kind: 'error', label: check.status ? `${check.status} · Gagal` : check.timeout ? 'Timeout' : 'Tidak terjangkau' };
    if (check.status === 401) return { kind: 'protected', label: '401 · Perlu login' };
    if (check.id === 'session') return { kind: 'ok', label: '200 · Sesi aktif' };
    return { kind: check.elapsed_ms >= 2000 ? 'slow' : 'ok', label: `${check.status} · ${check.elapsed_ms >= 2000 ? 'Lambat' : 'OK'}` };
  }
  for (const endpoint of endpoints) {
    const tr = element('tr');
    const route = element('td');
    route.append(element('span', 'method', 'GET'), element('code', '', endpoint.path));
    const status = element('span', 'pill', 'Belum dites');
    const statusCell = element('td'); statusCell.append(status);
    const duration = element('td', 'row-time', '—');
    const detailButton = element('button', 'details-button', 'Lihat JSON');
    detailButton.type = 'button'; detailButton.disabled = true;
    detailButton.setAttribute('aria-expanded', 'false');
    const detailId = `response-${endpoint.id}`;
    detailButton.setAttribute('aria-controls', detailId);
    const action = element('td'); action.append(detailButton);
    tr.append(route, element('td', '', endpoint.name), statusCell, duration, action);
    const detailRow = element('tr', 'response-row'); detailRow.hidden = true; detailRow.id = detailId;
    const detailCell = element('td'); detailCell.colSpan = 5;
    const pre = element('pre'); detailCell.append(pre); detailRow.append(detailCell);
    detailButton.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      detailButton.setAttribute('aria-expanded', String(!detailRow.hidden));
      detailButton.textContent = detailRow.hidden ? 'Lihat JSON' : 'Tutup JSON';
    });
    $('endpoint-rows').append(tr, detailRow);
    rows.set(endpoint.id, { status, duration, detailButton, pre });
  }
  function renderCheck(check) {
    const row = rows.get(check.id);
    const badge = classify(check);
    row.status.className = `pill ${badge.kind}`;
    row.status.textContent = badge.label;
    row.duration.textContent = check.checking ? '—' : `${formatMs(check.elapsed_ms)} ms`;
    row.detailButton.disabled = check.checking || !check.preview;
    row.pre.textContent = check.checking ? 'Menunggu respons…' : check.preview || '';
    if (check.id === 'api' || check.id === 'database') {
      const prefix = check.id === 'api' ? 'api' : 'db';
      $(prefix + '-time').replaceChildren(document.createTextNode(check.checking ? '—' : formatMs(check.elapsed_ms)), element('small', '', 'ms'));
      $(prefix + '-pill').className = `pill ${badge.kind}`;
      $(prefix + '-pill').textContent = badge.label;
    }
  }
  function safePreview(body) {
    const json = JSON.stringify(body, (key, value) => /password|token|secret|authorization|cookie/i.test(key) ? '[DISEMBUNYIKAN]' : value, 2);
    return json.length > 6000 ? json.slice(0, 6000) + '\n\n… Tampilan dibatasi 6.000 karakter.' : json;
  }
  async function request(endpoint, timeout) {
    const controller = new AbortController();
    state.controllers.add(controller);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const start = performance.now();
    let check;
    try {
      const response = await fetch(endpoint.path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 3000) }; }
      const validPayload = endpoint.id === 'api' || endpoint.id === 'database' ? data?.data?.status === 'ok'
        : endpoint.id === 'docs' ? typeof data?.openapi === 'string' : response.status === 401 || Boolean(data?.data?.user);
      check = { id: endpoint.id, path: endpoint.path, status: response.status, expected: endpoint.expected, passed: endpoint.expected.includes(response.status) && validPayload,
        elapsed_ms: Math.round(performance.now() - start), checked_at: new Date().toISOString(), timeout: false, preview: safePreview(data) };
    } catch {
      check = { id: endpoint.id, path: endpoint.path, status: null, expected: endpoint.expected, passed: false,
        elapsed_ms: Math.round(performance.now() - start), checked_at: new Date().toISOString(), timeout: timedOut,
        preview: JSON.stringify({ error: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', message: timedOut ? `Belum ada respons lengkap dalam ${timeout / 1000} detik.` : 'Server tidak dapat dijangkau. Pastikan backend masih berjalan.' }, null, 2) };
    } finally { window.clearTimeout(timer); state.controllers.delete(controller); }
    state.checks.set(endpoint.id, check);
    renderCheck(check);
    return check;
  }
  function summary(api, database) {
    if (!api.passed) return { kind: 'error', label: 'API BERMASALAH', title: 'Server belum dapat dijangkau', description: 'Cek terminal backend dan alamat halaman. Setiap request sudah dibatasi waktunya.' };
    if (!database.passed) return { kind: 'warning', label: 'PERLU DIPERIKSA', title: 'API hidup, database bermasalah', description: database.timeout ? 'Ping server berhasil, tetapi pemeriksaan database melewati batas tunggu.' : 'Ping server berhasil, tetapi /health belum memberikan status database yang sehat.' };
    if (Math.max(api.elapsed_ms, database.elapsed_ms) >= 2000) return { kind: 'slow', label: 'TERHUBUNG · RESPONS LAMBAT', title: 'Tersambung, sedikit lebih lambat', description: 'API dan database merespons. Koneksi database yang baru aktif bisa membutuhkan beberapa detik.' };
    return { kind: 'ok', label: 'SEMUA TERHUBUNG', title: 'Backend siap digunakan', description: 'Server API merespons dan koneksi database berhasil diperiksa.' };
  }
  function renderChart() {
    const points = state.samples;
    const values = points.flatMap(s => [s.api, s.database]).filter(c => c.passed).map(c => c.elapsed_ms);
    const maximum = Math.max(100, Math.ceil(Math.max(0, ...values) / 100) * 100);
    $('chart-max').textContent = formatMs(maximum) + ' ms';
    $('chart-mid').textContent = formatMs(maximum / 2) + ' ms';
    $('chart-empty').hidden = points.length > 0;
    const group = $('chart-series'); group.replaceChildren();
    const svg = (tag, attrs) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
    for (const [key, color] of [['api', '#337fa6'], ['database', '#2da27a']]) {
      let segment = '';
      const flush = () => { if (segment) group.append(svg('path', { d: segment, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' })); segment = ''; };
      points.forEach((sample, index) => {
        const x = points.length === 1 ? 320 : 8 + index * 624 / (points.length - 1);
        const check = sample[key];
        if (!check.passed) { flush(); group.append(svg('path', { d: `M${x - 3} 145l6 6m-6 0 6-6`, stroke: '#cd6764', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' })); return; }
        const y = 152 - check.elapsed_ms / maximum * 144;
        segment += `${segment ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
        const point = svg('circle', { cx: x, cy: y, r: 3, fill: color });
        const title = svg('title', {}); title.textContent = `${key === 'api' ? 'API' : 'Database'}: ${formatMs(check.elapsed_ms)} ms · ${time(sample.at)}`; point.append(title); group.append(point);
      }); flush();
    }
  }
  function renderHistory() {
    const samples = state.samples;
    const successes = samples.filter(s => s.api.passed && s.database.passed).length;
    $('success-value').replaceChildren(document.createTextNode(samples.length ? String(Math.round(100 * successes / samples.length)) : '—'), element('small', '', '%'));
    $('success-detail').textContent = samples.length ? `${successes} dari ${samples.length} siklus terakhir berhasil` : 'Belum ada pemeriksaan';
    $('log-empty').hidden = samples.length > 0;
    $('log-list').replaceChildren();
    for (const sample of [...samples].reverse().slice(0, 12)) {
      const status = summary(sample.api, sample.database);
      const li = element('li'); li.dataset.state = status.kind;
      const clock = element('time', '', time(sample.at)); clock.dateTime = sample.at;
      li.append(clock, element('span', 'dot'), element('span', 'log-message', status.title), element('span', 'log-timing', `API ${sample.api.passed ? formatMs(sample.api.elapsed_ms) + ' ms' : 'gagal'} · DB ${sample.database.passed ? formatMs(sample.database.elapsed_ms) + ' ms' : sample.database.timeout ? 'timeout' : 'gagal'}`));
      $('log-list').append(li);
    }
    renderChart();
  }
  function scheduleNext() {
    window.clearTimeout(state.timer); state.next = 0;
    if (state.automatic && !state.busy) {
      const interval = Number($('interval').value) * 1000;
      state.next = Date.now() + interval;
      state.timer = window.setTimeout(() => run(false), interval);
    }
    renderCountdown();
  }
  function renderCountdown() {
    $('countdown').textContent = state.busy ? 'Pemeriksaan sedang berjalan…' : state.automatic ? `Ping berikutnya dalam ${Math.max(0, Math.ceil((state.next - Date.now()) / 1000))} detik` : 'Mode manual aktif';
  }
  async function run(all) {
    if (state.busy) return;
    state.busy = true; window.clearTimeout(state.timer); state.next = 0;
    const selected = all ? endpoints : endpoints.slice(0, 2);
    const timeout = Number($('timeout').value);
    for (const id of ['ping-button', 'check-button', 'interval', 'timeout', 'clear-button']) $(id).disabled = true;
    for (const endpoint of selected) { const pending = { id: endpoint.id, checking: true }; state.checks.set(endpoint.id, pending); renderCheck(pending); }
    setBanner('checking', 'SEDANG MEMERIKSA', 'Menghubungi backend…', `Batas tunggu ${timeout / 1000} detik per request.`);
    const started = performance.now();
    const ticker = window.setInterval(() => {
      const pending = selected.filter(e => state.checks.get(e.id)?.checking).map(e => e.id === 'database' ? 'database' : e.id === 'api' ? 'API' : e.id === 'docs' ? 'dokumentasi' : 'sesi');
      $('status-description').textContent = `Menunggu ${pending.join(', ') || 'hasil'} · ${((performance.now() - started) / 1000).toFixed(1)} / ${timeout / 1000} detik`;
    }, 200);
    renderCountdown();
    try {
      const checks = await Promise.all(selected.map(e => request(e, timeout)));
      const api = checks.find(c => c.id === 'api'); const database = checks.find(c => c.id === 'database');
      const at = new Date().toISOString();
      state.samples.push({ at, api, database }); state.samples = state.samples.slice(-30);
      const status = summary(api, database); setBanner(status.kind, status.label, status.title, status.description);
      $('last-time').textContent = time(at);
      $('last-date').textContent = new Date(at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      renderHistory();
    } finally {
      window.clearInterval(ticker); state.busy = false;
      for (const id of ['ping-button', 'check-button', 'interval', 'timeout', 'clear-button']) $(id).disabled = false;
      scheduleNext();
    }
  }
  $('target').textContent = window.location.protocol === 'file:' ? 'http://127.0.0.1:3001' : window.location.origin;
  $('ping-button').addEventListener('click', () => run(false));
  $('check-button').addEventListener('click', () => run(true));
  $('interval').addEventListener('change', scheduleNext);
  $('auto-toggle').addEventListener('click', () => {
    state.automatic = !state.automatic;
    $('auto-toggle').setAttribute('aria-checked', String(state.automatic));
    $('auto-description').textContent = state.automatic ? 'Berjalan selama halaman terbuka' : 'Jalankan saat diperlukan';
    scheduleNext();
  });
  $('clear-button').addEventListener('click', () => { state.samples = []; renderHistory(); toast('Riwayat ping di layar sudah dibersihkan.'); });
  $('copy-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('target').textContent); toast('Alamat server disalin.'); }
    catch { toast('Alamat server: ' + $('target').textContent); }
  });
  $('download-button').addEventListener('click', () => {
    if (!state.samples.length) { toast('Lakukan ping terlebih dahulu untuk membuat laporan.'); return; }
    const report = { recorded_at: new Date().toISOString(), target: window.location.origin, samples: state.samples, endpoint_checks: [...state.checks.values()] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = `caps2tone-ping-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Laporan ping diunduh.');
  });
  window.addEventListener('pagehide', () => { state.automatic = false; window.clearTimeout(state.timer); for (const controller of state.controllers) controller.abort(); });
  window.setInterval(renderCountdown, 1000);
  if (window.location.protocol === 'file:') {
    setBanner('warning', 'BUKA MELALUI SERVER', 'Gunakan alamat monitor backend', 'Buka http://127.0.0.1:3001/monitor/ agar pemeriksaan dapat terhubung ke API.');
    $('ping-button').disabled = true; $('check-button').disabled = true; $('auto-toggle').disabled = true;
  } else { run(false); }
})();
