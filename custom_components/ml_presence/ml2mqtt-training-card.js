/**
 * ML2MQTT Training Card v2
 * Custom Lovelace card for managing ml2mqtt room prediction model training.
 * Features: multi-model switching, auto-detect user, polished UI.
 */
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ml2mqtt-training-card',
  name: 'ML2MQTT Training Card',
  description: 'Manage ml2mqtt model training for room prediction',
});

class ML2MQTTTrainingCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = {};
    this._rendered = false;
    this._pollTimer = null;
    this._polling = false;
    this._toastTimer = null;
    this._els = {};
    this._selectedLabel = null;
    this._isCollecting = false;
    this._lastLabelsJson = '';
    this._ingressUrl = null;
    this._activeModel = null;
    this._models = [];
    this._errorCount = 0;
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    this._config = {
      model_name: config.model_name || null,
      addon_slug: config.addon_slug || '4127ca46_ml2mqtt',
      poll_interval: config.poll_interval || 3000,
      user_model_map: config.user_model_map || {
        'Sam': 'sam_whoop',
        'Rhiannon': 'rhi_whoop',
      },
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered && this.isConnected) {
      this._render();
      this._rendered = true;
      this._initCard();
    }
  }

  connectedCallback() {
    if (this._hass && !this._rendered) {
      this._render();
      this._rendered = true;
      this._initCard();
    } else if (this._hass) {
      this._startPolling();
    }
  }

  disconnectedCallback() { this._stopPolling(); }
  getCardSize() { return 12; }

  async _initCard() {
    try { await this._initIngress(); } catch (e) {
      console.error('ml2mqtt: ingress init failed, retrying in 5s…', e);
      setTimeout(() => this._initCard(), 5000);
      return;
    }

    // Auto-detect model from HA user (case-insensitive, partial match)
    const userName = this._hass?.user?.name || '';
    console.log('ml2mqtt: HA user name =', userName);
    if (userName && this._config.user_model_map) {
      const lowerUser = userName.toLowerCase();
      for (const [key, model] of Object.entries(this._config.user_model_map)) {
        if (lowerUser === key.toLowerCase() || lowerUser.startsWith(key.toLowerCase())) {
          this._activeModel = model;
          console.log('ml2mqtt: matched user', key, '→ model', model);
          break;
        }
      }
    }

    // Explicit config override
    if (!this._activeModel && this._config.model_name) {
      this._activeModel = this._config.model_name;
    }

    // Fetch model list (graceful if endpoint doesn't exist yet)
    try {
      const resp = await this._apiCall('GET', '/api/models');
      if (resp.models) this._models = resp.models;
    } catch (e) { /* endpoint not deployed yet */ }

    // Build models list from user_model_map if API didn't return any
    if (this._models.length === 0 && this._config.user_model_map) {
      this._models = Object.values(this._config.user_model_map).map(n => ({ name: n }));
    }

    // Final fallback
    if (!this._activeModel && this._models.length > 0) {
      this._activeModel = this._models[0].name;
    }
    if (!this._activeModel) this._activeModel = 'sam_whoop';

    console.log('ml2mqtt: active model =', this._activeModel, '| models =', this._models.map(m => m.name));
    this._renderModelSwitcher();
    this._startPolling();
  }

  /* ── Polling ──────────────────────────────────────────────── */
  _startPolling() {
    if (this._pollTimer) return;
    this._pollLiveData();
    this._pollTimer = setInterval(() => this._pollLiveData(), this._config.poll_interval);
  }
  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /* ── Ingress API ──────────────────────────────────────────── */
  async _initIngress() {
    try {
      const info = await this._hass.callWS({
        type: 'supervisor/api',
        endpoint: `/addons/${this._config.addon_slug}/info`,
        method: 'get',
      });
      this._ingressUrl = (info?.data || info).ingress_entry;
    } catch (e) { console.error('ml2mqtt: addon info failed:', e); throw e; }

    try {
      const sr = await this._hass.callWS({
        type: 'supervisor/api',
        endpoint: '/ingress/session',
        method: 'post',
      });
      const session = sr?.data?.session || sr?.session;
      document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${
        location.protocol === 'https:' ? ';Secure' : ''
      }`;
    } catch (e) { console.error('ml2mqtt: ingress session failed:', e); throw e; }
  }

  async _apiCall(method, path, body = null) {
    if (!this._ingressUrl) await this._initIngress();
    const url = `${this._ingressUrl}${path}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    let resp = await fetch(url, opts);
    if (resp.status === 401 || resp.status === 403) {
      this._ingressUrl = null;
      await this._initIngress();
      resp = await fetch(`${this._ingressUrl}${path}`, opts);
    }
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return resp.json();
  }

  /* ── Data Methods ─────────────────────────────────────────── */
  get _mp() { return `/api/model/${this._activeModel}`; }

  async _pollLiveData() {
    if (this._polling || !this._hass || !this._activeModel) return;
    this._polling = true;
    try {
      const d = await this._apiCall('GET', `${this._mp}/live`);
      this._errorCount = 0;
      this._updatePrediction(d);
      this._updatePills(d);
      this._updateSensors(d.sensors);
      this._updateStats(d);
      this._syncServerState(d);
      this._setStatus('connected');
    } catch (e) {
      this._errorCount++;
      if (this._errorCount > 3) this._setStatus('error');
    } finally { this._polling = false; }
  }

  async _toggleCollection() {
    if (this._isCollecting) return this._stopCollecting();
    if (!this._selectedLabel) { this._showToast('Select a room first', 'warn'); return; }
    return this._startCollecting(this._selectedLabel);
  }
  async _startCollecting(label) {
    try {
      const d = await this._apiCall('POST', `${this._mp}/collect`, { action: 'start', label });
      if (d.success) { this._isCollecting = true; this._updateCollectionUI(); this._showToast(`Collecting: ${label}`); }
    } catch (e) { this._showToast('Error starting collection', 'error'); }
  }
  async _stopCollecting() {
    try {
      const d = await this._apiCall('POST', `${this._mp}/collect`, { action: 'stop' });
      if (d.success) { this._isCollecting = false; this._updateCollectionUI(); this._showToast('Collection stopped'); }
    } catch (e) { this._showToast('Error stopping', 'error'); }
  }
  async _setLearningType(type) {
    try {
      await this._apiCall('POST', `${this._mp}/learning-type`, { learning_type: type });
      this._updateModeUI(type); this._showToast(`Mode: ${type}`);
    } catch (e) { this._showToast('Error changing mode', 'error'); }
  }
  async _retrainModel() {
    this._showToast('Retraining…');
    try {
      const d = await this._apiCall('POST', `${this._mp}/retrain`);
      if (d.success) {
        const acc = d.accuracy != null ? `${Math.round(d.accuracy * 100)}%` : 'N/A';
        this._showToast(`Retrained! Accuracy: ${acc}`, 'success');
        this._loadDataHealth();
      }
    } catch (e) { this._showToast('Error retraining', 'error'); }
  }
  async _loadDataHealth() {
    try { this._renderDataHealth(await this._apiCall('GET', `${this._mp}/data-health`)); }
    catch (e) { console.error('Data health error:', e); }
  }
  async _loadConfusionMatrix() {
    try { this._renderConfusionMatrix(await this._apiCall('GET', `${this._mp}/confusion-matrix`)); }
    catch (e) { this._els.confMatrix.innerHTML = '<div class="empty">Error loading matrix</div>'; }
  }
  async _loadSensors() {
    try { this._renderSensorMgmt(await this._apiCall('GET', `${this._mp}/sensors`)); }
    catch (e) { this._els.sensorList.innerHTML = '<div class="empty">Error loading sensors</div>'; }
  }
  async _clearLabel(label) {
    if (!confirm(`Delete ALL data for "${label}"?`)) return;
    try {
      const d = await this._apiCall('POST', `${this._mp}/label/${encodeURIComponent(label)}/data`, { _method: 'DELETE' });
      if (d.success) { this._showToast(`Cleared ${label}`); this._loadDataHealth(); }
    } catch (e) { this._showToast('Error clearing data', 'error'); }
  }
  async _deleteSensor(entityId) {
    if (!confirm(`Remove sensor "${entityId}"?`)) return;
    try {
      const d = await this._apiCall('POST', `${this._mp}/sensor/${encodeURIComponent(entityId)}`, { _method: 'DELETE' });
      if (d.success) { this._showToast('Removed sensor'); this._loadSensors(); }
    } catch (e) { this._showToast('Error removing sensor', 'error'); }
  }
  async _addLabel(label) {
    if (!label.trim()) return;
    try {
      const d = await this._apiCall('POST', `${this._mp}/label/add`, { label: label.trim() });
      if (d.success) { this._showToast(`Added: ${label.trim()}`); this._els.newLabelInput.value = ''; }
    } catch (e) { this._showToast('Error adding room', 'error'); }
  }

  /* ── UI Updates ───────────────────────────────────────────── */
  _setStatus(s) {
    const dot = this._els.statusDot;
    if (!dot) return;
    dot.className = `status-dot ${s}`;
    dot.title = s === 'connected' ? 'Connected' : s === 'error' ? 'Connection error' : 'Connecting…';
  }

  _updatePrediction(d) {
    const { ring, predLabel, predConf, smoothedBadge, smoothedLabel } = this._els;
    if (!d.prediction) {
      predLabel.textContent = '—';
      predConf.textContent = 'Waiting for data…';
      ring.className = 'pred-ring'; smoothedBadge.style.display = 'none'; return;
    }
    predLabel.textContent = d.prediction;
    const pct = Math.round(d.confidence * 100);
    predConf.textContent = `${pct}%`;
    ring.className = 'pred-ring';
    ring.classList.add(d.confidence >= 0.75 ? 'high' : d.confidence >= 0.5 ? 'med' : 'low');
    // Confidence arc
    ring.style.setProperty('--conf-deg', `${Math.round(d.confidence * 360)}deg`);
    if (d.smoothed_prediction && d.smoothed_prediction !== d.prediction) {
      smoothedBadge.style.display = ''; smoothedLabel.textContent = d.smoothed_prediction;
    } else { smoothedBadge.style.display = 'none'; }
  }

  _updatePills(d) {
    if (!d.labels) return;
    const c = this._els.labelPills;
    const lj = JSON.stringify(d.labels);
    if (this._lastLabelsJson !== lj) {
      this._lastLabelsJson = lj;
      c.innerHTML = '';
      for (const lbl of d.labels) {
        const p = document.createElement('button');
        p.className = 'pill'; p.dataset.label = lbl; p.textContent = lbl;
        p.addEventListener('click', () => this._selectLabel(lbl));
        c.appendChild(p);
      }
      if (!this._selectedLabel && d.labels.length > 0) this._selectedLabel = d.labels[0];
    }
    c.querySelectorAll('.pill').forEach(p => {
      const lbl = p.dataset.label;
      p.classList.toggle('predicted', lbl === d.prediction && lbl !== this._selectedLabel);
      p.classList.toggle('selected', lbl === this._selectedLabel);
      p.classList.toggle('collecting', this._isCollecting && lbl === this._selectedLabel);
    });
  }

  _selectLabel(label) {
    this._selectedLabel = label;
    this._els.labelPills.querySelectorAll('.pill').forEach(p => p.classList.toggle('selected', p.dataset.label === label));
    if (this._isCollecting) this._startCollecting(label);
  }

  _updateSensors(sensors) {
    const t = this._els.sensorTable;
    if (!sensors?.length) { t.innerHTML = '<div class="s-row empty"><span>Waiting for MQTT data…</span></div>'; return; }
    t.innerHTML = sensors.map(s => {
      let v = s.value;
      if (s.status === 'normal') try { v = parseFloat(s.value).toFixed(1); } catch(e) {}
      let icon = '📡';
      const n = s.display_name.toLowerCase();
      if (n.includes('motion') || n.includes('pir')) icon = '🏃';
      else if (n.includes('media') || n.includes('tv') || n.includes('speaker')) icon = '📺';
      else if (n.includes('temp')) icon = '🌡️';
      else if (n.includes('presence')) icon = '🎯';
      return `<div class="s-row">
        <div class="s-info"><span class="s-icon">${icon}</span><span class="s-name">${this._esc(s.display_name)}</span></div>
        <span class="s-val ${s.status}">${this._esc(String(v))}</span>
      </div>`;
    }).join('');
    this._els.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  _updateStats(d) {
    this._els.obsCount.textContent = d.observation_count || 0;
    const acc = d.accuracy;
    this._els.accuracy.textContent = acc != null ? `${Math.round(acc * 100)}%` : '—';
    if (d.label_stats) {
      this._els.labelBreakdown.innerHTML = Object.entries(d.label_stats)
        .map(([l, c]) => `<span class="lbl-cnt"><b>${this._esc(l)}</b> ${c}</span>`).join('');
    }
  }

  _updateCollectionUI() {
    const { collectBtn, collectText, collectIcon } = this._els;
    if (this._isCollecting) {
      collectBtn.classList.add('active');
      collectText.textContent = `COLLECTING: ${this._selectedLabel}`;
      collectIcon.textContent = '⏺';
    } else {
      collectBtn.classList.remove('active');
      collectText.textContent = 'START COLLECTING';
      collectIcon.textContent = '●';
    }
  }

  _updateModeUI(type) {
    this._els.modeEager.classList.toggle('active', type === 'EAGER');
    this._els.modeLazy.classList.toggle('active', type === 'LAZY');
    this._els.modeHint.textContent = type === 'EAGER' ? 'Saves every reading' : 'Saves only wrong predictions';
  }

  _syncServerState(d) {
    this._isCollecting = !!d.collecting;
    if (d.collecting && d.collecting_label) this._selectedLabel = d.collecting_label;
    this._updateCollectionUI();
    if (d.learning_type) this._updateModeUI(d.learning_type);
  }

  /* ── Model Switcher ───────────────────────────────────────── */
  _renderModelSwitcher() {
    const c = this._els.modelSwitcher;
    if (!c) return;
    c.innerHTML = '';
    const models = this._models.length > 0 ? this._models : [{ name: this._activeModel }];
    for (const m of models) {
      const btn = document.createElement('button');
      btn.className = `model-btn${m.name === this._activeModel ? ' active' : ''}`;
      btn.textContent = m.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      btn.addEventListener('click', () => this._switchModel(m.name));
      c.appendChild(btn);
    }
  }

  _switchModel(name) {
    if (name === this._activeModel) return;
    this._activeModel = name;
    this._selectedLabel = null;
    this._lastLabelsJson = '';
    this._isCollecting = false;
    this._updateCollectionUI();
    this._renderModelSwitcher();
    this._showToast(`Switched to ${name.replace(/_/g, ' ')}`);
    // Close any open panels
    ['dataPanel', 'confPanel', 'sensorPanel'].forEach(id => {
      const p = this.shadowRoot.getElementById(id);
      if (p) p.style.maxHeight = '0px';
      const ch = this.shadowRoot.getElementById(id + 'Chev');
      if (ch) ch.classList.remove('open');
    });
  }

  /* ── Panel Renderers ──────────────────────────────────────── */
  _renderDataHealth(data) {
    const w = this._els.dataWarnings;
    w.innerHTML = (data.warnings?.length) ? data.warnings.map(wr => `<div class="warn-box"><span class="icon">⚠</span>${this._esc(wr.msg)}</div>`).join('') : '';
    const b = this._els.labelBars;
    const counts = data.label_counts || {};
    const entries = Object.entries(counts).sort((a, bb) => bb[1] - a[1]);
    const mx = Math.max(...Object.values(counts), 1);
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (!entries.length) { b.innerHTML = '<div class="empty">No observations yet</div>'; return; }
    b.innerHTML = '<div class="dh-list">' + entries.map(([l, c]) => {
      const pct = Math.round((c / mx) * 100);
      const absPct = total > 0 ? Math.round((c / total) * 100) : 0;
      return `<div class="dh-item">
        <div class="dh-head">
          <span class="dh-name">${this._esc(l)}</span>
          <div class="dh-stats"><span class="dh-num">${c} obs</span><span class="dh-pct">${absPct}%</span>
          <button class="icon-btn del-btn" data-label="${this._esc(l)}" title="Clear">🗑</button></div>
        </div>
        <div class="lb-track"><div class="lb-fill ${c < mx * 0.4 ? 'low' : 'good'}" style="width:${pct}%"></div></div>
      </div>`;
    }).join('') + '</div>';
    b.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._clearLabel(btn.dataset.label); }));
  }

  _renderConfusionMatrix(json) {
    const el = this._els.confMatrix;
    if (!json.data?.labels) { el.innerHTML = '<div class="empty">Train 2+ labels to see matrix</div>'; return; }
    const { labels: ls, matrix: mx } = json.data;
    const mv = Math.max(...mx.flat(), 1);
    let h = '<div class="cm-wrap"><table class="cm"><thead><tr><th class="corner">True \\ Pred</th>';
    h += ls.map(l => `<th><span>${this._esc(l)}</span></th>`).join('') + '</tr></thead><tbody>';
    for (let i = 0; i < ls.length; i++) {
      h += `<tr><th>${this._esc(ls[i])}</th>`;
      for (let j = 0; j < ls.length; j++) {
        const v = mx[i][j];
        if (v === 0) {
          h += `<td><span class="m-val zero">0</span></td>`;
        } else {
          const intensity = Math.max(0.15, v / mv);
          const isCorrect = i === j;
          const bg = isCorrect ? `rgba(0,200,255,${intensity})` : `rgba(255,100,100,${intensity})`;
          h += `<td class="${isCorrect?'m-correct':'m-wrong'}" style="background-color:${bg}">
                  <span class="m-val">${v}</span>
                </td>`;
        }
      }
      h += '</tr>';
    }
    el.innerHTML = h + '</tbody></table></div>';
  }

  _renderSensorMgmt(json) {
    const el = this._els.sensorList;
    if (!json.sensors?.length) { el.innerHTML = '<div class="empty">No sensors yet</div>'; return; }
    const ss = json.sensors.sort((a, b) => b.importance - a.importance);
    el.innerHTML = '<div class="sm-list">' + ss.map(s => {
      const impPct = Math.round(s.importance * 1000) / 10;
      return `<div class="sm-item">
        <div class="sm-head">
          <span class="sm-name" title="${this._esc(s.entity_id)}">${this._esc(s.display_name)}</span>
          <button class="icon-btn del-btn" data-entity="${this._esc(s.entity_id)}" title="Remove Sensor">🗑</button>
        </div>
        <div class="sm-bar"><div class="sm-track"><div class="sm-fill" style="width:${Math.max(1, impPct)}%"></div></div><span class="sm-pct">${impPct}%</span></div>
      </div>`;
    }).join('') + '</div>';
    el.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deleteSensor(btn.dataset.entity); }));
  }

  /* ── Panel Toggle (animated) ──────────────────────────────── */
  _togglePanel(panelId) {
    const panel = this.shadowRoot.getElementById(panelId);
    const chev = this.shadowRoot.getElementById(panelId + 'Chev');
    const isOpen = panel.style.maxHeight && panel.style.maxHeight !== '0px';
    if (isOpen) {
      panel.style.maxHeight = '0px';
      chev.classList.remove('open');
    } else {
      panel.style.maxHeight = '3000px';
      chev.classList.add('open');
      if (panelId === 'dataPanel') this._loadDataHealth();
      if (panelId === 'confPanel') this._loadConfusionMatrix();
      if (panelId === 'sensorPanel') this._loadSensors();
    }
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  _showToast(msg, type = 'info') {
    const t = this._els.toast;
    t.textContent = msg; t.className = `toast show ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.className = 'toast', 2500);
  }

  /* ── Render ───────────────────────────────────────────────── */
  _render() {
    this.shadowRoot.innerHTML = `<style>${ML2MQTTTrainingCard._styles()}</style>
<ha-card>
<div class="c">
  <!-- Model Switcher -->
  <div class="model-bar" id="modelSwitcher"></div>

  <!-- Status -->
  <div class="status-row"><div class="status-dot connecting" id="statusDot" title="Connecting…"></div></div>

  <!-- Prediction -->
  <div class="pred-section">
    <div class="pred-ring" id="ring" style="--conf-deg:0deg">
      <div class="pred-inner">
        <div class="pred-label" id="predLabel">—</div>
        <div class="pred-conf" id="predConf">…</div>
      </div>
    </div>
    <div class="smoothed" id="smoothedBadge" style="display:none">⊕ Smoothed: <span id="smoothedLabel">—</span></div>
  </div>

  <!-- Pills -->
  <div class="pills" id="labelPills"></div>

  <!-- Collect -->
  <div class="collect-section">
    <button class="collect-btn" id="collectBtn"><span class="ci" id="collectIcon">●</span><span id="collectText">START COLLECTING</span></button>
    <div class="mode-row">
      <div class="mode-pills"><button class="mp active" id="modeEager">Eager</button><button class="mp" id="modeLazy">Lazy</button></div>
      <span class="mode-hint" id="modeHint">Saves every reading</span>
    </div>
  </div>

  <!-- Sensors -->
  <div class="card-section">
    <div class="sec-head"><span class="sec-title">Live Sensors</span><span class="sec-meta" id="lastUpdate">—</span></div>
    <div class="s-table" id="sensorTable"><div class="s-row empty"><span>Waiting for data…</span></div></div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat"><span class="stat-v" id="obsCount">0</span><span class="stat-l">Observations</span></div>
    <div class="stat"><span class="stat-v" id="accuracy">—</span><span class="stat-l">Accuracy</span></div>
    <div class="stat-bd" id="labelBreakdown"></div>
  </div>

  <!-- Panels -->
  <div class="panel"><button class="panel-hd" id="dataPanelToggle"><span>📊 Data Manager</span><span class="chev" id="dataPanelChev">▾</span></button><div class="panel-bd" id="dataPanel" style="max-height:0px"><div class="panel-inner"><div id="dataWarnings"></div><div id="labelBars"></div><div class="panel-acts"><button class="act retrain" id="retrainBtn">🔄 Retrain Model</button></div></div></div></div>
  <div class="panel"><button class="panel-hd" id="confPanelToggle"><span>🔀 Confusion Matrix</span><span class="chev" id="confPanelChev">▾</span></button><div class="panel-bd" id="confPanel" style="max-height:0px"><div class="panel-inner"><div id="confMatrix" class="cm-wrap"><div class="empty">Train 2+ labels to see matrix</div></div></div></div></div>
  <div class="panel"><button class="panel-hd" id="sensorPanelToggle"><span>📡 Sensor Management</span><span class="chev" id="sensorPanelChev">▾</span></button><div class="panel-bd" id="sensorPanel" style="max-height:0px"><div class="panel-inner"><div id="sensorList" class="sm-list"><div class="empty">Loading…</div></div></div></div></div>

  <!-- Add Room -->
  <div class="add-row"><input type="text" class="add-input" id="newLabelInput" placeholder="New room name…" maxlength="32"/><button class="add-btn" id="addLabelBtn">+ Add</button></div>
</div>
<div class="toast" id="toast"></div>
</ha-card>`;
    this._cacheElements();
    this._attachEvents();
  }

  _cacheElements() {
    const $ = id => this.shadowRoot.getElementById(id);
    this._els = {
      modelSwitcher: $('modelSwitcher'), statusDot: $('statusDot'),
      ring: $('ring'), predLabel: $('predLabel'), predConf: $('predConf'),
      smoothedBadge: $('smoothedBadge'), smoothedLabel: $('smoothedLabel'),
      labelPills: $('labelPills'),
      collectBtn: $('collectBtn'), collectIcon: $('collectIcon'), collectText: $('collectText'),
      modeEager: $('modeEager'), modeLazy: $('modeLazy'), modeHint: $('modeHint'),
      sensorTable: $('sensorTable'), lastUpdate: $('lastUpdate'),
      obsCount: $('obsCount'), accuracy: $('accuracy'), labelBreakdown: $('labelBreakdown'),
      dataWarnings: $('dataWarnings'), labelBars: $('labelBars'),
      confMatrix: $('confMatrix'), sensorList: $('sensorList'),
      newLabelInput: $('newLabelInput'), toast: $('toast'),
    };
  }

  _attachEvents() {
    const $ = id => this.shadowRoot.getElementById(id);
    $('collectBtn').addEventListener('click', () => this._toggleCollection());
    $('modeEager').addEventListener('click', () => this._setLearningType('EAGER'));
    $('modeLazy').addEventListener('click', () => this._setLearningType('LAZY'));
    $('dataPanelToggle').addEventListener('click', () => this._togglePanel('dataPanel'));
    $('confPanelToggle').addEventListener('click', () => this._togglePanel('confPanel'));
    $('sensorPanelToggle').addEventListener('click', () => this._togglePanel('sensorPanel'));
    $('retrainBtn').addEventListener('click', () => this._retrainModel());
    $('addLabelBtn').addEventListener('click', () => this._addLabel(this._els.newLabelInput.value));
    $('newLabelInput').addEventListener('keydown', e => { if (e.key === 'Enter') this._addLabel(this._els.newLabelInput.value); });
  }

  /* ── Styles ───────────────────────────────────────────────── */
  static _styles() { return `
:host{--c:var(--info-color,#03a9f4);--g:var(--success-color,#4caf50);--y:var(--warning-color,#ffeb3b);--r:var(--error-color,#f44336);--o:var(--warning-color, #ff9800);--bg:var(--ha-card-background,var(--card-background-color,#fff));--bgd:var(--primary-background-color,#fafafa);--bgp:var(--secondary-background-color,rgba(127,127,127,0.1));--bdr:var(--divider-color,rgba(127,127,127,0.2));--tx:var(--primary-text-color,#212121);--txd:var(--secondary-text-color,#727272);--txm:var(--disabled-text-color,#9e9e9e);--rad:var(--ha-card-border-radius,12px);font-family:var(--paper-font-body1_-_font-family,'Roboto','Noto',sans-serif)}
ha-card{background:transparent!important;box-shadow:none!important;border:none!important}
.c{display:flex;flex-direction:column;gap:16px;padding:0 4px 16px}

/* Inputs / Forms */
.icon-btn{background:none;border:none;color:var(--txd);padding:8px;border-radius:50%;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}
.icon-btn:hover{background:rgba(255,255,255,.05);transform:scale(1.05)}
.icon-btn:active{transform:scale(0.95)}
.del-btn{color:var(--r);font-size:1.1rem;opacity:0.6;padding:5px}
.del-btn:hover{opacity:1;background:rgba(255,82,82,.1)}

/* Model Switcher */
.model-bar{display:flex;gap:8px;justify-content:center;padding:8px 0;flex-wrap:wrap}
.model-btn{padding:8px 20px;border-radius:24px;border:1.5px solid var(--bdr);background:transparent;color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .25s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.model-btn:hover{background:var(--bgp)}
.model-btn.active{border-color:var(--o);color:var(--o);background:rgba(255,152,0,.1)}

/* Status */
.status-row{display:flex;justify-content:center}
.status-dot{width:10px;height:10px;border-radius:50%;transition:all .3s}
.status-dot.connecting{background:var(--y);box-shadow:0 0 8px var(--y);animation:pulse 1.5s infinite}
.status-dot.connected{background:var(--g);box-shadow:0 0 8px var(--g)}
.status-dot.error{background:var(--r);box-shadow:0 0 8px var(--r)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* Prediction Ring */
.pred-section{display:flex;flex-direction:column;align-items:center;padding:12px 0 0;gap:12px}
.pred-ring{width:160px;height:160px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bgp);position:relative;transition:all .6s}
.pred-ring::before{content:'';position:absolute;inset:0;border-radius:50%;background:conic-gradient(var(--arc-color, rgba(127,127,127,.2)) var(--conf-deg),transparent 0deg);filter:drop-shadow(0 0 6px var(--arc-color))}
.pred-inner{position:relative;z-index:1;text-align:center;width:144px;height:144px;border-radius:50%;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.pred-ring.high{--arc-color: var(--c)}
.pred-ring.med{--arc-color: var(--y)}
.pred-ring.low{--arc-color: var(--r)}
.pred-label{font-size:1.6rem;font-weight:700;color:var(--tx);line-height:1.2}
.pred-conf{font-size:.9rem;color:var(--txd);margin-top:4px;font-weight:600}
.smoothed{font-size:.75rem;color:var(--txm);background:rgba(0,200,255,.05);border:1px solid var(--bdr);padding:4px 12px;border-radius:12px}

/* Pills */
.pills{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:4px 8px}
.pill{padding:10px 18px;border-radius:24px;border:1.5px solid var(--bdr);background:var(--bgp);color:var(--txd);font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;user-select:none;font-family:inherit}
.pill:hover{background:rgba(127,127,127,.1)}
.pill:active{transform:scale(.95)}
.pill.predicted{border-color:var(--c);color:var(--c);background:transparent}
.pill.selected{border-color:var(--g);color:#fff;background:var(--g);box-shadow:0 4px 12px rgba(76,175,80,.3)}
.pill.collecting{animation:pbdr 1.5s ease-in-out infinite}
@keyframes pbdr{0%,100%{box-shadow:0 0 0 0 rgba(76,175,80,.4)}50%{box-shadow:0 0 0 6px rgba(76,175,80,0)}}

/* Collection */
.collect-section{display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0}
.collect-btn{width:100%;max-width:360px;min-height:54px;border-radius:var(--rad);border:2px solid var(--bdr);background:var(--bg);color:var(--txd);font-size:1.05rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px;transition:all .3s;-webkit-tap-highlight-color:transparent;font-family:inherit}
.collect-btn:active{transform:scale(.97)}
.collect-btn.active{background:linear-gradient(135deg,#1b5e20,#2e7d32);border-color:var(--g);color:#fff;box-shadow:0 6px 20px rgba(76,175,80,.3)}
.ci{font-size:1.4rem;transition:color .3s}
.collect-btn.active .ci{color:var(--r);animation:blink 1s ease-in-out infinite}

/* Learning Mode toggle */
.mode-row{display:flex;align-items:center;gap:12px}
.mode-pills{display:flex;border-radius:10px;overflow:hidden;border:1px solid var(--bdr);background:var(--bgp)}
.mp{padding:8px 20px;border:none;background:transparent;color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.mp.active{background:var(--c);color:#fff}
.mode-hint{font-size:.75rem;color:var(--txd)}

/* Main Cards / Panels */
.card-section, .panel{background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rad);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.15)}
.sec-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--bdr);background:rgba(0,0,0,0.1)}
.sec-title{font-size:.85rem;font-weight:700;color:var(--txd);text-transform:uppercase;letter-spacing:.08em}
.sec-meta{font-size:.7rem;color:var(--txm)}

/* Common empty state */
.empty{color:var(--txm);font-style:italic;text-align:center;padding:24px;font-size:.9rem}

/* Live Sensors List */
.s-row{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;border-bottom:1px solid var(--bdr);transition:background .2s}
.s-row:last-child{border-bottom:none}
.s-row:hover{background:var(--bgp)}
.s-info{display:flex;align-items:center;gap:12px}
.s-icon{font-size:1.1rem;opacity:0.8}
.s-name{font-size:.9rem;color:var(--tx);font-weight:500}
.s-val{font-size:.8rem;font-weight:700;padding:4px 10px;border-radius:20px;font-variant-numeric:tabular-nums}
.s-val.normal{background:rgba(255,255,255,0.06);color:var(--tx)}
.s-val.unknown{background:rgba(240,192,64,0.15);color:var(--y)}
.s-val.unavailable{background:rgba(255,82,82,0.15);color:var(--r)}
.s-val.null{background:transparent;color:#4a5a6a}

/* Stats Overview */
.stats{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;padding:18px 12px;background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rad);box-shadow:0 4px 12px rgba(0,0,0,0.15)}
.stat{display:flex;flex-direction:column;align-items:center;min-width:90px}
.stat-v{font-size:1.6rem;font-weight:800;color:var(--tx)}
.stat-l{font-size:.7rem;color:var(--txm);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat-bd{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;width:100%;margin-top:8px}
.lbl-cnt{font-size:.75rem;color:var(--txm);background:var(--bgp);padding:4px 10px;border-radius:8px}
.lbl-cnt b{color:var(--tx);font-weight:600}

/* Expandable Panels */
.panel-hd{width:100%;display:flex;justify-content:space-between;align-items:center;padding:16px 18px;background:rgba(0,0,0,0.1);border:none;color:var(--txd);font-size:.95rem;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;font-family:inherit}
.panel-hd:hover{background:rgba(255,255,255,.04)}
.chev{font-size:.9rem;transition:transform .3s;display:inline-block}
.chev.open{transform:rotate(180deg)}
.panel-bd{overflow:hidden;transition:max-height .35s ease-in-out;max-height:0}
.panel-inner{padding:16px}
.panel-acts{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.act{padding:10px 20px;border-radius:10px;border:1px solid var(--bdr);background:var(--bgp);color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.act:active{transform:scale(.96)}
.act.retrain{background:transparent;border-color:var(--c);color:var(--c)}
.act.retrain:hover{background:var(--c);color:#fff}

/* Data Health (Manager) */
.warn-box{display:flex;align-items:center;gap:10px;padding:12px;margin-bottom:14px;border-radius:10px;font-size:.85rem;background:rgba(240,192,64,.1);border:1px solid rgba(240,192,64,.3);color:var(--y);font-weight:500}
.dh-list{display:flex;flex-direction:column;gap:14px}
.dh-item{display:flex;flex-direction:column;gap:6px}
.dh-head{display:flex;justify-content:space-between;align-items:center}
.dh-name{font-size:.9rem;color:var(--tx);font-weight:600}
.dh-stats{display:flex;align-items:center;gap:12px;font-size:.8rem}
.dh-num{color:var(--txd)}
.dh-pct{color:var(--c);font-weight:700;width:40px;text-align:right}
.lb-track{height:10px;background:var(--bgd);border-radius:6px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,0.2)}
.lb-fill{height:100%;border-radius:6px;transition:width .6s ease;background:linear-gradient(90deg,var(--c),#0088cc)}
.lb-fill.low{background:linear-gradient(90deg,var(--y),#cc9900)}
.lb-fill.good{background:linear-gradient(90deg,var(--g),#388e3c)}

/* Confusion Matrix */
.cm-wrap{overflow-x:auto;position:relative;padding-bottom:10px}
.cm{width:100%;border-collapse:collapse;font-size:.85rem;min-width:300px}
.cm th{position:sticky;background:var(--bgd);z-index:1}
.cm thead th{top:0;padding:10px 8px;color:var(--txd);font-weight:600;border-bottom:2px solid var(--bdr)}
.cm tbody th{left:0;padding:8px 12px;color:var(--txd);font-weight:600;text-align:right;border-right:2px solid var(--bdr)}
.cm td{padding:10px;text-align:center;border:1px solid var(--bdr);transition:background .2s}
.m-val{font-weight:600;font-variant-numeric:tabular-nums}
.m-val.zero{color:var(--txm);opacity:0.5}
.m-correct{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.5)}
.m-wrong{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.5)}
.corner{text-transform:uppercase;font-size:.7rem;letter-spacing:.05em;color:var(--txm)}

/* Sensor Management */
.sm-list{display:flex;flex-direction:column;gap:12px}
.sm-item{background:var(--bgp);border-radius:10px;padding:10px 14px;border:1px solid transparent;transition:border .2s}
.sm-item:hover{border-color:var(--bdr)}
.sm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.sm-name{font-size:.85rem;color:var(--tx);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:85%}
.sm-bar{display:flex;align-items:center;gap:12px}
.sm-track{flex:1;height:6px;background:var(--bgd);border-radius:4px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,0.1)}
.sm-fill{height:100%;background:linear-gradient(90deg,rgba(0,200,255,0.4),var(--c));border-radius:4px}
.sm-pct{font-size:.75rem;color:var(--c);font-weight:700;width:35px;text-align:right;font-variant-numeric:tabular-nums}

/* Add Room */
.add-row{display:flex;gap:10px;padding:4px}
.add-input{flex:1;padding:12px 18px;border-radius:12px;border:1px solid var(--bdr);background:var(--bg);color:var(--tx);font-size:.95rem;outline:none;font-family:inherit;transition:all .2s;box-shadow:inset 0 2px 4px rgba(0,0,0,0.1)}
.add-input:focus{border-color:var(--o);box-shadow:0 0 0 2px rgba(255,152,0,0.2)}
.add-input::placeholder{color:var(--txm)}
.add-btn{padding:12px 24px;border-radius:12px;border:2px solid var(--o);background:rgba(255,152,0,0.05);color:var(--o);font-size:.95rem;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap;font-family:inherit}
.add-btn:hover{background:rgba(255,152,0,.15)}
.add-btn:active{transform:scale(.96)}

/* Toast */
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--bg);color:var(--tx);padding:12px 28px;border-radius:30px;font-size:.9rem;font-weight:600;opacity:0;transition:all .3s cubic-bezier(0.18, 0.89, 0.32, 1.28);z-index:1000;pointer-events:none;border:1px solid var(--bdr);box-shadow:0 8px 32px rgba(0,0,0,.4)}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.toast.error{border-color:var(--r);color:var(--r)}
.toast.success{border-color:var(--g);color:var(--g)}
.toast.warn{border-color:var(--y);color:var(--y)}

@media(max-width:480px){
  .c{gap:12px;padding:0 0 12px}
  .pred-ring{width:140px;height:140px}
  .pred-inner{width:120px;height:120px}
  .pred-label{font-size:1.3rem}
  .pill{padding:8px 14px;font-size:.85rem}
  .collect-btn{padding:16px 20px;font-size:1rem}
  .sec-head{padding:12px 14px}
  .s-row{padding:10px 14px}
  .panel-hd{padding:14px}
  .cm{font-size:.75rem}
}
`;}
}
customElements.define('ml2mqtt-training-card', ML2MQTTTrainingCard);
