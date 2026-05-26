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

/* ── Icon map (top-level constant per ULM skill anti-pattern rules) ── */
const ML_ICONS = {
  sensor: 'lucide:radio',
  motion: 'lucide:activity',
  media: 'lucide:monitor',
  temperature: 'lucide:thermometer',
  presence: 'lucide:crosshair',
  warning: 'lucide:alert-triangle',
  data: 'lucide:bar-chart-3',
  matrix: 'lucide:grid-3x3',
  sensors: 'lucide:radio',
  delete: 'lucide:trash-2',
  wipe: 'lucide:eraser',
  retrain: 'lucide:refresh-cw',
  collect: 'lucide:circle-dot',
  collectStop: 'lucide:square',
  chevron: 'lucide:chevron-down',
  smoothed: 'lucide:git-merge',
};

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
      url: config.url || null,
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
    if (!this._config.url) {
      try { await this._initIngress(); } catch (e) {
        console.error('ml2mqtt: ingress init failed, retrying in 5s…', e);
        setTimeout(() => this._initCard(), 5000);
        return;
      }
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
    // Route requests through the Home Assistant proxy view to support secure remote access
    // Path format: /api/ml_presence/proxy/<model_name>/<original_path_without_api_prefix>
    const apiPath = path.replace(/^\/api\//, '');
    const proxyPath = `ml_presence/proxy/${this._activeModel}/${apiPath}`;
    try {
      return await this._hass.callApi(method, proxyPath, body || undefined);
    } catch (err) {
      console.error(`ml2mqtt API call failed: ${method} ${proxyPath}`, err);
      throw err;
    }
  }

  /* ── Data Methods ─────────────────────────────────────────── */
  get _mp() { return `/api/model/${this._activeModel}`; }

  async _pollLiveData() {
    if (this._polling || !this._hass || !this._activeModel) return;
    this._polling = true;
    try {
      const d = await this._apiCall('GET', `${this._mp}/live`);
      this._lastLiveData = d;
      this._errorCount = 0;
      this._updatePrediction(d);
      this._updatePills(d);
      this._updateSensors(d.sensors);
      this._updateStats(d);
      this._syncServerState(d);
      this._updateModeUI(d.learning_type);
      if (d.model_error && !d.model_trained) {
        this._setStatus('warning');
      } else {
        this._setStatus('connected');
      }
      this._updateWarningBanner(d);
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
  async _setLearningType(type) {
    this._showToast(`Setting mode: ${type.toLowerCase()}…`);
    try {
      const d = await this._apiCall('POST', `${this._mp}/learning-type`, { learning_type: type });
      if (d.success) {
        this._showToast(`Mode updated to ${type.toLowerCase()}`, 'success');
        await this._pollLiveData();
      }
    } catch (e) {
      this._showToast('Error updating learning mode', 'error');
    }
  }
  async _undoSession() {
    const label = this._lastLiveData?.last_session_label || 'session';
    if (!confirm(`Are you sure you want to delete all training observations recorded during the session for "${label}"? This action cannot be undone.`)) return;
    this._showToast('Undoing collection session…');
    try {
      const d = await this._apiCall('POST', `${this._mp}/session/undo`);
      if (d.success) {
        this._showToast(`Successfully deleted ${d.deleted_count} observations`, 'success');
        await this._pollLiveData();
        // Also reload data health if Data Manager is expanded
        const dataPanel = this.shadowRoot.getElementById('dataPanel');
        if (dataPanel && dataPanel.style.maxHeight && dataPanel.style.maxHeight !== '0px') {
          await this._loadDataHealth();
        }
      } else {
        this._showToast(d.error || 'Failed to undo session', 'error');
      }
    } catch (e) {
      this._showToast('Error undoing session', 'error');
      console.error(e);
    }
  }
  async _generateSynthetic() {
    if (!this._selectedLabel) { this._showToast('Select a room first', 'warn'); return; }
    if (!confirm(`Generate 50 synthetic observations for "${this._selectedLabel}"? This is recommended for labels like "Away".`)) return;
    this._showToast(`Generating synthetic data for ${this._selectedLabel}…`);
    try {
      const d = await this._apiCall('POST', `${this._mp}/generate-synthetic`, { label: this._selectedLabel, count: 50 });
      if (d.success) {
        this._showToast(`Generated 50 observations!`, 'success');
        await this._pollLiveData();
        const dataPanel = this.shadowRoot.getElementById('dataPanel');
        if (dataPanel && dataPanel.style.maxHeight && dataPanel.style.maxHeight !== '0px') {
          await this._loadDataHealth();
        }
      }
    } catch (e) {
      this._showToast('Error generating synthetic data', 'error');
      console.error(e);
    }
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
  async _wipeLabel(label) {
    if (!confirm(`Wipe all training observations for "${label}"? (The room will remain configured)`)) return;
    this._showToast(`Wiping data for ${label}…`);
    try {
      const d = await this._apiCall('POST', `${this._mp}/label/${encodeURIComponent(label)}/data`, { _method: 'DELETE', keep_config: true });
      if (d.success) {
        this._showToast(`Wiped data for ${label}`, 'success');
        await this._pollLiveData();
        await this._loadDataHealth();
      }
    } catch (e) { this._showToast('Error wiping label data', 'error'); }
  }
  async _deleteLabel(label) {
    if (!confirm(`Delete room "${label}"? This will delete all training observations AND remove the room from config.`)) return;
    this._showToast(`Deleting room ${label}…`);
    try {
      const d = await this._apiCall('POST', `${this._mp}/label/${encodeURIComponent(label)}/data`, { _method: 'DELETE', keep_config: false });
      if (d.success) {
        this._showToast(`Deleted room ${label}`, 'success');
        await this._pollLiveData();
        await this._loadDataHealth();
      }
    } catch (e) { this._showToast('Error deleting room', 'error'); }
  }
  async _addSensor(entityId, sensorType) {
    if (!entityId) { this._showToast('Select an entity first', 'warn'); return; }
    if (!this._hass.states[entityId]) { this._showToast('Invalid entity ID', 'error'); return; }
    this._showToast('Adding sensor…');
    try {
      await this._hass.callService('ml_presence', 'add_sensor', {
        model_name: this._activeModel,
        entity_id: entityId,
        sensor_type: sensorType
      });
      this._showToast(`Added ${entityId}`, 'success');
      setTimeout(() => this._loadSensors(), 1500);
    } catch (e) {
      this._showToast('Failed to add sensor', 'error');
      console.error(e);
    }
  }
  async _deleteSensor(entityId) {
    if (!confirm(`Remove sensor "${entityId}"?`)) return;
    this._showToast('Removing sensor…');
    try {
      await this._hass.callService('ml_presence', 'remove_sensor', {
        model_name: this._activeModel,
        entity_id: entityId
      });
      this._showToast('Removed sensor', 'success');
      setTimeout(() => this._loadSensors(), 1500);
    } catch (e) { this._showToast('Error removing sensor', 'error'); }
  }
  async _addLabel(label) {
    if (!label.trim()) return;
    try {
      const d = await this._apiCall('POST', `${this._mp}/label/add`, { label: label.trim() });
      if (d.success) {
        this._showToast(`Added: ${label.trim()}`);
        this._els.newLabelInput.value = '';
        await this._pollLiveData();
        const dataPanel = this.shadowRoot.getElementById('dataPanel');
        if (dataPanel && dataPanel.style.maxHeight && dataPanel.style.maxHeight !== '0px') {
          await this._loadDataHealth();
        }
      }
    } catch (e) { this._showToast('Error adding room', 'error'); }
  }

  /* ── UI Updates ───────────────────────────────────────────── */
  _setStatus(s) {
    const dot = this._els.statusDot;
    if (!dot) return;
    dot.className = `status-dot ${s}`;
    const errorMsg = (this._lastLiveData && this._lastLiveData.model_error) || '';
    dot.title = s === 'connected' ? 'Connected' : s === 'warning' ? `Model Warning: ${errorMsg}` : s === 'error' ? 'Connection error' : 'Connecting…';
  }

  _updateModeUI(type) {
    const eager = this._els.modeEagerBtn;
    const lazy = this._els.modeLazyBtn;
    const hint = this._els.modeHint;
    if (!eager || !lazy || !hint) return;
    
    eager.classList.toggle('active', type === 'EAGER');
    lazy.classList.toggle('active', type === 'LAZY' || type === 'AUTO');
    hint.textContent = type === 'EAGER'
      ? 'Eager: saves every reading'
      : 'Lazy: saves only wrong predictions';
  }

  _updateWarningBanner(d) {
    const banner = this._els.warningBanner;
    const text = this._els.warningBannerText;
    if (banner && text) {
      if (d.model_error) {
        banner.style.display = 'flex';
        let msg = d.model_error;
        if (msg.includes('Single-class dataset') || msg.includes('at least 2 distinct rooms')) {
          msg = "Model updates paused. Collect observations for at least 2 distinct rooms to enable predictions.";
        }
        text.textContent = msg;
      } else {
        banner.style.display = 'none';
      }
    }
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
      let iconName = ML_ICONS.sensor;
      const n = s.display_name.toLowerCase();
      if (n.includes('motion') || n.includes('pir')) iconName = ML_ICONS.motion;
      else if (n.includes('media') || n.includes('tv') || n.includes('speaker')) iconName = ML_ICONS.media;
      else if (n.includes('temp')) iconName = ML_ICONS.temperature;
      else if (n.includes('presence')) iconName = ML_ICONS.presence;
      return `<div class="s-row">
        <div class="s-info"><ha-icon icon="${iconName}" class="s-icon"></ha-icon><span class="s-name">${this._esc(s.display_name)}</span></div>
        <span class="s-val ${s.status}">${this._esc(String(v))}</span>
      </div>`;
    }).join('');
    this._els.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  _updateStats(d) {
    this._els.obsCount.textContent = d.observation_count || 0;
    const acc = d.accuracy;
    this._els.accuracy.textContent = acc != null ? `${Math.round(acc * 100)}%` : '—';
    const counts = d.total_label_counts || d.label_stats;
    if (counts) {
      this._els.labelBreakdown.innerHTML = Object.entries(counts)
        .map(([l, c]) => `<span class="lbl-cnt"><b>${this._esc(l)}</b> ${c}</span>`).join('');
    }
  }

  _updateCollectionUI() {
    const { collectBtn, collectText, collectIcon } = this._els;
    if (this._isCollecting) {
      collectBtn.classList.add('active');
      collectText.textContent = `COLLECTING: ${this._selectedLabel}`;
      collectIcon.innerHTML = `<ha-icon icon="${ML_ICONS.collectStop}"></ha-icon>`;
    } else {
      collectBtn.classList.remove('active');
      collectText.textContent = 'START COLLECTING';
      collectIcon.innerHTML = `<ha-icon icon="${ML_ICONS.collect}"></ha-icon>`;
    }

    const modeStatusEl = this.shadowRoot.getElementById('trainingModeStatus');
    if (modeStatusEl && this._selectedLabel) {
      const d = this._lastLiveData;
      const counts = d ? (d.total_label_counts || d.label_stats) : null;
      const support = (counts && counts[this._selectedLabel]) || 0;
      if (this._isCollecting) {
        if (support < 200) {
          modeStatusEl.textContent = `Eager Bootstrapping: Saving all data (${support}/200)`;
          modeStatusEl.className = 'mode-status eager';
        } else {
          modeStatusEl.textContent = `Active Learning: Saving error cases (${support} obs)`;
          modeStatusEl.className = 'mode-status active-learning';
        }
      } else {
        modeStatusEl.textContent = `Selected room: ${this._selectedLabel} (${support} obs)`;
        modeStatusEl.className = 'mode-status idle';
      }
    }
  }

  _syncServerState(d) {
    this._isCollecting = !!d.collecting;
    if (d.collecting && d.collecting_label) this._selectedLabel = d.collecting_label;
    this._updateCollectionUI();
    if (d.learning_type) this._updateModeUI(d.learning_type);

    // Show/hide undo button dynamically
    const undoBtn = this._els.undoSessionBtn;
    const undoText = this._els.undoSessionText;
    if (undoBtn && undoText) {
      if (d.has_undo) {
        undoBtn.style.display = 'inline-flex';
        undoText.textContent = `Undo Session (${d.last_session_label})`;
      } else {
        undoBtn.style.display = 'none';
      }
    }
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
    w.innerHTML = (data.warnings?.length) ? data.warnings.map(wr => `<div class="warn-box"><ha-icon icon="${ML_ICONS.warning}" class="warn-icon"></ha-icon>${this._esc(wr.msg)}</div>`).join('') : '';
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
          <button class="icon-btn wipe-btn-row" data-label="${this._esc(l)}" title="Wipe observations (keep room)"><ha-icon icon="${ML_ICONS.wipe}"></ha-icon></button>
          <button class="icon-btn del-btn-row" data-label="${this._esc(l)}" title="Delete room & observations"><ha-icon icon="${ML_ICONS.delete}"></ha-icon></button></div>
        </div>
        <div class="lb-track"><div class="lb-fill ${c < mx * 0.4 ? 'low' : 'good'}" style="width:${pct}%"></div></div>
      </div>`;
    }).join('') + '</div>';
    b.querySelectorAll('.wipe-btn-row').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._wipeLabel(btn.dataset.label); }));
    b.querySelectorAll('.del-btn-row').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deleteLabel(btn.dataset.label); }));
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
          const bg = isCorrect ? `rgba(var(--c-rgb),${intensity})` : `rgba(var(--r-rgb),${intensity})`;
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
    if (!json.sensors) { el.innerHTML = '<div class="empty">No sensors yet</div>'; return; }
    
    const ss = [...json.sensors].sort((a, b) => b.importance - a.importance);
    let html = '<div class="sm-list">' + ss.map(s => {
      const impPct = Math.round(s.importance * 1000) / 10;
      return `<div class="sm-item">
        <div class="sm-head">
          <span class="sm-name" title="${this._esc(s.entity_id)}">${this._esc(s.display_name)} (${this._esc(s.entity_id)})</span>
          <button class="icon-btn del-btn" data-entity="${this._esc(s.entity_id)}" title="Remove Sensor"><ha-icon icon="${ML_ICONS.delete}"></ha-icon></button>
        </div>
        <div class="sm-bar"><div class="sm-track"><div class="sm-fill" style="width:${Math.max(1, impPct)}%"></div></div><span class="sm-pct">${impPct}%</span></div>
      </div>`;
    }).join('') + '</div>';

    // Autocomplete dropdown setup
    const existing = new Set(json.sensors.map(s => s.entity_id));
    const prefixes = ['sensor.', 'binary_sensor.', 'device_tracker.', 'media_player.', 'switch.', 'light.', 'input_boolean.'];
    const allEntitiesOptions = Object.keys(this._hass.states)
      .filter(id => prefixes.some(p => id.startsWith(p)) && !existing.has(id))
      .sort()
      .map(id => {
        const friendly = this._hass.states[id].attributes.friendly_name || '';
        return `<option value="${id}">${id} (${friendly})</option>`;
      })
      .join('');

    html += `
      <div class="add-sensor-title">Add Sensor to Model</div>
      <div class="add-sensor-row">
        <input list="ha-entities" class="add-sensor-input" id="newSensorInput" placeholder="Search entity ID (e.g. sensor.xyz)..."/>
        <datalist id="ha-entities">
          ${allEntitiesOptions}
        </datalist>
        <select class="add-sensor-type" id="newSensorType">
          <option value="trigger">Trigger</option>
          <option value="context">Context</option>
        </select>
        <button class="add-sensor-btn" id="addSensorBtn">+ Add</button>
      </div>
    `;

    el.innerHTML = html;
    el.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deleteSensor(btn.dataset.entity); }));
    el.querySelector('#addSensorBtn').addEventListener('click', () => {
      const input = el.querySelector('#newSensorInput');
      const typeSelect = el.querySelector('#newSensorType');
      const entityId = input.value.trim();
      const sensorType = typeSelect.value;
      this._addSensor(entityId, sensorType);
    });
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

  <!-- Warning Banner -->
  <div class="warning-banner" id="warningBanner" style="display:none">
    <ha-icon icon="${ML_ICONS.warning}" class="warn-icon-banner"></ha-icon>
    <span id="warningBannerText"></span>
  </div>

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
    <div class="smoothed" id="smoothedBadge" style="display:none"><ha-icon icon="${ML_ICONS.smoothed}" class="smooth-icon"></ha-icon> Smoothed: <span id="smoothedLabel">—</span></div>
  </div>

  <!-- Pills -->
  <div class="pills" id="labelPills"></div>

  <div class="collect-section">
    <button class="collect-btn" id="collectBtn"><span class="ci" id="collectIcon"><ha-icon icon="${ML_ICONS.collect}"></ha-icon></span><span id="collectText">START COLLECTING</span></button>
    <button class="wipe-btn" id="undoSessionBtn" style="display: none;"><span class="ci"><ha-icon icon="${ML_ICONS.delete}"></ha-icon></span><span id="undoSessionText">Undo Session</span></button>
    <div class="mode-row">
      <div class="mode-pills">
        <button class="mp" id="modeEagerBtn">Eager</button>
        <button class="mp" id="modeLazyBtn">Lazy</button>
      </div>
      <div class="mode-hint" id="modeHint">Eager: saves every reading</div>
    </div>
    <div class="mode-status idle" id="trainingModeStatus">Select a room to begin training</div>
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
  <div class="panel"><button class="panel-hd" id="dataPanelToggle"><span class="panel-label"><ha-icon icon="${ML_ICONS.data}" class="panel-icon"></ha-icon> Data Manager</span><span class="chev" id="dataPanelChev"><ha-icon icon="${ML_ICONS.chevron}"></ha-icon></span></button><div class="panel-bd" id="dataPanel" style="max-height:0px"><div class="panel-inner"><div id="dataWarnings"></div><div id="labelBars"></div><div class="panel-acts"><button class="act retrain" id="retrainBtn"><ha-icon icon="${ML_ICONS.retrain}" class="act-icon"></ha-icon> Retrain Model</button></div></div></div></div>
  <div class="panel"><button class="panel-hd" id="confPanelToggle"><span class="panel-label"><ha-icon icon="${ML_ICONS.matrix}" class="panel-icon"></ha-icon> Confusion Matrix</span><span class="chev" id="confPanelChev"><ha-icon icon="${ML_ICONS.chevron}"></ha-icon></span></button><div class="panel-bd" id="confPanel" style="max-height:0px"><div class="panel-inner"><div id="confMatrix" class="cm-wrap"><div class="empty">Train 2+ labels to see matrix</div></div></div></div></div>
  <div class="panel"><button class="panel-hd" id="sensorPanelToggle"><span class="panel-label"><ha-icon icon="${ML_ICONS.sensors}" class="panel-icon"></ha-icon> Sensor Management</span><span class="chev" id="sensorPanelChev"><ha-icon icon="${ML_ICONS.chevron}"></ha-icon></span></button><div class="panel-bd" id="sensorPanel" style="max-height:0px"><div class="panel-inner"><div id="sensorList" class="sm-list"><div class="empty">Loading…</div></div></div></div></div>

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
      warningBanner: $('warningBanner'), warningBannerText: $('warningBannerText'),
      ring: $('ring'), predLabel: $('predLabel'), predConf: $('predConf'),
      smoothedBadge: $('smoothedBadge'), smoothedLabel: $('smoothedLabel'),
      labelPills: $('labelPills'),
      collectBtn: $('collectBtn'), collectIcon: $('collectIcon'), collectText: $('collectText'),
      modeEagerBtn: $('modeEagerBtn'), modeLazyBtn: $('modeLazyBtn'), modeHint: $('modeHint'),
      trainingModeStatus: $('trainingModeStatus'),
      undoSessionBtn: $('undoSessionBtn'), undoSessionText: $('undoSessionText'),
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
    $('modeEagerBtn').addEventListener('click', () => this._setLearningType('EAGER'));
    $('modeLazyBtn').addEventListener('click', () => this._setLearningType('LAZY'));
    $('undoSessionBtn').addEventListener('click', () => this._undoSession());
    $('dataPanelToggle').addEventListener('click', () => this._togglePanel('dataPanel'));
    $('confPanelToggle').addEventListener('click', () => this._togglePanel('confPanel'));
    $('sensorPanelToggle').addEventListener('click', () => this._togglePanel('sensorPanel'));
    $('retrainBtn').addEventListener('click', () => this._retrainModel());
    $('addLabelBtn').addEventListener('click', () => this._addLabel(this._els.newLabelInput.value));
    $('newLabelInput').addEventListener('keydown', e => { if (e.key === 'Enter') this._addLabel(this._els.newLabelInput.value); });
  }

  /* ── Styles ───────────────────────────────────────────────── */
  static _styles() { return `
:host{--c-rgb:var(--color-blue,3,169,244);--g-rgb:var(--color-green,76,175,80);--y-rgb:var(--color-yellow,255,235,59);--r-rgb:var(--color-red,244,67,54);--o-rgb:var(--color-yellow,255,152,0);--c:rgba(var(--c-rgb),1);--g:rgba(var(--g-rgb),1);--y:rgba(var(--y-rgb),1);--r:rgba(var(--r-rgb),1);--o:rgba(var(--o-rgb),1);--bg:var(--card-background-color,#fff);--bgd:var(--primary-background-color,#fafafa);--bgp:rgba(var(--color-theme,127,127,127),0.04);--bdr:rgba(var(--color-theme,127,127,127),0.08);--tx:var(--primary-text-color,#212121);--txd:var(--secondary-text-color,#727272);--txm:rgba(var(--color-theme,127,127,127),0.4);--rad:14px;font-family:var(--paper-font-body1_-_font-family,'Roboto','Noto',sans-serif)}
ha-card{background:transparent!important;box-shadow:none!important;border:none!important}
.c{display:flex;flex-direction:column;gap:16px;padding:0 4px 16px}

/* ha-icon sizing */
ha-icon{--mdc-icon-size:18px}
.s-icon{--mdc-icon-size:18px;color:rgba(var(--c-rgb),0.6);flex-shrink:0}
.panel-icon{--mdc-icon-size:18px;margin-right:6px;vertical-align:middle}
.act-icon{--mdc-icon-size:16px;margin-right:4px;vertical-align:middle}
.warn-icon{--mdc-icon-size:18px;color:var(--y);flex-shrink:0}
.smooth-icon{--mdc-icon-size:14px;vertical-align:middle}

/* Inputs / Forms */
.icon-btn{background:none;border:none;color:var(--txd);padding:8px;border-radius:50%;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}
.icon-btn:hover{background:rgba(var(--color-theme,127,127,127),0.05);transform:scale(1.05)}
.icon-btn:active{transform:scale(0.95)}
.del-btn{color:var(--r);opacity:0.6;padding:5px}
.del-btn ha-icon{--mdc-icon-size:16px}
.del-btn:hover{opacity:1;background:rgba(var(--r-rgb),0.1)}
.wipe-btn-row{color:var(--o);opacity:0.6;padding:5px}
.wipe-btn-row ha-icon{--mdc-icon-size:16px}
.wipe-btn-row:hover{opacity:1;background:rgba(var(--o-rgb),0.1)}
.del-btn-row{color:var(--r);opacity:0.6;padding:5px}
.del-btn-row ha-icon{--mdc-icon-size:16px}
.del-btn-row:hover{opacity:1;background:rgba(var(--r-rgb),0.1)}

/* Model Switcher */
.model-bar{display:flex;gap:8px;justify-content:center;padding:8px 0;flex-wrap:wrap}
.model-btn{padding:8px 20px;border-radius:24px;border:1.5px solid var(--bdr);background:transparent;color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .25s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.model-btn:hover{background:var(--bgp)}
.model-btn.active{border-color:var(--c);background:rgba(var(--c-rgb),0.2);color:var(--c);box-shadow:none}

/* Status */
.status-row{display:flex;justify-content:center}
.status-dot{width:10px;height:10px;border-radius:50%;transition:all .3s}
.status-dot.connecting{background:var(--y);box-shadow:0 0 8px rgba(var(--y-rgb),0.5);animation:pulse 1.5s infinite}
.status-dot.connected{background:var(--g);box-shadow:0 0 8px rgba(var(--g-rgb),0.5)}
.status-dot.warning{background:var(--o);box-shadow:0 0 8px rgba(var(--o-rgb),0.5);animation:pulse 1.5s infinite}
.status-dot.error{background:var(--r);box-shadow:0 0 8px rgba(var(--r-rgb),0.5)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* Warning Banner */
.warning-banner{display:flex;align-items:center;gap:10px;padding:12px;margin:8px 0;border-radius:var(--rad);font-size:.85rem;background:rgba(var(--r-rgb),0.1);border:1px solid rgba(var(--r-rgb),0.3);color:var(--r);font-weight:600;line-height:1.4}
.warn-icon-banner{--mdc-icon-size:20px;color:var(--r);flex-shrink:0}

/* Prediction Ring */
.pred-section{display:flex;flex-direction:column;align-items:center;padding:12px 0 0;gap:12px}
.pred-ring{width:160px;height:160px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bgp);position:relative;transition:all .6s}
.pred-ring::before{content:'';position:absolute;inset:0;border-radius:50%;background:conic-gradient(var(--arc-color,rgba(var(--color-theme,127,127,127),0.2)) var(--conf-deg),transparent 0deg);filter:drop-shadow(0 0 6px var(--arc-color))}
.pred-inner{position:relative;z-index:1;text-align:center;width:144px;height:144px;border-radius:50%;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:var(--box-shadow,none)}
.pred-ring.high{--arc-color:rgba(var(--c-rgb),1)}
.pred-ring.med{--arc-color:rgba(var(--y-rgb),1)}
.pred-ring.low{--arc-color:rgba(var(--r-rgb),1)}
.pred-label{font-size:1.6rem;font-weight:700;color:var(--tx);line-height:1.2}
.pred-conf{font-size:.9rem;color:var(--txd);margin-top:4px;font-weight:600}
.smoothed{font-size:.75rem;color:var(--txm);background:rgba(var(--c-rgb),0.05);border:1px solid var(--bdr);padding:4px 12px;border-radius:12px;display:flex;align-items:center;gap:4px}

/* Pills */
.pills{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:4px 8px}
.pill{padding:10px 18px;border-radius:24px;border:1.5px solid var(--bdr);background:var(--bgp);color:var(--txd);font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;-webkit-tap-highlight-color:transparent;user-select:none;font-family:inherit}
.pill:hover{background:rgba(var(--color-theme,127,127,127),0.08)}
.pill:active{transform:scale(.95)}
.pill.predicted{border-color:var(--c);color:var(--c);background:transparent}
.pill.selected{border-color:var(--g);color:var(--g);background:rgba(var(--g-rgb),0.2);box-shadow:none}
.pill.collecting{animation:pbdr 1.5s ease-in-out infinite}
@keyframes pbdr{0%,100%{box-shadow:0 0 0 0 rgba(var(--g-rgb),0.4)}50%{box-shadow:0 0 0 6px rgba(var(--g-rgb),0)}}

/* Collection */
.collect-section{display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0}
.collect-btn{width:100%;max-width:360px;min-height:54px;border-radius:var(--rad);border:2px solid var(--bdr);background:var(--bg);color:var(--txd);font-size:1.05rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px;transition:all .3s;-webkit-tap-highlight-color:transparent;font-family:inherit}
.collect-btn:active{transform:scale(.97)}
.collect-btn.active{background:rgba(var(--g-rgb),0.2);border-color:var(--g);color:var(--g);box-shadow:none}
.wipe-btn{width:100%;max-width:360px;min-height:44px;border-radius:var(--rad);border:1.5px solid rgba(var(--r-rgb),0.3);background:rgba(var(--r-rgb),0.03);color:var(--r);font-size:.9rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .3s;-webkit-tap-highlight-color:transparent;font-family:inherit}
.wipe-btn:hover{background:rgba(var(--r-rgb),0.1)}
.wipe-btn:active{transform:scale(.97)}
.ci{display:inline-flex;align-items:center;transition:color .3s}
.ci ha-icon{--mdc-icon-size:20px}
.collect-btn.active .ci{color:var(--r)}

/* Learning Mode toggle */
.mode-row{display:flex;align-items:center;gap:12px}
.mode-pills{display:flex;border-radius:10px;overflow:hidden;border:1px solid var(--bdr);background:var(--bgp)}
.mp{padding:8px 20px;border:none;background:transparent;color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.mp.active{background:rgba(var(--c-rgb),0.2);color:var(--c)}
.mode-hint{font-size:.75rem;color:var(--txd)}

/* Main Cards / Panels */
.card-section,.panel{background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rad);overflow:hidden;box-shadow:var(--box-shadow,none)}
.sec-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--bdr);background:var(--bgp)}
.sec-title{font-size:.85rem;font-weight:700;color:var(--txd);text-transform:uppercase;letter-spacing:.08em}
.sec-meta{font-size:.7rem;color:var(--txm)}

/* Common empty state */
.empty{color:var(--txm);font-style:italic;text-align:center;padding:24px;font-size:.9rem}

/* Live Sensors List */
.s-row{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;border-bottom:1px solid var(--bdr);transition:background .2s}
.s-row:last-child{border-bottom:none}
.s-row:hover{background:var(--bgp)}
.s-info{display:flex;align-items:center;gap:12px}
.s-name{font-size:.9rem;color:var(--tx);font-weight:500}
.s-val{font-size:.8rem;font-weight:700;padding:4px 10px;border-radius:20px;font-variant-numeric:tabular-nums}
.s-val.normal{background:rgba(var(--color-theme,127,127,127),0.06);color:var(--tx)}
.s-val.unknown{background:rgba(var(--y-rgb),0.15);color:var(--y)}
.s-val.unavailable{background:rgba(var(--r-rgb),0.15);color:var(--r)}
.s-val.null{background:transparent;color:var(--txm)}

/* Stats Overview */
.stats{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;padding:18px 12px;background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rad);box-shadow:var(--box-shadow,none)}
.stat{display:flex;flex-direction:column;align-items:center;min-width:90px}
.stat-v{font-size:1.6rem;font-weight:800;color:var(--tx)}
.stat-l{font-size:.7rem;color:var(--txm);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat-bd{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;width:100%;margin-top:8px}
.lbl-cnt{font-size:.75rem;color:var(--txm);background:var(--bgp);padding:4px 10px;border-radius:8px}
.lbl-cnt b{color:var(--tx);font-weight:600}

/* Expandable Panels */
.panel-hd{width:100%;display:flex;justify-content:space-between;align-items:center;padding:16px 18px;background:var(--bgp);border:none;color:var(--tx);font-size:.95rem;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent;font-family:inherit;transition:background 0.2s}
.panel-hd:hover{background:rgba(var(--color-theme,127,127,127),0.08)}
.panel-label{display:flex;align-items:center}
.chev{display:inline-flex;transition:transform .3s}
.chev.open{transform:rotate(180deg)}
.chev ha-icon{--mdc-icon-size:18px}
.panel-bd{overflow:hidden;transition:max-height .35s ease-in-out;max-height:0}
.panel-inner{padding:16px}
.panel-acts{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.act{padding:10px 20px;border-radius:10px;border:1px solid var(--bdr);background:var(--bgp);color:var(--txd);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit;-webkit-tap-highlight-color:transparent;display:inline-flex;align-items:center}
.act:active{transform:scale(.96)}
.act.retrain{background:transparent;border-color:var(--c);color:var(--c)}
.act.retrain:hover{background:rgba(var(--c-rgb),0.1);color:var(--c)}

/* Data Health (Manager) */
.warn-box{display:flex;align-items:center;gap:10px;padding:12px;margin-bottom:14px;border-radius:10px;font-size:.85rem;background:rgba(var(--y-rgb),0.1);border:1px solid rgba(var(--y-rgb),0.3);color:var(--y);font-weight:500}
.dh-list{display:flex;flex-direction:column;gap:14px}
.dh-item{display:flex;flex-direction:column;gap:6px}
.dh-head{display:flex;justify-content:space-between;align-items:center}
.dh-name{font-size:.9rem;color:var(--tx);font-weight:600}
.dh-stats{display:flex;align-items:center;gap:12px;font-size:.8rem}
.dh-num{color:var(--txd)}
.dh-pct{color:var(--c);font-weight:700;width:40px;text-align:right}
.lb-track{height:10px;background:var(--bgd);border-radius:6px;overflow:hidden}
.lb-fill{height:100%;border-radius:6px;transition:width .6s ease;background:linear-gradient(90deg,rgba(var(--c-rgb),0.6),rgba(var(--c-rgb),1))}
.lb-fill.low{background:linear-gradient(90deg,rgba(var(--y-rgb),0.6),rgba(var(--y-rgb),1))}
.lb-fill.good{background:linear-gradient(90deg,rgba(var(--g-rgb),0.6),rgba(var(--g-rgb),1))}

/* Confusion Matrix */
.cm-wrap{overflow-x:auto;position:relative;padding-bottom:10px}
.cm{width:100%;border-collapse:collapse;font-size:.85rem;min-width:300px}
.cm th{position:sticky;background:var(--bgd);z-index:1}
.cm thead th{top:0;padding:10px 8px;color:var(--txd);font-weight:600;border-bottom:2px solid var(--bdr)}
.cm tbody th{left:0;padding:8px 12px;color:var(--txd);font-weight:600;text-align:right;border-right:2px solid var(--bdr)}
.cm td{padding:10px;text-align:center;border:1px solid var(--bdr);transition:background .2s}
.m-val{font-weight:600;font-variant-numeric:tabular-nums}
.m-val.zero{color:var(--txm);opacity:0.5}
.m-correct{color:var(--bg);text-shadow:0 1px 2px rgba(0,0,0,0.5)}
.m-wrong{color:var(--bg);text-shadow:0 1px 2px rgba(0,0,0,0.5)}
.corner{text-transform:uppercase;font-size:.7rem;letter-spacing:.05em;color:var(--txm)}

/* Sensor Management */
.sm-list{display:flex;flex-direction:column;gap:12px}
.sm-item{background:var(--bgp);border-radius:10px;padding:10px 14px;border:1px solid transparent;transition:border .2s}
.sm-item:hover{border-color:var(--bdr)}
.sm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.sm-name{font-size:.85rem;color:var(--tx);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:85%}
.sm-bar{display:flex;align-items:center;gap:12px}
.sm-track{flex:1;height:6px;background:var(--bgd);border-radius:4px;overflow:hidden}
.sm-fill{height:100%;background:linear-gradient(90deg,rgba(var(--c-rgb),0.4),rgba(var(--c-rgb),1));border-radius:4px}
.sm-pct{font-size:.75rem;color:var(--c);font-weight:700;width:35px;text-align:right;font-variant-numeric:tabular-nums}

/* Add Room */
.add-row{display:flex;gap:10px;padding:4px}
.add-input{flex:1;padding:12px 18px;border-radius:var(--rad);border:1px solid var(--bdr);background:var(--bg);color:var(--tx);font-size:.95rem;outline:none;font-family:inherit;transition:all .2s}
.add-input:focus{border-color:var(--o);box-shadow:0 0 0 2px rgba(var(--o-rgb),0.2)}
.add-input::placeholder{color:var(--txm)}
.add-btn{padding:12px 24px;border-radius:var(--rad);border:2px solid var(--o);background:rgba(var(--o-rgb),0.05);color:var(--o);font-size:.95rem;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap;font-family:inherit}
.add-btn:hover{background:rgba(var(--o-rgb),0.15)}
.add-btn:active{transform:scale(.96)}

/* Dynamic Training Mode Status */
.mode-status{font-size:.85rem;font-weight:600;margin-top:6px;text-align:center;padding:6px 12px;border-radius:10px;transition:all 0.3s;width:100%;box-sizing:border-box}
.mode-status.idle{color:var(--txm);background:var(--bgp)}
.mode-status.eager{color:var(--o);background:rgba(var(--o-rgb),0.15)}
.mode-status.active-learning{color:var(--c);background:rgba(var(--c-rgb),0.15)}

/* Add Sensor Management */
.add-sensor-title{font-size:.8rem;font-weight:700;color:var(--txd);text-transform:uppercase;margin:18px 0 8px;letter-spacing:.05em}
.add-sensor-row{display:flex;gap:8px;align-items:center;width:100%}
.add-sensor-input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--bdr);background:var(--bgd);color:var(--tx);font-size:.85rem;outline:none;font-family:inherit;box-sizing:border-box;min-width:0}
.add-sensor-input:focus{border-color:var(--o)}
.add-sensor-type{padding:10px;border-radius:10px;border:1px solid var(--bdr);background:var(--bgd);color:var(--tx);font-size:.85rem;outline:none;font-family:inherit}
.add-sensor-btn{padding:10px 16px;border-radius:10px;border:none;background:var(--o);color:var(--bg);font-weight:700;font-size:.85rem;cursor:pointer;transition:all .2s;font-family:inherit;white-space:nowrap}
.add-sensor-btn:hover{background:rgba(var(--o-rgb),0.8)}
.add-sensor-btn:active{transform:scale(.95)}

/* Toast */
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--bg);color:var(--tx);padding:12px 28px;border-radius:30px;font-size:.9rem;font-weight:600;opacity:0;transition:all .3s cubic-bezier(0.18, 0.89, 0.32, 1.28);z-index:1000;pointer-events:none;border:1px solid var(--bdr);box-shadow:0 8px 32px rgba(0,0,0,.2)}
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
