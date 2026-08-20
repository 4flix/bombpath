(() => {
  const socket = io();
  const el = (id) => document.getElementById(id);

  const screens = { menu: el('menu'), lobby: el('lobby'), game: el('game'), result: el('result') };
  function show(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  const minimap = el('minimap');
  const mctx = minimap.getContext('2d');

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const CELL = 40;
  const TILE_COLOR = {
    0: '#2c6e3f', // grass
    1: '#4a4f5c', // road
    2: '#6b5334', // mud
    3: '#2a5a8c', // water
    4: '#3a3a44', // rock
  };
  const CAR_COLORS = {
    speed: '#4fd1ff', power: '#ff5c5c', tank: '#7CFC98', balanced: '#ffd166',
  };

  let myId = null;
  let world = { grid: null, w: 0, h: 0 };
  let latest = { players: [], cars: [], zone: null };
  let feedEl = el('feed');

  el('btnJoin').addEventListener('click', () => {
    const name = el('nameInput').value.trim() || '플레이어';
    socket.emit('lobby:join', { name });
  });

  el('btnBackToMenu').addEventListener('click', () => location.reload());

  socket.on('connect', () => { myId = socket.id; });

  socket.on('lobby:joined', () => show('lobby'));

  let lobbyTimerInterval = null;
  socket.on('lobby:update', ({ players, max, deadline }) => {
    el('lobbyCount').textContent = players.length;
    el('lobbyMax').textContent = max;
    el('lobbyList').innerHTML = players.map((p) => `<li>${p.name}</li>`).join('');
    clearInterval(lobbyTimerInterval);
    lobbyTimerInterval = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      el('lobbyTimer').textContent = left;
    }, 250);
  });

  socket.on('match:start', ({ grid, worldW, worldH, zone }) => {
    clearInterval(lobbyTimerInterval);
    world = { grid, w: worldW, h: worldH };
    latest.zone = zone;
    show('game');
    el('dropOverlay').classList.remove('hidden');
    el('statusText').textContent = '도보 이동 중 — 자동차를 찾으세요!';
    setTimeout(() => el('dropOverlay').classList.add('hidden'), 1600);
    requestAnimationFrame(renderLoop);
  });

  socket.on('state', (snapshot) => {
    latest = snapshot;
    const me = snapshot.players.find((p) => p.id === myId);
    if (me) {
      const pct = Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100));
      el('hpBar').style.width = pct + '%';
      el('hpBar').style.background = pct < 30 ? 'linear-gradient(90deg,#ff5c5c,#ff9f5c)' : 'linear-gradient(90deg,#4ee1a0,#7CFC98)';
      el('hpText').textContent = `${Math.max(0, Math.round(me.hp))} / ${me.maxHp}`;
      el('statusText').textContent = me.alive
        ? (me.inCar ? '' : '도보 이동 중 — 자동차를 찾으세요!')
        : '탈락했습니다 — 관전 중';
    }
  });

  socket.on('feed', ({ text, kind }) => {
    const div = document.createElement('div');
    div.className = 'feed-item' + (kind === 'pickup' ? ' pickup' : '');
    div.textContent = text;
    feedEl.appendChild(div);
    setTimeout(() => div.remove(), 5000);
  });

  socket.on('match:end', ({ winner, standings }) => {
    show('result');
    el('resultTitle').textContent = winner
      ? (winner.id === myId ? '🏆 우승했습니다!' : `${winner.name}님이 우승했습니다`)
      : '무승부';
    el('standingsList').innerHTML = standings.map((p) => (
      `<li class="${p.alive ? '' : 'dead'}">${p.name}${p.id === myId ? ' (나)' : ''} - 처치 ${p.kills}</li>`
    )).join('');
  });

  // ---------- input: keyboard + on-screen virtual joystick, merged ----------
  const keyInput = { up: false, down: false, left: false, right: false };
  const joyInput = { up: false, down: false, left: false, right: false };
  const KEY_MAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    const k = KEY_MAP[e.code];
    if (k) { keyInput[k] = true; }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEY_MAP[e.code];
    if (k) { keyInput[k] = false; }
  });

  const joyBase = el('joystickBase');
  const joyKnob = el('joystickKnob');
  let joyPointerId = null;
  const JOY_DEADZONE = 0.25;

  function resetJoystick() {
    joyPointerId = null;
    joyInput.up = joyInput.down = joyInput.left = joyInput.right = false;
    joyKnob.style.transform = 'translate(0, 0)';
  }

  function updateJoystickFromEvent(clientX, clientY) {
    const rect = joyBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = rect.width / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxR) { dx = (dx / dist) * maxR; dy = (dy / dist) * maxR; }
    joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / maxR;
    const ny = dy / maxR;
    joyInput.up = ny < -JOY_DEADZONE;
    joyInput.down = ny > JOY_DEADZONE;
    joyInput.left = nx < -JOY_DEADZONE;
    joyInput.right = nx > JOY_DEADZONE;
  }

  joyBase.addEventListener('pointerdown', (e) => {
    joyPointerId = e.pointerId;
    joyBase.setPointerCapture(e.pointerId);
    updateJoystickFromEvent(e.clientX, e.clientY);
  });
  joyBase.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyPointerId) return;
    updateJoystickFromEvent(e.clientX, e.clientY);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
    joyBase.addEventListener(evt, (e) => {
      if (e.pointerId !== joyPointerId) return;
      resetJoystick();
    });
  });

  setInterval(() => {
    if (!world.grid) return;
    socket.emit('input', {
      up: keyInput.up || joyInput.up,
      down: keyInput.down || joyInput.down,
      left: keyInput.left || joyInput.left,
      right: keyInput.right || joyInput.right,
    });
  }, 50);

  function renderLoop() {
    draw();
    requestAnimationFrame(renderLoop);
  }

  function draw() {
    if (!world.grid) return;
    const me = latest.players.find((p) => p.id === myId) || latest.players[0];
    const camX = (me ? me.x : world.w / 2) - canvas.width / 2;
    const camY = (me ? me.y : world.h / 2) - canvas.height / 2;

    ctx.fillStyle = '#0a0c17';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawTerrain(camX, camY);
    drawZone(camX, camY);
    drawCars(camX, camY);
    drawPlayers(camX, camY);
    drawMinimap();
  }

  function drawTerrain(camX, camY) {
    const startCol = Math.max(0, Math.floor(camX / CELL));
    const endCol = Math.min(world.grid[0].length, Math.ceil((camX + canvas.width) / CELL));
    const startRow = Math.max(0, Math.floor(camY / CELL));
    const endRow = Math.min(world.grid.length, Math.ceil((camY + canvas.height) / CELL));
    for (let r = startRow; r < endRow; r++) {
      for (let c = startCol; c < endCol; c++) {
        ctx.fillStyle = TILE_COLOR[world.grid[r][c]] || '#2c6e3f';
        ctx.fillRect(c * CELL - camX, r * CELL - camY, CELL + 1, CELL + 1);
      }
    }
  }

  function drawZone(camX, camY) {
    if (!latest.zone) return;
    const { cx, cy, radius } = latest.zone;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.arc(cx - camX, cy - camY, radius, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(120, 20, 20, 0.35)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx - camX, cy - camY, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#5cc8ff';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawCars(camX, camY) {
    latest.cars.forEach((c) => {
      const x = c.x - camX;
      const y = c.y - camY;
      if (x < -40 || x > canvas.width + 40 || y < -40 || y > canvas.height + 40) return;
      drawCarShape(x, y, c.angle || 0, CAR_COLORS[c.type] || '#fff', 16, 1);
    });
  }

  function drawPlayers(camX, camY) {
    latest.players.forEach((p) => {
      if (!p.alive) return;
      const x = p.x - camX;
      const y = p.y - camY;
      if (x < -60 || x > canvas.width + 60 || y < -60 || y > canvas.height + 60) return;
      const mine = p.id === myId;
      if (p.inCar) {
        drawCarShape(x, y, p.angle, CAR_COLORS[p.carType] || '#fff', 16, mine ? 1 : 0.9, mine);
      } else {
        ctx.beginPath();
        ctx.fillStyle = mine ? '#5cc8ff' : '#ffb85c';
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, x, y - 24);

      // mini hp bar
      const w = 30;
      ctx.fillStyle = '#00000088';
      ctx.fillRect(x - w / 2, y - 20, w, 4);
      ctx.fillStyle = p.hp / p.maxHp < 0.3 ? '#ff5c5c' : '#4ee1a0';
      ctx.fillRect(x - w / 2, y - 20, w * Math.max(0, p.hp / p.maxHp), 4);
    });
  }

  function drawCarShape(x, y, angle, color, size, alpha, highlight) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.6);
    ctx.lineTo(-size * 0.4, 0);
    ctx.lineTo(-size * 0.7, -size * 0.6);
    ctx.closePath();
    ctx.fill();
    if (highlight) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawMinimap() {
    mctx.clearRect(0, 0, minimap.width, minimap.height);
    const sx = minimap.width / world.w;
    const sy = minimap.height / world.h;
    mctx.fillStyle = '#12162a';
    mctx.fillRect(0, 0, minimap.width, minimap.height);
    if (latest.zone) {
      mctx.beginPath();
      mctx.arc(latest.zone.cx * sx, latest.zone.cy * sy, latest.zone.radius * sx, 0, Math.PI * 2);
      mctx.strokeStyle = '#5cc8ff';
      mctx.lineWidth = 2;
      mctx.stroke();
    }
    latest.players.forEach((p) => {
      if (!p.alive) return;
      mctx.fillStyle = p.id === myId ? '#5cc8ff' : '#ff9f5c';
      mctx.beginPath();
      mctx.arc(p.x * sx, p.y * sy, p.id === myId ? 3 : 2, 0, Math.PI * 2);
      mctx.fill();
    });
  }
})();
