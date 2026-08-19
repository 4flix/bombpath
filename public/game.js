(() => {
  const socket = io();

  const el = (id) => document.getElementById(id);
  const menu = el('menu');
  const waiting = el('waiting');
  const gameSec = el('game');
  const resultSec = el('result');
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');

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
    animStart: 0,
    animDuration: 0,
  };

  function show(section) {
    [menu, waiting, gameSec, resultSec].forEach((s) => s.classList.add('hidden'));
    section.classList.remove('hidden');
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
    phaseTimerInterval = setInterval(() => {
      const left = Math.max(0, end - Date.now());
      el('timerLabel').textContent = (left / 1000).toFixed(1) + 's';
      if (left <= 0) clearInterval(phaseTimerInterval);
    }, 100);
  }

  socket.on('pick:update', ({ playerId, lane }) => {
    state.picks[playerId] = lane;
    drawBoard();
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
    state.animStart = performance.now();
    state.animDuration = descentTimeMs;
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
    } else {
      el('resultTitle').textContent = `${winner.isAI ? 'AI' : winner.name}가 승리했습니다`;
    }
  });

  function renderPlayers() {
    const box = el('players');
    box.innerHTML = state.players.map((p) => {
      const pickLane = state.picks[p.id];
      const status = p.alive ? '생존' : '탈락';
      const placerTag = p.id === state.placerId ? ' 💣배치' : '';
      return `<div>${p.name}${p.isAI ? ' (AI)' : ''} - ${status}${placerTag}${pickLane !== undefined ? ` [레인 ${pickLane + 1}]` : ''}</div>`;
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
      socket.emit('pick:lane', { code: state.code, lane: closest });
      drawBoard();
    }
  });

  function animateDescent(now) {
    const board = state.board;
    const t = Math.min(1, (now - state.animStart) / state.animDuration);
    drawBoard();

    state.descentResults.forEach((r) => {
      const path = r.path; // [{row:-1,lane}, {row:0,lane}, ...]
      const idxFloat = t * (path.length - 1);
      const idx = Math.floor(idxFloat);
      const frac = idxFloat - idx;
      const mine = r.playerId === state.myId;
      const color = mine ? '#5cc8ff' : '#ff9f5c';

      // trail: the path already walked, up to the current interpolated point
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i <= idx; i++) {
        const px = laneX(path[i].lane, board.lanes);
        const py = rowY(path[i].row, board.rows);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      const a = path[idx];
      const b = path[Math.min(idx + 1, path.length - 1)];
      const ax = laneX(a.lane, board.lanes);
      const ay = rowY(a.row, board.rows);
      const bx = laneX(b.lane, board.lanes);
      const by = rowY(b.row, board.rows);
      const x = ax + (bx - ax) * frac;
      const y = ay + (by - ay) * frac;
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    if (t < 1) {
      requestAnimationFrame(animateDescent);
    } else {
      state.descentResults.forEach((r) => {
        if (r.died) {
          el('phaseLabel').textContent = '결과 확인 중...';
        }
      });
    }
  }
})();
