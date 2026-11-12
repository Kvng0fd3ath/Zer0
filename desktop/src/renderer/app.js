'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.zer0;

  const el = {
    app: $('app'),
    ballLine: $('ball-line'),
    status: $('status'),
    statusDot: $('status-dot'),
    brandName: $('brand-name'),
    log: $('log'),
    actions: $('actions'),
    composer: $('composer'),
    input: $('input'),
    send: $('btn-send'),
    mic: $('btn-mic'),
    toast: $('toast'),
    wakeBadge: $('wake-badge'),
    settings: $('settings'),
    form: $('settings-form'),
  };

  const ui = {
    busy: false,
    recording: null, // { recorder, chunks, timer }
    audio: null,
    state: null,
    toastTimer: null,
    resumeAt: 0, // wake listening stays paused until this time (lets the speaker's echo die down)
    lastLine: '', // newest chat line, shown in ball mode
    pendingActions: 0, // confirmations waiting; ball mode points the user to the full window
    awaitingUntil: 0, // after a bare "Hey Zero", the next utterance is taken as the command
  };

  const wake = window.Zer0WakeListener.createWakeListener({
    onUtterance: handleWakeUtterance,
    isPaused: wakePaused,
    onState: onWakeState,
  });

  // ---------- helpers ----------

  function setOrb(state) {
    el.app.dataset.state = state;
  }

  function setStatus(text, { offline = false } = {}) {
    el.status.textContent = text;
    el.statusDot.classList.toggle('offline', offline);
    updateBallLine();
  }

  function toast(text, { bad = false, ms = 4500 } = {}) {
    el.toast.textContent = text;
    el.toast.classList.toggle('bad', bad);
    el.toast.hidden = false;
    updateBallLine();
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => { el.toast.hidden = true; updateBallLine(); }, ms);
  }

  function addMessage(role, text, cls = '') {
    const node = document.createElement('div');
    node.className = `msg ${role} ${cls}`.trim();
    node.textContent = text; // never innerHTML: model output is untrusted text
    el.log.appendChild(node);
    el.log.scrollTop = el.log.scrollHeight;
    ui.lastLine = role === 'user' ? `You: ${text}` : text;
    updateBallLine();
    return node;
  }

  /** Ball mode shows one line: a toast, a pending confirmation, "Thinking...", or the newest chat line. */
  function updateBallLine() {
    let text;
    if (!el.toast.hidden) text = el.toast.textContent;
    else if (ui.pendingActions > 0) text = 'Needs your confirmation. Open Zer0 to review.';
    else if (ui.busy) text = 'Thinking...';
    else text = ui.lastLine || el.status.textContent;
    el.ballLine.textContent = text;
  }

  /** Switches between the full window and the small ball. The main process resizes the window. */
  function applyModeUi(mode) {
    el.app.dataset.mode = mode === 'ball' ? 'ball' : 'full';
    if (el.app.dataset.mode === 'ball') el.settings.hidden = true;
    updateBallLine();
  }

  async function setMode(mode) {
    try {
      applyModeUi(await api.invoke('window:mode', mode));
      if (mode === 'full') el.input.focus();
    } catch (err) {
      toast(errorText(err), { bad: true });
    }
  }

  function errorText(err) {
    return (err && err.message) || 'Something went wrong.';
  }

  function wakePaused() {
    return ui.busy || Boolean(ui.recording) || Boolean(ui.audio) || window.speechSynthesis?.speaking === true
      || Date.now() < ui.resumeAt;
  }

  function onWakeState(state, error) {
    el.wakeBadge.hidden = state !== 'listening';
    if (error) toast(error, { bad: true, ms: 7000 });
  }

  function wakePhrase() {
    return ui.state?.settings?.wakeWord?.phrase || 'Hey Zero';
  }

  /** True when a speech-to-text service is configured (NVIDIA chat key or OpenAI key). */
  function canTranscribe() {
    const stt = ui.state?.voiceEngines?.stt;
    return Boolean(stt && stt !== 'none');
  }

  /** NVIDIA needs 16 kHz mono WAV, so recordings are converted first. Other services take the recording as-is. */
  async function audioForService(blob) {
    if (ui.state?.voiceEngines?.stt !== 'nvidia') return blob;
    return window.Zer0Wav.toWav16kMono(blob);
  }

  async function applyWake() {
    const cfg = ui.state?.settings?.wakeWord;
    const canListen = Boolean(cfg?.enabled && canTranscribe());
    if (!canListen) {
      wake.stop();
      return;
    }
    if (wake.running) {
      // Sensitivity changes need a fresh stream with the new threshold.
      wake.stop();
    }
    await wake.start({ sensitivity: cfg.sensitivity });
    if (wake.running) setStatus(`Listening for "${wakePhrase()}".`);
  }

  async function handleWakeUtterance(blob) {
    if (ui.busy || !canTranscribe()) return;
    let text = '';
    try {
      const prepared = await audioForService(blob);
      const bytes = new Uint8Array(await prepared.arrayBuffer());
      text = await api.invoke('voice:transcribe', bytes, prepared.type, wakePhrase());
    } catch (err) {
      // Transient transcription failures should not interrupt the user.
      console.warn('Wake transcription failed:', errorText(err));
      return;
    }
    if (!text || ui.busy) return;

    if (Date.now() < ui.awaitingUntil) {
      ui.awaitingUntil = 0;
      sendMessage(text);
      return;
    }

    const match = window.Zer0WakeWord.matchWake(text, wakePhrase());
    if (!match.matched) return;

    window.Zer0WakeListener.playChime();
    if (match.command) {
      sendMessage(match.command);
    } else {
      ui.awaitingUntil = Date.now() + 8000;
      setStatus('Yes?');
    }
  }

  // ---------- speech out ----------

  function stopSpeaking() {
    if (ui.audio) {
      ui.audio.pause();
      URL.revokeObjectURL(ui.audio.src);
      ui.audio = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  function speakWithSystemVoice(text) {
    if (!('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.onstart = () => setOrb('speaking');
    utter.onend = () => { ui.resumeAt = Date.now() + 800; setOrb('idle'); };
    utter.onerror = () => { ui.resumeAt = Date.now() + 800; setOrb('idle'); };
    window.speechSynthesis.speak(utter);
  }

  async function speak(text) {
    if (!ui.state?.settings?.voice?.enabled) return;
    stopSpeaking();
    if (!ui.state.voiceEngines || ui.state.voiceEngines.tts === 'windows') {
      speakWithSystemVoice(text);
      return;
    }
    try {
      const bytes = await api.invoke('voice:speak', text);
      if (!bytes) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      ui.audio = audio;
      audio.onplay = () => setOrb('speaking');
      const done = () => {
        if (ui.audio === audio) ui.audio = null;
        URL.revokeObjectURL(url);
        ui.resumeAt = Date.now() + 800;
        if (!ui.busy && !ui.recording) setOrb('idle');
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
    } catch (err) {
      // Fall back to the system voice if the cloud voice is unavailable.
      speakWithSystemVoice(text);
      toast(`Voice fallback: ${errorText(err)}`, { bad: true });
    }
  }

  // ---------- chat ----------

  function renderActions(list) {
    ui.pendingActions = list.length;
    updateBallLine();
    el.actions.textContent = '';
    for (const action of list) {
      const card = document.createElement('div');
      card.className = 'action-card';
      card.dataset.id = action.id;

      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = action.type === 'place_call' ? 'Confirm call' : 'Confirm text';

      const summary = document.createElement('div');
      summary.className = 'summary';
      summary.textContent = action.summary;

      const row = document.createElement('div');
      row.className = 'row';

      const ok = document.createElement('button');
      ok.className = 'primary small';
      ok.textContent = action.type === 'place_call' ? 'Place call' : 'Send';
      ok.addEventListener('click', () => confirmAction(action.id, ok, cancel));

      const cancel = document.createElement('button');
      cancel.className = 'small';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelAction(action.id, ok, cancel));

      row.append(ok, cancel);
      card.append(kind, summary, row);
      el.actions.appendChild(card);
    }
  }

  async function refreshActions() {
    try {
      renderActions(await api.invoke('actions:list'));
    } catch (err) {
      toast(errorText(err), { bad: true });
    }
  }

  async function confirmAction(id, ...buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    setStatus('Working on it...');
    setOrb('thinking');
    try {
      const action = await api.invoke('actions:confirm', id);
      if (action.status === 'done') {
        addMessage('system', `Sent: ${action.summary}`, 'ok');
        toast('Sent.');
      } else {
        addMessage('system', `Could not send: ${action.error || action.status}`, 'bad');
        toast(action.error || 'The action failed.', { bad: true, ms: 7000 });
      }
    } catch (err) {
      addMessage('system', errorText(err), 'bad');
      toast(errorText(err), { bad: true, ms: 7000 });
    } finally {
      await refreshActions();
      setOrb('idle');
      setStatus('Ready.');
    }
  }

  async function cancelAction(id, ...buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await api.invoke('actions:cancel', id);
      addMessage('system', 'Cancelled. Nothing was sent.');
    } catch (err) {
      toast(errorText(err), { bad: true });
    } finally {
      await refreshActions();
    }
  }

  async function sendMessage(text) {
    const message = String(text ?? '').trim();
    if (!message || ui.busy) return;
    stopSpeaking();
    ui.busy = true;
    el.send.disabled = true;
    updateBallLine();
    addMessage('user', message);
    el.input.value = '';
    setOrb('thinking');
    setStatus('Thinking...');
    try {
      const { reply } = await api.invoke('chat:send', message);
      if (reply) addMessage('assistant', reply);
      setStatus('Ready.');
      setOrb('idle');
      await refreshActions();
      if (reply) speak(reply);
    } catch (err) {
      addMessage('system', errorText(err), 'bad');
      setStatus(errorText(err), { offline: true });
      setOrb('error');
      setTimeout(() => setOrb('idle'), 2500);
    } finally {
      ui.busy = false;
      ui.resumeAt = Date.now() + 800;
      el.send.disabled = false;
      updateBallLine();
      el.input.focus();
    }
  }

  // ---------- push to talk ----------

  function pickMimeType() {
    const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording() {
    if (ui.recording || ui.busy) return;
    if (!canTranscribe()) {
      toast('Voice input needs an NVIDIA or OpenAI key. Add one in Settings.', { bad: true, ms: 6000 });
      return;
    }
    stopSpeaking();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast(`Microphone unavailable: ${err.message}`, { bad: true, ms: 6000 });
      return;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(ui.recording?.timer);
      ui.recording = null;
      el.mic.classList.remove('recording');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) { setOrb('idle'); setStatus('Ready.'); return; }
      setOrb('thinking');
      setStatus('Transcribing...');
      try {
        const prepared = await audioForService(blob);
        const bytes = new Uint8Array(await prepared.arrayBuffer());
        const text = await api.invoke('voice:transcribe', bytes, prepared.type);
        if (!text) { setStatus('I did not catch that.'); setOrb('idle'); return; }
        await sendMessage(text);
      } catch (err) {
        addMessage('system', errorText(err), 'bad');
        setStatus('Voice input failed.');
        setOrb('idle');
      }
    };
    recorder.start();
    const timer = setTimeout(() => stopRecording(), 60_000); // hard cap per utterance
    ui.recording = { recorder, chunks, timer };
    el.mic.classList.add('recording');
    setOrb('listening');
    setStatus('Listening... press the mic again to finish.');
  }

  function stopRecording() {
    if (!ui.recording) return;
    if (ui.recording.recorder.state !== 'inactive') ui.recording.recorder.stop();
  }

  function toggleRecording() {
    if (ui.recording) stopRecording();
    else startRecording();
  }

  // ---------- settings ----------

  const SETTINGS_FIELDS = {
    assistantName: (v) => v.trim(),
    userName: (v) => v.trim(),
    'llm.model': (v) => v.trim(),
    'llm.baseUrl': (v) => v.trim(),
    'voice.enabled': (_v, el) => el.checked,
    'voice.ttsVoice': (v) => v,
    'voice.fishVoiceId': (v) => v.trim(),
    'twilio.fromNumber': (v) => v.trim(),
    hotkey: (v) => v.trim(),
    launchAtLogin: (_v, el) => el.checked,
    alwaysOnTop: (_v, el) => el.checked,
    autoUpdate: (_v, el) => el.checked,
    'wakeWord.enabled': (_v, el) => el.checked,
    'wakeWord.phrase': (v) => v.trim(),
    'wakeWord.sensitivity': (v) => v,
  };

  function parseContacts(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)[,:]\s*(\+?[\d\s().-]{7,})$/);
        return m ? { name: m[1].trim(), phone: m[2].trim() } : null;
      })
      .filter(Boolean);
  }

  function fillSettingsForm(state) {
    const s = state.settings;
    const get = (path) => path.split('.').reduce((o, k) => o?.[k], s);
    for (const [key] of Object.entries(SETTINGS_FIELDS)) {
      const input = el.form.elements.namedItem(key);
      if (!input) continue;
      const value = get(key);
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    }
    el.form.elements.namedItem('voice.ttsVoice').value = s.voice.ttsVoice;
    el.form.elements.namedItem('wakeWord.sensitivity').value = s.wakeWord.sensitivity;
    el.form.elements.namedItem('contacts').value = s.contacts.map((c) => `${c.name}, ${c.phone}`).join('\n');

    refreshSecretHints(state);
    el.brandName.textContent = s.assistantName || 'Zer0';
    $('version-line').textContent = `Version ${state.version}${state.packaged ? '' : ' (development build)'}`;
  }

  /** Says which services voice uses right now. */
  function renderVoiceEngines(state) {
    const engines = state.voiceEngines || {};
    const stt = {
      nvidia: 'NVIDIA (free, uses your chat key)',
      openai: 'OpenAI',
      none: 'none (add an NVIDIA or OpenAI key)',
    }[engines.stt] || 'none';
    const tts = {
      fish: 'Fish Audio',
      openai: 'OpenAI',
      windows: 'Windows voice',
    }[engines.tts] || 'Windows voice';
    $('voice-engines').textContent = `Speech to text: ${stt}. Replies read with: ${tts}.`;
  }

  /** Updates the key hints only. Saving a key must not overwrite unsaved edits elsewhere in the form. */
  function refreshSecretHints(state) {
    const set = state.secretsSet;
    $('hint-openai').textContent = set.openaiApiKey ? 'A key is saved. Paste a new one to replace it.' : 'No key saved yet.';
    $('hint-fish').textContent = set.fishApiKey ? 'A key is saved. Paste a new one to replace it.' : 'No key saved yet. Optional: gives a natural voice for replies.';
    $('key-fish').placeholder = set.fishApiKey ? '•••• saved ••••' : 'Fish Audio API key';
    renderVoiceEngines(state);
    $('hint-llm').textContent = set.llmApiKey
      ? 'A chat key is saved.'
      : set.openaiApiKey
        ? 'No chat key: chat uses the OpenAI key below.'
        : 'No chat key saved yet.';
    $('key-llm').placeholder = set.llmApiKey ? '•••• saved ••••' : 'nvapi-... or sk-...';
    $('hint-twilio').textContent = set.twilioAccountSid && set.twilioAuthToken
      ? 'Twilio credentials are saved.'
      : 'Needed for texts and calls.';
    $('key-openai').placeholder = set.openaiApiKey ? '•••• saved ••••' : 'sk-...';
    $('key-sid').placeholder = set.twilioAccountSid ? '•••• saved ••••' : 'AC...';
    $('key-token').placeholder = set.twilioAuthToken ? '•••• saved ••••' : 'Auth token';
  }

  function collectSettingsPatch() {
    const patch = {};
    for (const [key, read] of Object.entries(SETTINGS_FIELDS)) {
      const input = el.form.elements.namedItem(key);
      if (!input) continue;
      const value = read(input.type === 'checkbox' ? '' : input.value, input);
      setPath(patch, key, value);
    }
    patch.contacts = parseContacts(el.form.elements.namedItem('contacts').value);
    return patch;
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] || {}; cur = cur[k]; });
    cur[keys[keys.length - 1]] = value;
  }

  function renderUpdate(u) {
    const line = $('update-line');
    const install = $('btn-install-update');
    install.hidden = u.status !== 'ready';
    switch (u.status) {
      case 'disabled': line.textContent = u.reason || 'Updates are off.'; break;
      case 'checking': line.textContent = 'Checking for updates...'; break;
      case 'up-to-date': line.textContent = `You are up to date (${u.version || ui.state?.version}).`; break;
      case 'downloading': line.textContent = u.version
        ? `Downloading ${u.version}${u.percent != null ? ` (${u.percent}%)` : ''}...`
        : 'Downloading update...'; break;
      case 'ready': line.textContent = `Version ${u.version} is ready. Restart to finish updating.`; break;
      case 'error': line.textContent = `Update check failed: ${u.message}`; break;
      default: line.textContent = 'Checking for updates...';
    }
  }

  async function clearSecret(name) {
    try {
      ui.state = await api.invoke('secrets:set', { name, value: '' });
      refreshSecretHints(ui.state);
      toast('Key removed.');
    } catch (err) {
      toast(errorText(err), { bad: true, ms: 6000 });
    }
  }

  async function saveSecret(name, input) {
    const value = input.value.trim();
    if (!value) { toast('Paste a value first.', { bad: true }); return; }
    try {
      ui.state = await api.invoke('secrets:set', { name, value });
      input.value = '';
      refreshSecretHints(ui.state);
      toast('Saved securely on this device.');
    } catch (err) {
      toast(errorText(err), { bad: true, ms: 6000 });
    }
  }

  // ---------- wiring ----------

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(el.input.value);
  });

  el.mic.addEventListener('click', toggleRecording);

  $('btn-settings').addEventListener('click', () => { el.settings.hidden = false; });
  $('btn-close-settings').addEventListener('click', () => { el.settings.hidden = true; });
  $('btn-min').addEventListener('click', () => api.invoke('window:minimize').catch(() => {}));
  $('btn-hide').addEventListener('click', () => api.invoke('window:hide').catch(() => {}));
  $('btn-shrink').addEventListener('click', () => setMode('ball'));
  $('btn-expand').addEventListener('click', () => setMode('full'));
  $('btn-ball-hide').addEventListener('click', () => api.invoke('window:hide').catch(() => {}));

  document.querySelectorAll('[data-save-secret]').forEach((btn) => {
    btn.addEventListener('click', () => saveSecret(btn.dataset.saveSecret, $(btn.dataset.input)));
  });

  document.querySelectorAll('[data-clear-secret]').forEach((btn) => {
    btn.addEventListener('click', () => clearSecret(btn.dataset.clearSecret));
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-save-settings');
    btn.disabled = true;
    try {
      ui.state = await api.invoke('settings:update', collectSettingsPatch());
      fillSettingsForm(ui.state);
      await applyWake();
      toast('Settings saved.');
      el.settings.hidden = true;
    } catch (err) {
      toast(errorText(err), { bad: true, ms: 6000 });
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-check-update').addEventListener('click', async () => {
    try {
      renderUpdate(await api.invoke('updates:check'));
    } catch (err) {
      renderUpdate({ status: 'error', message: errorText(err) });
    }
  });

  $('btn-install-update').addEventListener('click', () => api.invoke('updates:install').catch((err) => toast(errorText(err), { bad: true })));

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.input.blur();
  });

  // Main-process events: updates, push-to-talk hotkey, notices.
  api.onEvent((event) => {
    switch (event.type) {
      case 'update-status':
        renderUpdate(event);
        if (event.status === 'ready') toast(`Update ${event.version} downloaded. Restart to finish.`, { ms: 9000 });
        break;
      case 'push-to-talk':
        toggleRecording();
        break;
      case 'mode':
        applyModeUi(event.mode);
        break;
      case 'notice':
        toast(event.message, { bad: event.level === 'warn' || event.level === 'error', ms: 7000 });
        break;
      default:
        break;
    }
  });

  // ---------- boot ----------

  async function boot() {
    try {
      ui.state = await api.invoke('state:get');
      fillSettingsForm(ui.state);
      renderUpdate(ui.state.update || { status: 'idle' });
      el.brandName.textContent = ui.state.settings.assistantName || 'Zer0';
      const transcript = await api.invoke('chat:transcript');
      for (const m of transcript) addMessage(m.role, m.content);
      await refreshActions();
      await applyWake();
      const welcome = ui.state.settings.userName ? `Good to see you, ${ui.state.settings.userName}.` : 'Online.';
      if (!transcript.length) setStatus(`${welcome} Type below, or press the mic.`);
      if (!ui.state.secretsSet.llmApiKey && !ui.state.secretsSet.openaiApiKey) {
        setStatus('Add a chat API key in Settings to start.', { offline: true });
      }
      if (ui.state.settings.wakeWord.enabled && canTranscribe()) {
        setStatus(`Listening for "${wakePhrase()}".`);
      }
    } catch (err) {
      setStatus(errorText(err), { offline: true });
    }
  }

  boot();
})();
