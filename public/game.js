(() => {
  const socket = io();

  const el = (id) => document.getElementById(id);
  const menu = el('menu');
  const waiting = el('waiting');
  const gameSec = el('game');
  const resultSec = el('result');
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = el('canvasWrap');
  const countdownOverlay = el('countdownOverlay');
  const popText = el('popText');
  const flashOverlay = el('flashOverlay');

  let state = {
    code: null,
    myId: null,
    board: null, // { lanes, rows, rungs? (only known from round:descent onward) }
    phase: 'idle',
    players: [],
    picks: {},
    myPick: null,
    placerId: null,
    bombCount: 5,
    selectedBombs: [],
    descentResults: null,
    timelines: null,
    animStart: 0,
    animDuration: 0,
    streaks: {},
  };

  function show(section) {
    [menu, waiting, gameSec, resultSec].forEach((s) => s.classList.add('hidden'));
    section.classList.remove('hidden');
  }

  // ---------- tiny WebAudio sound synth (no external assets needed) ----------
  let audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function beep({ freq = 440, dur = 0.12, type = 'sine', gain = 0.2, glideTo = null, delay = 0 }) {
    try {
      const ctxA = ac();
      const osc = ctxA.createOscillator();
      const g = ctxA.createGain();
      osc.type = type;
      const t0 = ctxA.currentTime + delay;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g).connect(ctxA.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { /* audio not available, ignore */ }
  }
  function sfxClick() { beep({ freq: 520, dur: 0.06, type: 'square', gain: 0.12 }); }
  function sfxPlace() { beep({ freq: 300, dur: 0.08, type: 'triangle', gain: 0.15 }); }
  function sfxTick() { beep({ freq: 880, dur: 0.05, type: 'square', gain: 0.08 }); }
  function sfxCountdown() { beep({ freq: 440, dur: 0.15, type: 'square', gain: 0.18 }); }
  function sfxGo() { beep({ freq: 660, dur: 0.25, type: 'square', gain: 0.22, glideTo: 990 }); }
  function sfxExplosion() {
    try {
      const ctxA = ac();
      const bufferSize = ctxA.sampleRate * 0.35;
      const buffer = ctxA.createBuffer(1, bufferSize, ctxA.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = ctxA.createBufferSource();
      noise.buffer = buffer;
      const g = ctxA.createGain();
      g.gain.setValueAtTime(0.4, ctxA.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctxA.currentTime + 0.35);
      const filter = ctxA.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1200, ctxA.currentTime);
      noise.connect(filter).connect(g).connect(ctxA.destination);
      noise.start();
    } catch (e) { /* ignore */ }
  }
  function sfxSafe() { beep({ freq: 660, dur: 0.18, type: 'sine', gain: 0.2, glideTo: 990 }); }
  function sfxShield() { beep({ freq: 380, dur: 0.2, type: 'sine', gain: 0.2, glideTo: 700 }); }
  function sfxBounce() { beep({ freq: 500, dur: 0.1, type: 'triangle', gain: 0.15, glideTo: 300 }); }
  function sfxWin() {
    [523, 659, 784, 1046].forEach((f, i) => beep({ freq: f, dur: 0.3, type: 'square', gain: 0.18, delay: i * 0.12 }));
  }
  function sfxLose() {
    [400, 320, 240].forEach((f, i) => beep({ freq: f, dur: 0.3, type: 'sawtooth', gain: 0.15, delay: i * 0.12 }));
  }

  function flash(kind) {
    flashOverlay.className = '';
    void flashOverlay.offsetWidth; // restart animation
    flashOverlay.className = 'flash-' + kind;
  }

  function shakeScreen() {
    canvasWrap.classList.remove('shake');
    void canvasWrap.offsetWidth;
    canvasWrap.classList.add('shake');
  }

  function showPop(text, color) {
    popText.textContent = text;
    popText.style.color = color || '#fff';
    popText.classList.remove('hidden');
    void popText.offsetWidth;
    popText.classList.remove('hidden');
    popText.style.animation = 'none';
    void popText.offsetWidth;
    popText.style.animation = '';
  }

  el('btnVsAI').addEventListener('click', () => {
    const name = el('nameInput').value.trim() || '플레이어';
    socket.emit('room:createAI', { name });
  });

  el('btnCreateRoom').addEventListener('click', () => {
    const name = el('nameInput').value.trim() || '플레이어';
    socket.emit('room:create', { name });
  });

  el('btnJoinRoom').addEventListener('click', () => {
    const name = el('nameInput').value.trim() || '플레이어';
    const code = el('joinCodeInput').value.trim().toUpperCase();
    if (!code) return;
    socket.emit('room:join', { code, name });
  });

  el('btnBackToMenu').addEventListener('click', () => {
    location.reload();
  });

  socket.on('connect', () => { state.myId = socket.id; });

  socket.on('room:error', ({ message }) => {
    el('menuMsg').textContent = message;
  });

  socket.on('room:joined', (pub) => {
    state.code = pub.code;
    state.players = pub.players;
    if (pub.players.length < 2) {
      el('roomCodeLabel').textContent = pub.code;
      show(waiting);
    }
  });

  socket.on('room:state', (pub) => {
    state.players = pub.players;
  });

  socket.on('round:start', ({ round, board, placerId, bombCount, bombPlaceTimeMs, players }) => {
    // NOTE: board intentionally has no `rungs` yet — the ladder shape stays
    // hidden until the descent phase so nobody can preview it in advance.
    state.board = { lanes: board.lanes, rows: board.rows, rungs: null, bombs: null, items: null, bounces: null };
    state.phase = 'bombPlace';
    state.picks = {};
    state.myPick = null;
    state.placerId = placerId;
    state.bombCount = bombCount;
    state.selectedBombs = [];
    state.players = players;
    state.descentResults = null;
    countdownOverlay.classList.add('hidden');
    el('roundLabel').textContent = round;
    show(gameSec);

    if (placerId === state.myId) {
      el('phaseLabel').textContent = `폭탄 ${bombCount}개를 배치하세요`;
    } else {
      el('phaseLabel').textContent = '상대가 폭탄을 배치 중입니다...';
    }
    startPhaseTimer(bombPlaceTimeMs);
    drawBoard();
    renderPlayers();
  });

  socket.on('phase:pick', ({ pickTimeMs }) => {
    state.phase = 'pick';
    state.myPick = null;
    el('phaseLabel').textContent = '레인을 선택하세요';
    startPhaseTimer(pickTimeMs);
    drawBoard();
  });

  let phaseTimerInterval = null;
  function startPhaseTimer(ms) {
    clearInterval(phaseTimerInterval);
    const end = Date.now() + ms;
    let tickedUrgent = false;
    phaseTimerInterval = setInterval(() => {
      const left = Math.max(0, end - Date.now());
      const label = el('timerLabel');
      label.textContent = (left / 1000).toFixed(1) + 's';
      if (left <= 3000) {
        label.classList.add('urgent');
        if (!tickedUrgent) { tickedUrgent = true; }
        if (Math.floor(left / 300) !== Math.floor((left + 100) / 300)) sfxTick();
      } else {
        label.classList.remove('urgent');
      }
      if (left <= 0) clearInterval(phaseTimerInterval);
    }, 100);
  }

  socket.on('pick:update', ({ playerId, lane }) => {
    state.picks[playerId] = lane;
    if (playerId !== state.myId) sfxClick();
    drawBoard();
  });

  socket.on('phase:countdown', ({ picks, countdownMs }) => {
    clearInterval(phaseTimerInterval);
    state.phase = 'countdown';
    state.picks = picks;
    el('timerLabel').textContent = '';
    el('phaseLabel').textContent = '곧 하강합니다...';
    drawBoard();

    const steps = ['3', '2', '1', 'GO!'];
    const stepMs = countdownMs / steps.length;
    countdownOverlay.classList.remove('hidden');
    steps.forEach((label, i) => {
      setTimeout(() => {
        countdownOverlay.innerHTML = `<span>${label}</span>`;
        if (label === 'GO!') sfxGo(); else sfxCountdown();
      }, i * stepMs);
    });
    setTimeout(() => countdownOverlay.classList.add('hidden'), countdownMs);
  });

  socket.on('round:descent', ({ picks, rungs, bombs, items, bounces, results, descentTimeMs }) => {
    clearInterval(phaseTimerInterval);
    state.phase = 'descent';
    state.picks = picks;
    state.board.rungs = rungs;
    state.board.bombs = bombs;
    state.board.items = items;
    state.board.bounces = bounces;
    state.descentResults = results;
    state.timelines = {};
    results.forEach((r) => { state.timelines[r.playerId] = buildTimeline(r.path, state.board); });
    state.animStart = performance.now();
    state.animDuration = descentTimeMs;
    descentFinishedHandled = false;
    el('phaseLabel').textContent = '하강 중...';
    el('timerLabel').textContent = '';
    requestAnimationFrame(animateDescent);
    renderPlayers();
  });

  socket.on('game:over', ({ winner }) => {
    show(resultSec);
    if (!winner) {
      el('resultTitle').textContent = '무승부';
    } else if (winner.id === state.myId) {
      el('resultTitle').textContent = '🏆 승리했습니다!';
      sfxWin();
      flash('gold');
    } else {
      el('resultTitle').textContent = `${winner.isAI ? 'AI' : winner.name}가 승리했습니다`;
      sfxLose();
    }
  });

  function renderPlayers() {
    const box = el('players');
    box.innerHTML = state.players.map((p) => {
      const pickLane = state.picks[p.id];
      const status = p.alive ? '생존' : '탈락';
      const placerTag = p.id === state.placerId ? ' 💣배치' : '';
      const streak = state.streaks[p.id] || 0;
      const streakTag = streak >= 2 ? ` <span class="streak">🔥x${streak}</span>` : '';
      const cls = p.alive ? '' : 'dead';
      return `<div class="${cls}">${p.name}${p.isAI ? ' (AI)' : ''} - ${status}${placerTag}${pickLane !== undefined ? ` [레인 ${pickLane + 1}]` : ''}${streakTag}</div>`;
    }).join('');
  }

  function laneX(lane, lanes) {
    const margin = 40;
    const w = canvas.width - margin * 2;
    return margin + (w / (lanes - 1)) * lane;
  }

  function rowY(row, rows) {
    const marginTop = 30;
    const marginBottom = 60;
    const h = canvas.height - marginTop - marginBottom;
    return marginTop + (h / rows) * (row + 1);
  }

  // Build a right-angle movement timeline from a per-row path: at each row
  // where the lane changes, the player drops straight down to that row first,
  // then slides sideways along the rung — never diagonally.
  function buildTimeline(path, board) {
    const steps = path.length - 1;
    const timeline = [];
    let cursor = { x: laneX(path[0].lane, board.lanes), y: rowY(path[0].row, board.rows) };
    for (let i = 1; i < path.length; i++) {
      const t0 = (i - 1) / steps;
      const t1 = i / steps;
      const prevLane = path[i - 1].lane;
      const curLane = path[i].lane;
      const y = rowY(path[i].row, board.rows);
      const vertTarget = { x: laneX(prevLane, board.lanes), y };
      if (curLane === prevLane) {
        timeline.push({ t0, t1, from: cursor, to: vertTarget });
        cursor = vertTarget;
      } else {
        const mid = t0 + (t1 - t0) * 0.5;
        timeline.push({ t0, t1: mid, from: cursor, to: vertTarget });
        const horizTarget = { x: laneX(curLane, board.lanes), y };
        timeline.push({ t0: mid, t1, from: vertTarget, to: horizTarget });
        cursor = horizTarget;
      }
    }
    return timeline;
  }

  function positionAt(timeline, t) {
    let seg = timeline[timeline.length - 1];
    for (const s of timeline) {
      if (t <= s.t1 || s === timeline[timeline.length - 1]) { seg = s; break; }
    }
    const span = seg.t1 - seg.t0 || 1;
    const frac = Math.max(0, Math.min(1, (t - seg.t0) / span));
    return {
      x: seg.from.x + (seg.to.x - seg.from.x) * frac,
      y: seg.from.y + (seg.to.y - seg.from.y) * frac,
    };
  }

  function drawBoard() {
    const board = state.board;
    if (!board) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const topY = rowY(-1, board.rows);
    const bottomY = rowY(board.rows - 1, board.rows);

    // vertical lanes are always visible
    ctx.strokeStyle = '#3a4080';
    ctx.lineWidth = 3;
    for (let lane = 0; lane < board.lanes; lane++) {
      const x = laneX(lane, board.lanes);
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x, bottomY);
      ctx.stroke();
    }

    // the ladder's rungs stay hidden until the descent phase reveals them
    if (board.rungs) {
      ctx.strokeStyle = '#565da8';
      board.rungs.forEach((row, r) => {
        row.forEach((connected, i) => {
          if (!connected) return;
          const y = rowY(r, board.rows);
          ctx.beginPath();
          ctx.moveTo(laneX(i, board.lanes), y);
          ctx.lineTo(laneX(i + 1, board.lanes), y);
          ctx.stroke();
        });
      });
    }

    // items (revealed alongside the ladder, at descent time)
    if (board.items) {
      board.items.forEach((it) => {
        const y = rowY(it.row, board.rows);
        const x = (laneX(it.lane, board.lanes) + laneX(it.lane + 1, board.lanes)) / 2;
        ctx.fillStyle = '#4ee1a0';
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // bounce pads (revealed alongside the ladder, at descent time)
    if (board.bounces) {
      board.bounces.forEach((b) => {
        const x = laneX(b.lane, board.lanes);
        const y = rowY(b.row, board.rows);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(-6, -6, 12, 12);
        ctx.restore();
      });
    }

    // bombs at bottom (revealed only during/after descent, or preview of my own placement)
    if (board.bombs) {
      board.bombs.forEach((lane) => {
        const x = laneX(lane, board.lanes);
        ctx.fillStyle = '#ff4d4d';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('💣', x, bottomY + 24);
      });
    }

    if (state.phase === 'bombPlace') {
      drawBombSlots(bottomY);
    }

    // lane pick markers (top)
    Object.entries(state.picks).forEach(([pid, lane]) => {
      const x = laneX(lane, board.lanes);
      const mine = pid === state.myId;
      ctx.fillStyle = mine ? '#5cc8ff' : '#ff9f5c';
      ctx.beginPath();
      ctx.arc(x, topY - 10, 8, 0, Math.PI * 2);
      ctx.fill();
    });

    if (state.phase === 'pick') {
      for (let lane = 0; lane < board.lanes; lane++) {
        const x = laneX(lane, board.lanes);
        ctx.strokeStyle = '#5cc8ff88';
        ctx.beginPath();
        ctx.arc(x, topY - 10, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawBombSlots(bottomY) {
    const board = state.board;
    const iAmPlacer = state.placerId === state.myId;
    for (let lane = 0; lane < board.lanes; lane++) {
      const x = laneX(lane, board.lanes);
      const selected = state.selectedBombs.includes(lane);
      ctx.beginPath();
      ctx.arc(x, bottomY, 14, 0, Math.PI * 2);
      if (selected) {
        ctx.fillStyle = '#ff4d4d';
        ctx.fill();
      } else {
        ctx.strokeStyle = iAmPlacer ? '#ffd166' : '#4a4f88';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (selected) {
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#1a1a1a';
        ctx.fillText('💣', x, bottomY + 5);
      }
    }
  }

  canvas.addEventListener('click', (e) => {
    if (!state.board) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;

    if (state.phase === 'bombPlace') {
      if (state.placerId !== state.myId) return;
      const bottomY = rowY(state.board.rows - 1, state.board.rows);
      let closest = 0;
      let minDist = Infinity;
      for (let lane = 0; lane < state.board.lanes; lane++) {
        const lx = laneX(lane, state.board.lanes);
        const d = Math.abs(lx - x);
        if (d < minDist) { minDist = d; closest = lane; }
      }
      const idx = state.selectedBombs.indexOf(closest);
      if (idx !== -1) {
        state.selectedBombs.splice(idx, 1);
      } else if (state.selectedBombs.length < state.bombCount) {
        state.selectedBombs.push(closest);
        sfxPlace();
      }
      drawBoard();
      if (state.selectedBombs.length === state.bombCount) {
        socket.emit('bomb:place', { code: state.code, lanes: state.selectedBombs.slice() });
        el('phaseLabel').textContent = '배치 완료! 상대를 기다리는 중...';
      }
      return;
    }

    if (state.phase === 'pick') {
      const topY = rowY(-1, state.board.rows);
      let closest = 0;
      let minDist = Infinity;
      for (let lane = 0; lane < state.board.lanes; lane++) {
        const lx = laneX(lane, state.board.lanes);
        const d = Math.abs(lx - x);
        if (d < minDist) { minDist = d; closest = lane; }
      }
      if (state.myPick !== null) return;
      const takenLanes = new Set(Object.values(state.picks));
      if (takenLanes.has(closest)) return;
      state.myPick = closest;
      state.picks[state.myId] = closest;
      sfxClick();
      socket.emit('pick:lane', { code: state.code, lane: closest });
      drawBoard();
    }
  });

  function animateDescent(now) {
    const t = Math.min(1, (now - state.animStart) / state.animDuration);
    drawBoard();

    state.descentResults.forEach((r) => {
      const timeline = state.timelines[r.playerId];
      const mine = r.playerId === state.myId;
      const color = mine ? '#5cc8ff' : '#ff9f5c';
      const pos = positionAt(timeline, t);

      // trail: every fully-walked segment, plus the partial current one
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(timeline[0].from.x, timeline[0].from.y);
      timeline.forEach((seg) => {
        if (t >= seg.t1) {
          ctx.lineTo(seg.to.x, seg.to.y);
        } else if (t > seg.t0) {
          ctx.lineTo(pos.x, pos.y);
        }
      });
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    if (t < 1) {
      requestAnimationFrame(animateDescent);
    } else {
      onDescentFinished();
    }
  }

  let descentFinishedHandled = false;

  function onDescentFinished() {
    if (descentFinishedHandled) return;
    descentFinishedHandled = true;

    const myResult = state.descentResults.find((r) => r.playerId === state.myId);
    let anyDied = false;
    let anyShieldBlock = false;
    let anyCloseCall = false;

    state.descentResults.forEach((r) => {
      if (r.died) anyDied = true;
      if (r.hitBomb && !r.died) anyShieldBlock = true;
      if (r.closeCall) anyCloseCall = true;
      state.streaks[r.playerId] = r.died ? 0 : (state.streaks[r.playerId] || 0) + 1;
    });

    if (myResult) {
      if (myResult.died) {
        flash('red');
        shakeScreen();
        sfxExplosion();
        showPop('💥 탈락!', '#ff5c5c');
      } else if (myResult.hitBomb) {
        flash('gold');
        sfxShield();
        showPop('🛡️ 실드로 방어!', '#ffd166');
      } else if (myResult.closeCall) {
        sfxSafe();
        showPop('😅 아슬아슬!', '#ffd166');
      } else {
        sfxSafe();
        showPop('✅ 생존!', '#4ee1a0');
      }
    } else if (anyDied) {
      shakeScreen();
      sfxExplosion();
    } else if (anyShieldBlock) {
      sfxShield();
    } else if (anyCloseCall) {
      sfxSafe();
    }

    el('phaseLabel').textContent = '결과 확인 중...';
    renderPlayers();
  }
})();
