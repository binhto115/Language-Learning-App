/* global LivekitClient */
const MOCK_MODE = new URLSearchParams(window.location.search).has('mock');

// ── State ──────────────────────────────────────────────────────────────────
let room = null;
let connected = false;
let recording = false;
let mockTurnCount = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────
const btnConnect = document.getElementById('connect-btn');
const btnPtt = document.getElementById('ptt-btn');
const btnEnd = document.getElementById('end-session-btn');
const btnRefresh = document.getElementById('debug-refresh-btn');
const transcriptEl = document.getElementById('transcript-panel');
const agentStateEl = document.getElementById('agent-state');
const connStatus = document.getElementById('connection-status');

// debug panel
const debugMetrics = document.getElementById('debug-metrics');
const debugFsrs = document.getElementById('debug-fsrs');
const fsrsCount = document.getElementById('fsrs-count');
const debugLearner = document.getElementById('debug-learner');
const debugTutor = document.getElementById('debug-tutor');
const learnerVer = document.getElementById('learner-version');
const tutorVer = document.getElementById('tutor-version');
const debugPrompt = document.getElementById('debug-prompt');
const compSection = document.getElementById('compaction-result-section');
const compStatus = document.getElementById('compaction-status');
const compDiff = document.getElementById('compaction-diff');
const compFsrs = document.getElementById('compaction-fsrs');

// ── Mock data ─────────────────────────────────────────────────────────────
const MOCK_LEARNER_CORE = {
    version: 2,
    proficiency: { cefr_level: 'A1', bilingual_ratio: 0.75, speech_rate_wpm: 0, self_correction_rate: 0 },
    vocabulary: { active_count: 7, passive_count: 12, comfort_zones: ['cooking', 'hiking'], gaps: ['numbers', 'time'] },
    pronunciation: { overall_score: 0, trajectories: {}, l1_transfer_patterns: [] },
    grammar: { frontier: 'present tense regular verbs', mastered: ['me llamo', 'hola'], emerging: ['quiero', 'tengo'], breakthroughs: [] },
    learning_profile: {
        interests: ['cooking', 'hiking', 'travel to Mexico'],
        correction_preference: 'praise-first, end-of-turn',
        emotional_baseline: 'enthusiastic and curious',
        frustration_triggers: ['verb conjugation drills'],
        strengths: ['phonetic intuition', 'vocabulary retention'],
        endpointing_ms: 6000,
    },
    session_trajectory: 'Alex had two sessions focusing on hiking and cooking vocabulary. Strong enthusiasm for practical food and outdoor words. Ready to start connecting vocabulary into simple present-tense sentences.',
};

const MOCK_TUTOR_CORE = {
    version: 2,
    persona: { name: 'Sofía', voice_id: 'mock-voice', personality: 'Warm, curious, gently challenging. Mexican Spanish.' },
    teaching_narrative: 'Alex loves cooking and hiking. Build on established vocab by introducing simple present-tense sentences in context. Weave in due FSRS items naturally. Avoid explicit drills.',
    correction_strategy: { grammar: 'Inline recasts only', pronunciation: 'Note silently, no feedback yet', vocabulary: 'Introduce in context, 3-5 words per session' },
    pacing: { current_push: 'Simple present tense sentences', next_horizon: 'Regular -ar verb conjugations', avoid: 'Past tenses, subjunctive' },
    fsrs_integration: 'Review sendero, empinado, cocinar naturally.',
    engagement_insights: { high_engagement_topics: ['cooking', 'hiking'], low_engagement_topics: [], preferred_conversation_style: 'real-world scenarios' },
    bilingual_ratio_target: 0.75,
    endpointing_ms: 6000,
};

const MOCK_FSRS_ITEMS = [
    { item_key: 'sendero', item_context: 'hiking trail — from session 1' },
    { item_key: 'empinado', item_context: 'steep terrain' },
    { item_key: 'cocinar', item_context: 'to cook — from session 2' },
    { item_key: 'delicioso', item_context: 'delicious' },
    { item_key: 'receta', item_context: 'recipe' },
];

const MOCK_SOFIA_RESPONSES = [
    '¡Hola! Welcome back, Alex. Last time we talked about hiking trails — senderos — and some cooking words. Ready to keep going?',
    'That\'s great! You know, I was thinking we could practice putting words together. You could say "Yo cocino todos los días" — I cook every day. Can you try that?',
    '¡Muy bien! Your pronunciation is getting better. What do you like to cook?',
    'Oh, pasta! "Pasta" is the same in Spanish. And if it\'s delicious you can say "¡Está deliciosa!" Try it!',
    '¡Perfecto! You\'re doing really well today. Do you remember the word for a hiking trail?',
    'Exacto — sendero. And if the trail is steep, empinado. You\'ve got those down solid now.',
];

