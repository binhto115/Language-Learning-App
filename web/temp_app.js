const MOCK_MODE = new URLSearchParams(window.location.search).has('mock'); //Mock the backend

// Fresh room name each page load so LiveKit dispatches a new agent
const ROOM_NAME = 'habla-' + Date.now();
const PARTICIPANT_IDENTITY = 'learner';

const connectBtn = document.getElementById('connect-btn');
const pttBtn = document.getElementById('ptt-btn');
const debugRefreshBtn = document.getElementById('debug-refresh-btn');
const endSessionBtn = document.getElementById('end-session-btn');
const transcriptPanel = document.getElementById('transcript-panel');
const agentStateEl = document.getElementById('agent-state');
const connectionStatusEl = document.getElementById('connection-status');

// Debug panel elements
const debugMetricsEl = document.getElementById('debug-metrics');
const debugFsrsEl = document.getElementById('debug-fsrs');
const debugLearnerEl = document.getElementById('debug-learner');
const debugTutorEl = document.getElementById('debug-tutor');
const debugPromptEl = document.getElementById('debug-prompt');
const fsrsCountEl = document.getElementById('fsrs-count');
const learnerVersionEl = document.getElementById('learner-version');
const tutorVersionEl = document.getElementById('tutor-version');

// Compaction result elements
const compactionResultSection = document.getElementById('compaction-result-section');
const compactionStatusEl = document.getElementById('compaction-status');
const compactionDiffEl = document.getElementById('compaction-diff');
const compactionFsrsEl = document.getElementById('compaction-fsrs');

let room = null;
let isConnected = false;
let isPttActive = false;
let agentIdentity = null;

// Group learner segments into a single turn element
let currentLearnerTurn = null;
let learnerSegmentTexts = new Map();

// Track tutor segments by ID for interim updates
const segmentElements = new Map();

// ── Connect ─────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async() => {
    if (isConnected) return;

    connectBtn.textContent = 'Connecting...';
    connectBtn.disabled = true;

    try {
        const resp = await fetch(
            `/api/token?room=${ROOM_NAME}&identity=${PARTICIPANT_IDENTITY}`,
        );
        const { token, url } = await resp.json();

        room = new LivekitClient.Room({
            audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
            adaptiveStream: true,
        });

        setupRoomEvents(room);

        await room.connect(url, token);

        try {
            await room.localParticipant.setMicrophoneEnabled(true);
        } catch (micErr) {
            console.warn('Microphone not available:', micErr);
        }

        isConnected = true;
        connectBtn.textContent = 'Connected';
        connectBtn.classList.add('connected');
        connectionStatusEl.textContent = 'Connected';
        connectionStatusEl.classList.add('connected');
        pttBtn.disabled = false;
        debugRefreshBtn.disabled = false;
        endSessionBtn.disabled = false;

        // Fetch initial debug snapshot after giving the agent a moment to join
        setTimeout(refreshDebugSnapshot, 2000);
    } catch (err) {
        console.error('Connection failed:', err);
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
        connectionStatusEl.textContent = 'Connection failed';
    }
});

debugRefreshBtn.addEventListener('click', refreshDebugSnapshot);

endSessionBtn.addEventListener('click', async() => {
    if (!isConnected) return;
    const target = findAgentIdentity();
    if (!target) {
        alert('No agent found in room');
        return;
    }

    const confirmed = confirm(
        'End this session and trigger compaction? This will take ~8-15 seconds while Claude Sonnet processes the transcript.',
    );
    if (!confirmed) return;

    endSessionBtn.disabled = true;
    endSessionBtn.classList.add('compacting');
    endSessionBtn.textContent = 'Compacting...';
    pttBtn.disabled = true;

    try {
        const resp = await room.localParticipant.performRpc({
            destinationIdentity: target,
            method: 'end_session',
            payload: '',
            responseTimeout: 60000, // Compaction can take 15+ seconds
        });
        const data = JSON.parse(resp);
        renderCompactionResult(data);

        if (data.ok) {
            // Refresh debug panel to show evolved cores
            await refreshDebugSnapshot();
        }
    } catch (err) {
        console.error('End session failed:', err);
        compactionResultSection.style.display = 'block';
        compactionStatusEl.textContent = `Error: ${err.message || err}`;
    } finally {
        endSessionBtn.classList.remove('compacting');
        endSessionBtn.textContent = 'Ended';
    }
});

