const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { generateBoard, tracePath, randomBombs, LANES, BOMB_COUNT } = require('./ladder');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const BOMB_PLACE_TIME_MS = 7000;
const PICK_TIME_MS = 6000;
const DESCENT_TIME_MS = 3200;
const COUNTDOWN_MS = 1500;
const AI_MIN_DELAY_MS = 500;
const AI_MAX_DELAY_MS = 1800;

function aiDelay() {
  return AI_MIN_DELAY_MS + Math.random() * (AI_MAX_DELAY_MS - AI_MIN_DELAY_MS);
}

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, vsAI) {
    this.code = code;
    this.vsAI = vsAI;
    this.players = []; // {id, socket, name, alive, isAI}
    this.round = 0;
    this.phase = 'lobby';
    this.board = null;
    this.picks = {};
    this.pickTimer = null;
    this.bombPlaceTimer = null;
    this.placerId = null;
  }

  broadcast(event, payload) {
    this.players.forEach((p) => {
      if (!p.isAI) p.socket.emit(event, payload);
    });
  }

  publicState() {
    return {
      code: this.code,
      round: this.round,
      players: this.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, isAI: p.isAI })),
    };
  }

  addPlayer(socket, name) {
    const player = { id: socket.id, socket, name, alive: true, isAI: false, shields: 0 };
    this.players.push(player);
    socket.join(this.code);
    return player;
  }

  addAI() {
    const ai = { id: 'AI-' + Math.random().toString(36).slice(2, 7), socket: null, name: 'AI', alive: true, isAI: true, shields: 0 };
    this.players.push(ai);
    return ai;
  }

  startRound() {
    this.round += 1;
    this.phase = 'bombPlace';
    this.picks = {};
    this.board = generateBoard();

    const alivePlayers = this.players.filter((p) => p.alive);
    const placer = alivePlayers[(this.round - 1) % alivePlayers.length];
    this.placerId = placer.id;

    this.broadcast('round:start', {
      round: this.round,
      board: { lanes: this.board.lanes, rows: this.board.rows },
      phase: 'bombPlace',
      placerId: this.placerId,
      bombCount: BOMB_COUNT,
      bombPlaceTimeMs: BOMB_PLACE_TIME_MS,
      players: this.publicState().players,
    });

    if (this.bombPlaceTimer) clearTimeout(this.bombPlaceTimer);
    if (placer.isAI) {
      this.bombPlaceTimer = setTimeout(() => this.finalizeBombs(randomBombs()), aiDelay());
    } else {
      this.bombPlaceTimer = setTimeout(() => this.finalizeBombs(randomBombs()), BOMB_PLACE_TIME_MS);
    }
  }

  handleBombPlace(playerId, lanes) {
    if (this.phase !== 'bombPlace' || playerId !== this.placerId) return;
    if (!Array.isArray(lanes)) return;
    const unique = Array.from(new Set(lanes)).filter((l) => Number.isInteger(l) && l >= 0 && l < this.board.lanes);
    if (unique.length !== BOMB_COUNT) return;
    this.finalizeBombs(unique.sort((a, b) => a - b));
  }

  finalizeBombs(bombs) {
    if (this.phase !== 'bombPlace') return;
    clearTimeout(this.bombPlaceTimer);
    this.board.bombs = bombs;
    this.phase = 'pick';
    this.broadcast('phase:pick', { pickTimeMs: PICK_TIME_MS });

    if (this.pickTimer) clearTimeout(this.pickTimer);
    this.pickTimer = setTimeout(() => this.resolvePicks(), PICK_TIME_MS);

    if (this.vsAI) {
      const ai = this.players.find((p) => p.isAI && p.alive);
      if (ai) setTimeout(() => this.handlePick(ai.id, this.randomFreeLane()), aiDelay());
    }
  }

  randomFreeLane() {
    const taken = new Set(Object.values(this.picks));
    const free = [];
    for (let lane = 0; lane < this.board.lanes; lane++) if (!taken.has(lane)) free.push(lane);
    if (free.length === 0) return Math.floor(Math.random() * this.board.lanes);
    return free[Math.floor(Math.random() * free.length)];
  }

  handlePick(playerId, lane) {
    if (this.phase !== 'pick') return;
    if (this.picks[playerId] !== undefined) return;
    const taken = new Set(Object.values(this.picks));
    if (taken.has(lane)) return; // lane already taken, ignore
    this.picks[playerId] = lane;
    this.broadcast('pick:update', { playerId, lane });

    const alivePlayers = this.players.filter((p) => p.alive);
    if (alivePlayers.every((p) => this.picks[p.id] !== undefined)) {
      clearTimeout(this.pickTimer);
      this.resolvePicks();
    }
  }

  autoAssignMissingPicks() {
    const taken = new Set(Object.values(this.picks));
    this.players.filter((p) => p.alive).forEach((p) => {
      if (this.picks[p.id] === undefined) {
        let lane;
        do {
          lane = Math.floor(Math.random() * this.board.lanes);
        } while (taken.has(lane) && taken.size < this.board.lanes);
        this.picks[p.id] = lane;
        taken.add(lane);
      }
    });
  }

  runAIPick() {
    const ai = this.players.find((p) => p.isAI && p.alive);
    if (!ai || this.picks[ai.id] !== undefined) return;
    const taken = new Set(Object.values(this.picks));
    let lane;
    do {
      lane = Math.floor(Math.random() * this.board.lanes);
    } while (taken.has(lane));
    this.picks[ai.id] = lane;
  }

  resolvePicks() {
    if (this.phase !== 'pick') return;
    if (this.vsAI) this.runAIPick();
    this.autoAssignMissingPicks();
    this.phase = 'countdown';
    this.broadcast('phase:countdown', { picks: this.picks, countdownMs: COUNTDOWN_MS });
    setTimeout(() => this.startDescent(), COUNTDOWN_MS);
  }

  startDescent() {
    this.phase = 'descent';

    const results = this.players.filter((p) => p.alive).map((p) => {
      const lane = this.picks[p.id];
      const trace = tracePath(this.board, lane);
      return { player: p, lane, trace };
    });

    results.forEach(({ player, lane, trace }) => {
      const hitBomb = this.board.bombs.includes(trace.finalLane);
      const gainedShield = trace.items.length > 0;
      if (gainedShield) player.shields += trace.items.length;
      let died = false;
      if (hitBomb) {
        if (player.shields > 0) {
          player.shields -= 1;
        } else {
          died = true;
        }
      }
      player.alive = !died;
      const closeCall = !hitBomb && this.board.bombs.some((b) => Math.abs(b - trace.finalLane) === 1);
      player.lastResult = { lane, finalLane: trace.finalLane, path: trace.path, hitBomb, died, closeCall, shieldsLeft: player.shields, itemsCollected: trace.items.length };
    });

    this.broadcast('round:descent', {
      picks: this.picks,
      rungs: this.board.rungs,
      bombs: this.board.bombs,
      items: this.board.items,
      bounces: this.board.bounces,
      results: results.map(({ player, trace }) => ({
        playerId: player.id,
        lane: this.picks[player.id],
        finalLane: trace.finalLane,
        path: trace.path,
        hitBomb: this.board.bombs.includes(trace.finalLane),
        died: player.lastResult.died,
        closeCall: player.lastResult.closeCall,
        shieldsLeft: player.shields,
      })),
      descentTimeMs: DESCENT_TIME_MS,
    });

    setTimeout(() => this.finishRound(), DESCENT_TIME_MS);
  }

  finishRound() {
    const aliveNow = this.players.filter((p) => p.alive);
    if (aliveNow.length <= 1) {
      this.phase = 'over';
      const winner = aliveNow[0] || null;
      this.broadcast('game:over', { winner: winner ? { id: winner.id, name: winner.name, isAI: winner.isAI } : null });
      return;
    }
    this.startRound();
  }
}