// ── Connect ───────────────────────────────────────────────────────────────
btnConnect.addEventListener('click', async() => {
    if (connected) return;

    if (MOCK_MODE) {
        connectMock();
        return;
    }

    btnConnect.disabled = true;
    btnConnect.textContent = 'Connecting…';
    setStatus('Connecting…', 'initializing');

    try {
        const { Room, RoomEvent, Track, createLocalAudioTrack } = LivekitClient;
        const res = await fetch('/api/token?room=habla-session&identity=learner-' + Date.now());
        const { token, url } = await res.json();

        room = new Room({ adaptiveStream: true, dynacast: true });
        wireRoomEvents(RoomEvent, Track);

        await room.connect(url, token);
        connected = true;

        const audioTrack = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
        await room.localParticipant.publishTrack(audioTrack, { audioBitrate: 40000 });
        await audioTrack.mute();

        btnConnect.textContent = 'Connected';
        btnConnect.classList.add('connected');
        btnConnect.disabled = true;
        btnPtt.disabled = false;
        btnEnd.disabled = false;
        btnRefresh.disabled = false;
        connStatus.classList.add('connected');
        connStatus.textContent = 'Connected';
        setStatus('Waiting for Sofía…', 'idle');

        setTimeout(refreshSnapshot, 2000);
    } catch (err) {
        console.error('Connect error:', err);
        btnConnect.disabled = false;
        btnConnect.textContent = 'Connect';
        setStatus('Connection failed', 'idle');
        alert('Connection failed: ' + err.message);
    }
});

function connectMock() {
    connected = true;
    btnConnect.textContent = 'Connected';
    btnConnect.classList.add('connected');
    btnConnect.disabled = true;
    btnPtt.disabled = false;
    btnEnd.disabled = false;
    btnRefresh.disabled = false;
    connStatus.classList.add('connected');
    connStatus.textContent = 'Connected (mock)';
    setStatus('Sofía is ready', 'idle');

    setTimeout(() => {
        appendTurn('tutor', MOCK_SOFIA_RESPONSES[0]);
    }, 800);

    renderMockDebug();
}

// ── Push-to-talk ──────────────────────────────────────────────────────────
btnPtt.addEventListener('mousedown', startRecording);
btnPtt.addEventListener('touchstart', e => { e.preventDefault();
    startRecording(); });
btnPtt.addEventListener('mouseup', stopRecording);
btnPtt.addEventListener('mouseleave', stopRecording);
btnPtt.addEventListener('touchend', e => { e.preventDefault();
    stopRecording(); });

function startRecording() {
    if (!connected || recording) return;
    recording = true;
    btnPtt.classList.add('active');
    btnPtt.textContent = 'Listening…';
    setStatus('Listening…', 'listening');

    if (!MOCK_MODE && room) {
        rpc('ptt_start').catch(console.error);
        const track = getLocalAudioTrack();
        if (track) track.unmute();
    }
}

function stopRecording() {
    if (!connected || !recording) return;
    recording = false;
    btnPtt.classList.remove('active');
    btnPtt.textContent = 'Hold to Speak';

    if (MOCK_MODE) {
        handleMockTurn();
        return;
    }

    setStatus('Thinking…', 'thinking');
    rpc('ptt_end').catch(console.error);
    const track = getLocalAudioTrack();
    if (track) track.mute();
}

function handleMockTurn() {
    const learnerLines = [
        'Sí, estoy listo. Let\'s practice!',
        'Yo cocino todos los días. Did I say that right?',
        '¡Está deliciosa! I like that one.',
        'Pasta, and also empanadas.',
        'Sendero! Un sendero empinado.',
        'Gracias Sofía, this is really helping.',
    ];

    const learnerText = learnerLines[mockTurnCount % learnerLines.length];
    appendTurn('learner', learnerText);
    setStatus('Thinking…', 'thinking');
    mockTurnCount++;

    setTimeout(() => {
        const sofiaText = MOCK_SOFIA_RESPONSES[mockTurnCount % MOCK_SOFIA_RESPONSES.length];
        appendTurn('tutor', sofiaText);
        setStatus('Ready', 'idle');
        updateMockMetrics();
    }, 1200);
}