// ── Room Events ─────────────────────────────────────────────────────

function setupRoomEvents(room) {
    const RoomEvent = LivekitClient.RoomEvent;

    room.on(RoomEvent.Disconnected, () => {
        isConnected = false;
        pttBtn.disabled = true;
        debugRefreshBtn.disabled = true;
        endSessionBtn.disabled = true;
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
        connectBtn.classList.remove('connected');
        connectionStatusEl.textContent = 'Disconnected';
        connectionStatusEl.classList.remove('connected');
        agentStateEl.textContent = 'Disconnected';
        agentStateEl.className = '';
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (participant.attributes && participant.attributes['lk.agent.state']) {
            agentIdentity = participant.identity;
            updateAgentState(participant.attributes['lk.agent.state']);
            // Auto-refresh debug when agent joins
            setTimeout(refreshDebugSnapshot, 500);
        }
    });

    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        if (changed['lk.agent.state']) {
            agentIdentity = participant.identity;
            updateAgentState(changed['lk.agent.state']);
        }
    });

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === 'audio') {
            const el = track.attach();
            el.id = `audio-${participant.identity}`;
            document.body.appendChild(el);
            console.log('Audio track attached for', participant.identity);
        }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind === 'audio') {
            track.detach().forEach((el) => el.remove());
        }
    });

    room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        const isAgent =
            participant && participant.identity !== PARTICIPANT_IDENTITY;

        for (const segment of segments) {
            if (isAgent) {
                updateTutorSegment(segment.id, segment.text, segment.final);
            } else {
                updateLearnerSegment(segment.id, segment.text, segment.final);
            }
        }
    });

    room.on(RoomEvent.Connected, () => {
        for (const [, participant] of room.remoteParticipants) {
            if (participant.attributes && participant.attributes['lk.agent.state']) {
                agentIdentity = participant.identity;
                updateAgentState(participant.attributes['lk.agent.state']);
                break;
            }
        }
    });
}

// ── Push-to-Talk ────────────────────────────────────────────────────

async function pttStart() {
    if (!isConnected || isPttActive) return;
    isPttActive = true;
    pttBtn.classList.add('active');
    pttBtn.textContent = 'Listening...';

    currentLearnerTurn = document.createElement('div');
    currentLearnerTurn.className = 'transcript-entry learner interim';
    currentLearnerTurn.innerHTML =
        '<div class="speaker">You</div><div class="text"></div>';
    transcriptPanel.appendChild(currentLearnerTurn);
    learnerSegmentTexts.clear();

    const target = findAgentIdentity();
    if (!target) {
        console.warn('No agent found in room');
        return;
    }

    try {
        await room.localParticipant.performRpc({
            destinationIdentity: target,
            method: 'ptt_start',
            payload: '',
        });
    } catch (err) {
        console.error('RPC ptt_start failed:', err);
    }
}

async function pttEnd() {
    if (!isPttActive) return;
    isPttActive = false;
    pttBtn.classList.remove('active');
    pttBtn.textContent = 'Hold to Speak';

    if (currentLearnerTurn) {
        currentLearnerTurn.classList.remove('interim');
        const text = currentLearnerTurn.querySelector('.text').textContent;
        if (!text.trim()) {
            currentLearnerTurn.remove();
        }
        currentLearnerTurn = null;
    }

    const target = findAgentIdentity();
    if (!target) return;

    try {
        await room.localParticipant.performRpc({
            destinationIdentity: target,
            method: 'ptt_end',
            payload: '',
        });
        // Auto-refresh debug panel after each turn to show updated metrics
        setTimeout(refreshDebugSnapshot, 500);
    } catch (err) {
        console.error('RPC ptt_end failed:', err);
    }
}

pttBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    pttStart();
});
pttBtn.addEventListener('mouseup', (e) => {
    e.preventDefault();
    pttEnd();
});
pttBtn.addEventListener('mouseleave', () => {
    if (isPttActive) pttEnd();
});

pttBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    pttStart();
});
pttBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    pttEnd();
});
pttBtn.addEventListener('touchcancel', () => {
    if (isPttActive) pttEnd();
});

// ── Debug Panel ─────────────────────────────────────────────────────

async function refreshDebugSnapshot() {
    if (!isConnected) return;
    const target = findAgentIdentity();
    if (!target) {
        console.warn('Cannot refresh debug: no agent in room yet');
        return;
    }

    try {
        const resp = await room.localParticipant.performRpc({
            destinationIdentity: target,
            method: 'debug_snapshot',
            payload: '',
        });
        const data = JSON.parse(resp);
        renderDebugPanel(data);
    } catch (err) {
        console.error('Debug snapshot failed:', err);
    }
}

function renderDebugPanel(data) {
    // Metrics
    const durationSec = Math.floor(
        (Date.now() - new Date(data.sessionStartedAt).getTime()) / 1000,
    );
    debugMetricsEl.textContent =
        `Learner ID: ${data.learnerId.slice(0, 8)}...\n` +
        `Session ID: ${data.sessionId.slice(0, 8)}...\n` +
        `Turn count: ${data.turnCount}\n` +
        `Duration: ${durationSec}s`;

    // FSRS items
    fsrsCountEl.textContent = `(${data.fsrsDueItems.length})`;
    if (data.fsrsDueItems.length === 0) {
        debugFsrsEl.textContent = 'No items due';
    } else {
        debugFsrsEl.innerHTML = data.fsrsDueItems
            .map(
                (i) =>
                `<div class="fsrs-item"><span class="fsrs-key">${escapeHtml(i.item_key)}</span>` +
                (i.item_context ?
                    `<div class="fsrs-context">${escapeHtml(i.item_context)}</div>` :
                    '') +
                `</div>`,
            )
            .join('');
    }

    // Learner core
    learnerVersionEl.textContent = `v${data.learnerCore.version}`;
    debugLearnerEl.textContent = JSON.stringify(data.learnerCore, null, 2);

    // Tutor core
    tutorVersionEl.textContent = `v${data.tutorCore.version}`;
    debugTutorEl.textContent = JSON.stringify(data.tutorCore, null, 2);

    // System prompt
    debugPromptEl.textContent = data.systemPrompt;
}