io.on('connection', (socket) => {
  socket.on('room:createAI', ({ name }) => {
    const code = makeRoomCode();
    const room = new Room(code, true);
    rooms.set(code, room);
    room.addPlayer(socket, name || 'Player');
    room.addAI();
    socket.emit('room:joined', room.publicState());
    room.startRound();
  });

  socket.on('room:create', ({ name }) => {
    const code = makeRoomCode();
    const room = new Room(code, false);
    rooms.set(code, room);
    room.addPlayer(socket, name || 'Player');
    socket.emit('room:joined', room.publicState());
    io.to(code).emit('room:state', room.publicState());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) {
      socket.emit('room:error', { message: 'Room not found' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('room:error', { message: 'Room is full' });
      return;
    }
    room.addPlayer(socket, name || 'Player');
    io.to(room.code).emit('room:state', room.publicState());
    socket.emit('room:joined', room.publicState());
    if (room.players.length === 2) {
      room.startRound();
    }
  });

  socket.on('bomb:place', ({ code, lanes }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.handleBombPlace(socket.id, lanes);
  });

  socket.on('pick:lane', ({ code, lane }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.handlePick(socket.id, lane);
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, code) => {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players[idx].alive = false;
        io.to(code).emit('room:state', room.publicState());
        const aliveHumans = room.players.filter((p) => p.alive && !p.isAI);
        if (aliveHumans.length === 0 && room.phase !== 'over') {
          room.phase = 'over';
          if (room.pickTimer) clearTimeout(room.pickTimer);
          if (room.bombPlaceTimer) clearTimeout(room.bombPlaceTimer);
          rooms.delete(code);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BombPath server listening on port ${PORT}`);
});