// ── End session ───────────────────────────────────────────────────────────
btnEnd.addEventListener('click', async() => {
    if (!connected) return;
    btnEnd.disabled = true;
    btnEnd.classList.add('compacting');
    btnEnd.textContent = 'Compacting…';
    setStatus('Compacting session…', 'thinking');

    if (MOCK_MODE) {
        setTimeout(() => {
            showMockCompactionResult();
            btnEnd.textContent = 'Done';
            setStatus('Session complete', 'idle');
            btnPtt.disabled = true;
        }, 2000);
        return;
    }

    try {
        const raw = await rpc('end_session');
        const result = JSON.parse(raw);

        if (!result.ok) {
            alert('Compaction failed: ' + result.error);
            btnEnd.disabled = false;
            btnEnd.classList.remove('compacting');
            btnEnd.textContent = 'End & Compact';
            return;
        }

        showCompactionResult(result);
        btnEnd.textContent = 'Done';
        setStatus('Session complete', 'idle');
        btnPtt.disabled = true;
    } catch (err) {
        console.error('End session error:', err);
        btnEnd.disabled = false;
        btnEnd.classList.remove('compacting');
        btnEnd.textContent = 'End & Compact';
        alert('Error: ' + err.message);
    }
});

// ── Debug refresh ─────────────────────────────────────────────────────────
btnRefresh.addEventListener('click', () => {
    if (MOCK_MODE) { renderMockDebug(); return; }
    refreshSnapshot();
});

async function refreshSnapshot() {
    if (!connected || MOCK_MODE) return;
    try {
        const raw = await rpc('debug_snapshot');
        const snap = JSON.parse(raw);
        renderSnapshot(snap);
    } catch (err) {
        console.warn('Snapshot failed:', err.message);
    }
}

// ── Render helpers ────────────────────────────────────────────────────────
function renderSnapshot(snap) {
    debugLearner.textContent = JSON.stringify(snap.learnerCore, null, 2);
    debugTutor.textContent = JSON.stringify(snap.tutorCore, null, 2);
    debugPrompt.textContent = snap.systemPrompt || '—';
    learnerVer.textContent = `v${snap.learnerCore?.version ?? 0}`;
    tutorVer.textContent = `v${snap.tutorCore?.version ?? 0}`;

    if (snap.fsrsDueItems ? .length > 0) {
        fsrsCount.textContent = snap.fsrsDueItems.length;
        debugFsrs.innerHTML = snap.fsrsDueItems.map(item => `
      <div class="fsrs-item">
        <div class="fsrs-key">${esc(item.item_key)}</div>
        ${item.item_context ? `<div class="fsrs-context">${esc(item.item_context)}</div>` : ''}
      </div>
    `).join('');
  } else {
    fsrsCount.textContent = '0';
    debugFsrs.textContent = 'No items due.';
  }

  const started = snap.sessionStartedAt ? new Date(snap.sessionStartedAt) : null;
  const mins = started ? Math.round((Date.now() - started.getTime()) / 60000) : 0;
  debugMetrics.textContent =
    `Turns: ${snap.turnCount || 0}\nDuration: ${mins} min\nFSRS due: ${snap.fsrsDueItems?.length || 0}\nCore version: v${snap.learnerCore?.version ?? 0}`;
}

function renderMockDebug() {
  debugLearner.textContent = JSON.stringify(MOCK_LEARNER_CORE, null, 2);
  debugTutor.textContent   = JSON.stringify(MOCK_TUTOR_CORE, null, 2);
  learnerVer.textContent   = `v${MOCK_LEARNER_CORE.version}`;
  tutorVer.textContent     = `v${MOCK_TUTOR_CORE.version}`;
  fsrsCount.textContent    = MOCK_FSRS_ITEMS.length;
  debugFsrs.innerHTML = MOCK_FSRS_ITEMS.map(item => `
    <div class="fsrs-item">
      <div class="fsrs-key">${esc(item.item_key)}</div>
      <div class="fsrs-context">${esc(item.item_context)}</div>
    </div>
  `).join('');
  debugPrompt.textContent =
    `## CRITICAL: Your Output Is Spoken Aloud\nNEVER use parenthetical pronunciation guides...\n\n` +
    `You are Sofía, a warm Spanish-English language tutor.\n\n` +
    `## Your game plan for this session\n${MOCK_TUTOR_CORE.teaching_narrative}\n\n` +
    `## About this learner\n${MOCK_LEARNER_CORE.session_trajectory}\n\n` +
    `## Learner profile\nInterests: ${MOCK_LEARNER_CORE.learning_profile.interests.join(', ')}\n\n` +
    `## Vocabulary due for review\n${MOCK_FSRS_ITEMS.map(i => `  - "${i.item_key}" — ${i.item_context}`).join('\n')}`;
  updateMockMetrics();
}