function renderCompactionResult(data) {
    compactionResultSection.style.display = 'block';

    if (!data.ok) {
        compactionStatusEl.textContent = `Failed: ${data.error || 'unknown error'}`;
        return;
    }

    compactionStatusEl.innerHTML =
        `<div><span class="diff-field">Duration:</span> ${(data.durationMs / 1000).toFixed(1)}s</div>` +
        `<div><span class="diff-field">FSRS created:</span> ${data.fsrsCreated}</div>` +
        `<div><span class="diff-field">FSRS rated:</span> ${data.fsrsRated}</div>` +
        `<div style="margin-top: 6px;"><span class="diff-field">Compaction notes:</span></div>` +
        `<div style="margin-top: 2px; color: #ccc;">${escapeHtml(data.compactionNotes)}</div>`;

    // Render a focused diff for the fields that matter most
    const diffs = [];
    const pre = data.preCores;
    const post = data.postCores;

    diffs.push(
        makeDiff(
            'Learner version',
            pre.learner.version,
            post.learner.version,
        ),
    );
    diffs.push(
        makeDiff(
            'Tutor version',
            pre.tutor.version,
            post.tutor.version,
        ),
    );
    diffs.push(
        makeDiff(
            'CEFR level',
            pre.learner.proficiency?.cefr_level,
            post.learner.proficiency?.cefr_level,
        ),
    );
    diffs.push(
        makeDiff(
            'Interests',
            JSON.stringify(pre.learner.learning_profile?.interests || []),
            JSON.stringify(post.learner.learning_profile?.interests || []),
        ),
    );
    diffs.push(
        makeDiff(
            'Active vocab',
            pre.learner.vocabulary?.active_count,
            post.learner.vocabulary?.active_count,
        ),
    );
    diffs.push(
        makeDiff(
            'Comfort zones',
            JSON.stringify(pre.learner.vocabulary?.comfort_zones || []),
            JSON.stringify(post.learner.vocabulary?.comfort_zones || []),
        ),
    );
    diffs.push(
        makeDiff(
            'Session trajectory',
            pre.learner.session_trajectory,
            post.learner.session_trajectory,
        ),
    );
    diffs.push(
        makeDiff(
            'Teaching narrative',
            pre.tutor.teaching_narrative,
            post.tutor.teaching_narrative,
        ),
    );

    compactionDiffEl.innerHTML = diffs.join('');

    // FSRS updates
    if (data.fsrsUpdates && data.fsrsUpdates.length > 0) {
        compactionFsrsEl.textContent = data.fsrsUpdates
            .map((u) => {
                    if (u.action === 'create') {
                        return `+ CREATE ${u.item_key}${u.context ? ` (${u.context})` : ''}`;
        } else {
          return `~ RATE ${u.item_key} = ${u.rating}`;
        }
      })
      .join('\n');
  } else {
    compactionFsrsEl.textContent = 'No FSRS updates';
  }
}

function makeDiff(field, oldVal, newVal) {
  const same = JSON.stringify(oldVal) === JSON.stringify(newVal);
  if (same) {
    return `<div class="diff-entry"><span class="diff-field">${field}:</span> <span style="color:#888;">${escapeHtml(String(oldVal ?? '—')).slice(0, 120)}</span></div>`;
  }
  return (
    `<div class="diff-entry"><span class="diff-field">${field}</span>` +
    `<span class="diff-old">${escapeHtml(String(oldVal ?? '—')).slice(0, 200)}</span>` +
    `<span class="diff-new">${escapeHtml(String(newVal ?? '—')).slice(0, 200)}</span></div>`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Helpers ─────────────────────────────────────────────────────────

function findAgentIdentity() {
  if (agentIdentity) return agentIdentity;
  if (!room) return null;

  for (const [, participant] of room.remoteParticipants) {
    if (participant.attributes && participant.attributes['lk.agent.state']) {
      agentIdentity = participant.identity;
      return agentIdentity;
    }
  }
  return null;
}

function updateAgentState(state) {
  const labels = {
    initializing: 'Initializing...',
    idle: 'Ready',
    listening: 'Listening',
    thinking: 'Thinking...',
    speaking: 'Speaking',
  };
  agentStateEl.textContent = labels[state] || state;
  agentStateEl.className = `state-${state}`;
}

function updateTutorSegment(segmentId, text, isFinal) {
  let el = segmentElements.get(segmentId);

  if (!el) {
    el = document.createElement('div');
    el.className = 'transcript-entry tutor interim';
    el.innerHTML = '<div class="speaker">Sofia</div><div class="text"></div>';
    transcriptPanel.appendChild(el);
    segmentElements.set(segmentId, el);
  }

  el.querySelector('.text').textContent = text;

  if (isFinal) {
    el.classList.remove('interim');
  }

  transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
}

function updateLearnerSegment(segmentId, text, isFinal) {
  learnerSegmentTexts.set(segmentId, text);

  if (currentLearnerTurn) {
    const combined = Array.from(learnerSegmentTexts.values()).join(' ');
    currentLearnerTurn.querySelector('.text').textContent = combined;
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  }
}
