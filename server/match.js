const {
  WORLD_W, WORLD_H, TICK_MS, DROP_DURATION_MS,
  CAR_TYPES, CAR_TYPE_KEYS, CAR_RADIUS, PED_RADIUS, PED_SPEED, PED_HP, PICKUP_RADIUS,
  FRICTION, MIN_HIT_SPEED, DAMAGE_K, HIT_COOLDOWN_MS, RESTITUTION,
  ZONE_PHASES, ZONE_MIN_RADIUS, ZONE_DAMAGE_BASE,
  MAX_PLAYERS, MIN_PLAYERS_TO_START, LOBBY_WAIT_MS,
} = require('./constants');
const { generateTerrain, tileAt, isBlocked, randomOpenPosition } = require('./terrain');
const { TILE_SPEED } = require('./constants');

let matchCounter = 0;

class Match {
  constructor(io) {
    this.io = io;
    this.id = 'match-' + (++matchCounter);
    this.phase = 'lobby'; // lobby -> dropping -> playing -> ended
    this.players = new Map(); // id -> player
    this.cars = [];
    this.grid = null;
    this.zone = null;
    this.zonePhaseIndex = 0;
    this.zoneTimer = 0;
    this.zoneState = 'hold';
    this.lobbyDeadline = null;
    this.tickHandle = null;
    this.killFeed = [];
  }

  get playerCount() { return this.players.size; }