function updateMockMetrics() {
  debugMetrics.textContent =
    `Turns: ${mockTurnCount}\nDuration: ${mockTurnCount} min (mock)\nFSRS due: ${MOCK_FSRS_ITEMS.length}\nCore version: v${MOCK_LEARNER_CORE.version}`;
}

function showMockCompactionResult() {
  compSection.style.display = 'block';
  compStatus.textContent = 'Compaction complete (mock).';
  compDiff.innerHTML = `
    <div class="diff-entry">
      <span class="diff-field">session_trajectory</span>
      <span class="diff-old">${esc(MOCK_LEARNER_CORE.session_trajectory)}</span>
      <span class="diff-new">Alex had a strong third session connecting vocabulary into simple sentences. Ready to push into full present-tense conjugation next session.</span>
    </div>
    <div class="diff-entry">
      <span class="diff-field">vocabulary.active_count</span>
      <span class="diff-old">7</span>
      <span class="diff-new">9</span>
    </div>
    <div class="diff-entry">
      <span class="diff-field">teaching_narrative</span>
      <span class="diff-old">${esc(MOCK_TUTOR_CORE.teaching_narrative)}</span>
      <span class="diff-new">Alex is connecting words into sentences confidently. Next session: introduce full present-tense conjugations for -ar verbs using cooking verbs as anchors.</span>
    </div>
  `;
  compFsrs.textContent = JSON.stringify([
    { action: 'rate', item_key: 'sendero', rating: 'Easy' },
    { action: 'rate', item_key: 'empinado', rating: 'Good' },
    { action: 'rate', item_key: 'cocinar', rating: 'Good' },
    { action: 'create', item_type: 'vocabulary', item_key: 'empanada', context: 'Learner asked about empanadas' },
  ], null, 2);
}

function showCompactionResult(result) {
  compSection.style.display = 'block';
  compStatus.textContent = `Compacted in ${result.durationMs}ms. ${result.compactionNotes}`;
  compDiff.innerHTML = `
    <div class="diff-entry"><span class="diff-field">learner core</span><span class="diff-old">v${result.preCores?.learner?.version}</span><span class="diff-new">v${result.postCores?.learner?.version}</span></div>
    <div class="diff-entry"><span class="diff-field">tutor core</span><span class="diff-old">v${result.preCores?.tutor?.version}</span><span class="diff-new">v${result.postCores?.tutor?.version}</span></div>
    <div class="diff-entry"><span class="diff-field">FSRS created</span><span class="diff-new">${result.fsrsCreated}</span></div>
    <div class="diff-entry"><span class="diff-field">FSRS rated</span><span class="diff-new">${result.fsrsRated}</span></div>
  `;
  compFsrs.textContent = JSON.stringify(result.fsrsUpdates, null, 2);
}

// ── Transcript ────────────────────────────────────────────────────────────
function appendTurn(role, text) {
  if (!text?.trim()) return;
  const div = document.createElement('div');
  div.className = `transcript-entry ${role}`;
  div.innerHTML = `<div class="speaker">${role === 'tutor' ? 'Sofía' : 'You'}</div><div>${esc(text)}</div>`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── LiveKit room events (real mode only) ──────────────────────────────────
function wireRoomEvents(RoomEvent, Track) {
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
    }
  });

  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    const isSofia = participant?.identity !== room.localParticipant?.identity;
    for (const seg of segments) {
      if (seg.final) appendTurn(isSofia ? 'tutor' : 'learner', seg.text);
    }
    if (isSofia) setStatus('Sofía speaking…', 'speaking');
  });

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const sofiaActive = speakers.some(s => s.identity !== room.localParticipant?.identity);
    if (!sofiaActive && !recording) setStatus('Ready', 'idle');
  });

  room.on(RoomEvent.Disconnected, () => {
    connected = false;
    connStatus.textContent = 'Disconnected';
    connStatus.classList.remove('connected');
    setStatus('Disconnected', 'idle');
    btnPtt.disabled = true;
    btnEnd.disabled = true;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function rpc(method, payload = '') {
  if (!room?.localParticipant) throw new Error('Not connected');
  const participants = Array.from(room.remoteParticipants.values());
  const agent = participants.find(p => p.identity?.startsWith('agent')) || participants[0];
  if (!agent) throw new Error('Agent not found');
  return await room.localParticipant.performRpc({
    destinationIdentity: agent.identity,
    method,
    payload,
    responseTimeout: 30000,
  });
}

function getLocalAudioTrack() {
  if (!room?.localParticipant) return null;
  for (const pub of room.localParticipant.audioTrackPublications.values()) {
    if (pub.track) return pub.track;
  }
  return null;
}

function setStatus(text, stateClass) {
  agentStateEl.textContent = text;
  agentStateEl.className = `state-${stateClass}`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}