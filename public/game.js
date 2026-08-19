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
    board: null,
    phase: 'idle',
    players: [],
    picks: {},
    myPick: null,
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

  socket.on('round:start', ({ round, board, pickTimeMs, players }) => {
    state.board = board;
    state.phase = 'pick';
    state.picks = {};
    state.myPick = null;
    state.players = players;
    state.descentResults = null;
    el('roundLabel').textContent = round;
    el('phaseLabel').textContent = '레인을 선택하세요';
    show(gameSec);
    startPickTimer(pickTimeMs);
    drawBoard();
    renderPlayers();
  });

  let pickTimerInterval = null;
  function startPickTimer(ms) {
    clearInterval(pickTimerInterval);
    const end = Date.now() + ms;
    pickTimerInterval = setInterval(() => {
      const left = Math.max(0, end - Date.now());
      el('timerLabel').textContent = (left / 1000).toFixed(1) + 's';
      if (left <= 0) clearInterval(pickTimerInterval);
    }, 100);
  }

  socket.on('pick:update', ({ playerId, lane }) => {
    state.picks[playerId] = lane;
    drawBoard();
  });

  socket.on('round:descent', ({ picks, bombs, items, results, descentTimeMs }) => {
    clearInterval(pickTimerInterval);
    state.phase = 'descent';
    state.picks = picks;
    state.board.bombs = bombs;
    state.board.items = items;
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
      return `<div>${p.name}${p.isAI ? ' (AI)' : ''} - ${status}${pickLane !== undefined ? ` [레인 ${pickLane + 1}]` : ''}</div>`;
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
    ctx.strokeStyle = '#3a4080';
    ctx.lineWidth = 3;

    const topY = rowY(-1, board.rows);
    const bottomY = rowY(board.rows - 1, board.rows);

    for (let lane = 0; lane < board.lanes; lane++) {
      const x = laneX(lane, board.lanes);
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x, bottomY);
      ctx.stroke();
    }

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

    // items (only visible spot markers, not revealed as items until game shows them post-round)
    if (state.phase === 'descent' && board.items) {
      board.items.forEach((it) => {
        const y = rowY(it.row, board.rows);
        const x = (laneX(it.lane, board.lanes) + laneX(it.lane + 1, board.lanes)) / 2;
        ctx.fillStyle = '#4ee1a0';
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // bombs at bottom (revealed only during/after descent)
    if (state.phase === 'descent' && board.bombs) {
      board.bombs.forEach((lane) => {
        const x = laneX(lane, board.lanes);
        ctx.fillStyle = '#ff4d4d';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('💣', x, bottomY + 24);
      });
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
      // clickable hint circles
      for (let lane = 0; lane < board.lanes; lane++) {
        const x = laneX(lane, board.lanes);
        ctx.strokeStyle = '#5cc8ff88';
        ctx.beginPath();
        ctx.arc(x, topY - 10, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  canvas.addEventListener('click', (e) => {
    if (state.phase !== 'pick' || !state.board) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
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
      const a = path[idx];
      const b = path[Math.min(idx + 1, path.length - 1)];
      const ax = laneX(a.lane, board.lanes);
      const ay = rowY(a.row, board.rows);
      const bx = laneX(b.lane, board.lanes);
      const by = rowY(b.row, board.rows);
      const x = ax + (bx - ax) * frac;
      const y = ay + (by - ay) * frac;

      const mine = r.playerId === state.myId;
      ctx.fillStyle = mine ? '#5cc8ff' : '#ff9f5c';
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