  addPlayer(socket, name) {
    const player = {
      id: socket.id,
      socket,
      name: (name || 'Player').slice(0, 12),
      alive: true,
      inCar: false,
      carId: null,
      x: 0, y: 0, angle: 0, vx: 0, vy: 0,
      hp: PED_HP,
      maxHp: PED_HP,
      kills: 0,
      input: { up: false, down: false, left: false, right: false },
      placement: null,
    };
    this.players.set(socket.id, player);
    socket.join(this.id);
    if (this.phase === 'lobby' && this.players.size === 1) {
      this.lobbyDeadline = Date.now() + LOBBY_WAIT_MS;
      this.lobbyTimer = setTimeout(() => this.tryStart(true), LOBBY_WAIT_MS);
    }
    this.broadcastLobby();
    if (this.players.size >= MAX_PLAYERS) this.tryStart(true);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.broadcastLobby();
      return;
    }
    player.alive = false;
    player.disconnected = true;
    this.checkWinCondition();
  }

  broadcastLobby() {
    if (this.phase !== 'lobby') return;
    this.io.to(this.id).emit('lobby:update', {
      players: Array.from(this.players.values()).map((p) => ({ id: p.id, name: p.name })),
      max: MAX_PLAYERS,
      deadline: this.lobbyDeadline,
    });
  }

  tryStart(force) {
    if (this.phase !== 'lobby') return;
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    if (this.players.size < MIN_PLAYERS_TO_START) {
      if (!force) return;
      if (this.players.size < 1) return;
    }
    this.startDrop();
  }

  startDrop() {
    this.phase = 'dropping';
    this.grid = generateTerrain();
    // phase-0 circle covers the whole map so nobody eats zone damage before
    // the first shrink — only the map center is safe to use here, an offset
    // center would leave a corner outside the radius from the very start
    const fullRadius = Math.hypot(WORLD_W, WORLD_H) / 2 + 20;
    this.zone = {
      cx: WORLD_W / 2,
      cy: WORLD_H / 2,
      radius: fullRadius,
      targetRadius: fullRadius,
    };
    this.zonePhaseIndex = 0;
    this.zoneState = 'hold';
    this.zoneTimer = ZONE_PHASES[0].holdMs;

    this.players.forEach((p) => {
      const pos = randomOpenPosition(this.grid);
      p.x = pos.x; p.y = pos.y;
      p.vx = 0; p.vy = 0;
      p.angle = Math.random() * Math.PI * 2;
      p.hp = PED_HP; p.maxHp = PED_HP;
      p.alive = true;
      p.inCar = false;
      p.carId = null;
      p.placement = null;
    });

    this.cars = [];
    const carCount = this.players.size + 5;
    for (let i = 0; i < carCount; i++) {
      const typeKey = CAR_TYPE_KEYS[i % CAR_TYPE_KEYS.length];
      const spec = CAR_TYPES[typeKey];
      const pos = randomOpenPosition(this.grid);
      this.cars.push({
        id: 'car-' + i,
        type: typeKey,
        x: pos.x, y: pos.y,
        angle: Math.random() * Math.PI * 2,
        vx: 0, vy: 0,
        hp: spec.durability,
        maxHp: spec.durability,
        claimedBy: null,
      });
    }

    this.io.to(this.id).emit('match:start', {
      grid: this.grid,
      worldW: WORLD_W,
      worldH: WORLD_H,
      cars: this.cars.map((c) => ({ id: c.id, type: c.type, x: c.x, y: c.y })),
      players: Array.from(this.players.values()).map((p) => ({ id: p.id, name: p.name })),
      zone: this.zone,
      dropDurationMs: DROP_DURATION_MS,
    });

    setTimeout(() => this.startPlaying(), DROP_DURATION_MS);
  }

  startPlaying() {
    if (this.phase !== 'dropping') return;
    this.phase = 'playing';
    this.lastTick = Date.now();
    this.hitCooldowns = new Map(); // "a|b" -> timestamp
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return;
    p.input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right,
    };
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    this.updateZone();
    this.players.forEach((p) => { if (p.alive) this.updatePlayer(p, dt); });
    this.resolveCollisions();
    this.applyZoneDamage(dt);
    this.checkWinCondition();
    this.broadcastState();
  }

  updateZone() {
    const phase = ZONE_PHASES[this.zonePhaseIndex];
    if (!phase) return;
    this.zoneTimer -= TICK_MS;
    if (this.zoneState === 'hold') {
      if (this.zoneTimer <= 0) {
        this.zoneState = 'shrink';
        this.zoneTimer = phase.shrinkMs;
        this.zoneShrinkFrom = this.zone.radius;
        this.zoneShrinkTo = Math.max(ZONE_MIN_RADIUS, this.zone.radius * phase.factor);
        // the new circle must stay fully reachable inside the old one, so the
        // center can drift by at most (oldRadius - newRadius)
        const maxDrift = Math.max(0, this.zoneShrinkFrom - this.zoneShrinkTo) * 0.9;
        const driftAngle = Math.random() * Math.PI * 2;
        const driftDist = Math.random() * maxDrift;
        this.zoneNewCenter = {
          cx: Math.max(this.zoneShrinkTo, Math.min(WORLD_W - this.zoneShrinkTo, this.zone.cx + Math.cos(driftAngle) * driftDist)),
          cy: Math.max(this.zoneShrinkTo, Math.min(WORLD_H - this.zoneShrinkTo, this.zone.cy + Math.sin(driftAngle) * driftDist)),
        };
        this.zoneOldCenter = { cx: this.zone.cx, cy: this.zone.cy };
      }
    } else if (this.zoneState === 'shrink') {
      const frac = 1 - Math.max(0, this.zoneTimer) / phase.shrinkMs;
      this.zone.radius = this.zoneShrinkFrom + (this.zoneShrinkTo - this.zoneShrinkFrom) * frac;
      this.zone.cx = this.zoneOldCenter.cx + (this.zoneNewCenter.cx - this.zoneOldCenter.cx) * frac;
      this.zone.cy = this.zoneOldCenter.cy + (this.zoneNewCenter.cy - this.zoneOldCenter.cy) * frac;
      if (this.zoneTimer <= 0) {
        this.zonePhaseIndex += 1;
        this.zoneState = 'hold';
        const next = ZONE_PHASES[this.zonePhaseIndex];
        this.zoneTimer = next ? next.holdMs : 999999;
      }
    }
  }

  updatePlayer(p, dt) {
    const spec = p.inCar ? CAR_TYPES[p.carType] : null;
    const maxSpeed = spec ? spec.maxSpeed : PED_SPEED;
    const accel = spec ? spec.accel : PED_SPEED * 3;
    const turnRate = spec ? spec.turnRate : 5;
    const radius = spec ? CAR_RADIUS : PED_RADIUS;

    if (p.input.left) p.angle -= turnRate * dt;
    if (p.input.right) p.angle += turnRate * dt;

    const tile = tileAt(this.grid, p.x, p.y);
    const terrainMul = spec ? (TILE_SPEED[tile] ?? 1) : 1;

    const forward = { x: Math.cos(p.angle), y: Math.sin(p.angle) };
    if (p.input.up) {
      p.vx += forward.x * accel * terrainMul * dt;
      p.vy += forward.y * accel * terrainMul * dt;
    }
    if (p.input.down) {
      p.vx -= forward.x * accel * 0.6 * terrainMul * dt;
      p.vy -= forward.y * accel * 0.6 * terrainMul * dt;
    }

    const speed = Math.hypot(p.vx, p.vy);
    const cap = maxSpeed * terrainMul;
    if (speed > cap) {
      p.vx = (p.vx / speed) * cap;
      p.vy = (p.vy / speed) * cap;
    }
    p.vx *= FRICTION;
    p.vy *= FRICTION;

    let nx = p.x + p.vx * dt;
    let ny = p.y + p.vy * dt;
    if (!isBlocked(this.grid, nx, p.y)) p.x = nx; else p.vx = 0;
    if (!isBlocked(this.grid, p.x, ny)) p.y = ny; else p.vy = 0;
    p.x = Math.max(radius, Math.min(WORLD_W - radius, p.x));
    p.y = Math.max(radius, Math.min(WORLD_H - radius, p.y));

    if (!p.inCar) {
      const car = this.cars.find((c) => !c.claimedBy && Math.hypot(c.x - p.x, c.y - p.y) < PICKUP_RADIUS);
      if (car) this.enterCar(p, car);
    }
  }

  enterCar(p, car) {
    car.claimedBy = p.id;
    p.inCar = true;
    p.carId = car.id;
    p.carType = car.type;
    const spec = CAR_TYPES[car.type];
    p.hp = spec.durability;
    p.maxHp = spec.durability;
    p.x = car.x; p.y = car.y;
    this.io.to(this.id).emit('feed', { text: `${p.name}님이 ${spec.name}에 탑승했습니다`, kind: 'pickup' });
  }

  resolveCollisions() {
    const alive = Array.from(this.players.values()).filter((p) => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const ra = a.inCar ? CAR_RADIUS : PED_RADIUS;
        const rb = b.inCar ? CAR_RADIUS : PED_RADIUS;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const minDist = ra + rb;
        if (dist >= minDist) continue;

        const nx = dx / dist;
        const ny = dy / dist;

        // pedestrian run over by a car: instant elimination for the pedestrian
        if (a.inCar !== b.inCar) {
          const driver = a.inCar ? a : b;
          const ped = a.inCar ? b : a;
          const closing = Math.hypot(driver.vx, driver.vy);
          if (closing > MIN_HIT_SPEED * 0.5) {
            this.eliminate(ped, driver);
          }
        } else if (a.inCar && b.inCar) {
          this.handleCarCollision(a, b, nx, ny, dist, minDist);
        }

        // positional separation so bodies don't overlap/stack
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
      }
    }
  }

  handleCarCollision(a, b, nx, ny, dist, minDist) {
    const relVx = b.vx - a.vx;
    const relVy = b.vy - a.vy;
    const closingSpeed = -(relVx * nx + relVy * ny);
    if (closingSpeed <= 0) return; // separating, not colliding

    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const last = this.hitCooldowns.get(key) || 0;
    const now = Date.now();

    const specA = CAR_TYPES[a.carType];
    const specB = CAR_TYPES[b.carType];

    if (closingSpeed >= MIN_HIT_SPEED && now - last > HIT_COOLDOWN_MS) {
      this.hitCooldowns.set(key, now);
      const dmgToB = closingSpeed * specA.power * DAMAGE_K;
      const dmgToA = closingSpeed * specB.power * DAMAGE_K;
      this.damage(b, dmgToB, a);
      this.damage(a, dmgToA, b);
    }

    // physics impulse (equal-and-opposite, mass-weighted)
    const massA = specA.mass;
    const massB = specB.mass;
    const impulse = (1 + RESTITUTION) * closingSpeed / (1 / massA + 1 / massB);
    a.vx -= (impulse / massA) * nx;
    a.vy -= (impulse / massA) * ny;
    b.vx += (impulse / massB) * nx;
    b.vy += (impulse / massB) * ny;
  }

  damage(player, amount, source) {
    if (!player.alive || amount <= 0) return;
    player.hp -= amount;
    if (player.hp <= 0) this.eliminate(player, source);
  }

  eliminate(player, source) {
    if (!player.alive) return;
    player.alive = false;
    player.placement = this.aliveCount() ;
    if (source && source.id !== player.id) {
      const killer = this.players.get(source.id);
      if (killer) killer.kills += 1;
    }
    this.io.to(this.id).emit('feed', {
      text: source && source.name ? `${player.name}님이 ${source.name}에게 제거되었습니다` : `${player.name}님이 탈락했습니다`,
      kind: 'kill',
    });
  }

  aliveCount() {
    let n = 0;
    this.players.forEach((p) => { if (p.alive) n += 1; });
    return n;
  }

  applyZoneDamage(dt) {
    const dpsScale = ZONE_DAMAGE_BASE * (1 + this.zonePhaseIndex * 0.6);
    this.players.forEach((p) => {
      if (!p.alive) return;
      const d = Math.hypot(p.x - this.zone.cx, p.y - this.zone.cy);
      if (d > this.zone.radius) {
        this.damage(p, dpsScale * dt, null);
      }
    });
  }

  checkWinCondition() {
    if (this.phase !== 'playing') return;
    const alive = Array.from(this.players.values()).filter((p) => p.alive);
    if (alive.length <= 1) {
      this.phase = 'ended';
      clearInterval(this.tickHandle);
      const winner = alive[0] || null;
      this.io.to(this.id).emit('match:end', {
        winner: winner ? { id: winner.id, name: winner.name, kills: winner.kills } : null,
        standings: Array.from(this.players.values())
          .sort((x, y) => (y.alive - x.alive) || y.kills - x.kills)
          .map((p) => ({ id: p.id, name: p.name, kills: p.kills, alive: p.alive })),
      });
    }
  }

  broadcastState() {
    this.io.to(this.id).emit('state', {
      zone: this.zone,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
        hp: p.hp, maxHp: p.maxHp, alive: p.alive, inCar: p.inCar, carType: p.carType || null, kills: p.kills,
      })),
      cars: this.cars.filter((c) => !c.claimedBy).map((c) => ({ id: c.id, type: c.type, x: c.x, y: c.y, angle: c.angle })),
    });
  }

  destroy() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
  }
}

module.exports = { Match };
