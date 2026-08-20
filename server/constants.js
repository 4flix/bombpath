// ---- world -------------------------------------------------------------
const CELL = 40;
const COLS = 60;
const ROWS = 45;
const WORLD_W = COLS * CELL;
const WORLD_H = ROWS * CELL;

const TILE = { GRASS: 0, ROAD: 1, MUD: 2, WATER: 3, ROCK: 4 };
const TILE_SPEED = {
  [TILE.GRASS]: 1.0,
  [TILE.ROAD]: 1.18,
  [TILE.MUD]: 0.55,
  [TILE.WATER]: 0.4,
  [TILE.ROCK]: 0, // impassable
};

// ---- lobby ---------------------------------------------------------------
const MAX_PLAYERS = 10;
const MIN_PLAYERS_TO_START = 2;
const LOBBY_WAIT_MS = Number(process.env.LOBBY_WAIT_MS) || 60000;
// if nobody else has joined by this many ms before the lobby closes, fill
// the match with one AI opponent so a lone player isn't left standing around
const AI_FILL_BEFORE_END_MS = 10000;

// ---- match phases ----------------------------------------------------------
const DROP_DURATION_MS = 2200;
const TICK_MS = 1000 / 30;

// ---- cars ------------------------------------------------------------------
// Balance model: each stat trades off against the others on roughly the same
// budget, so no single type dominates —
//   speed: wins by avoiding fights and picking angles, loses trades badly
//   power: wins head-on trades, loses the chase if the target just runs
//   tank:  wins wars of attrition, can't catch anything faster than it
//   balanced: no sharp edge either way, a safe pick when cars are scarce
const CAR_TYPES = {
  speed: { key: 'speed', name: '스피드카', color: '#4fd1ff', maxSpeed: 360, accel: 300, turnRate: 3.4, power: 3, durability: 42, mass: 55 },
  power: { key: 'power', name: '파워카', color: '#ff5c5c', maxSpeed: 205, accel: 210, turnRate: 2.3, power: 9, durability: 65, mass: 100 },
  tank: { key: 'tank', name: '탱크카', color: '#7CFC98', maxSpeed: 175, accel: 165, turnRate: 2.0, power: 5, durability: 140, mass: 140 },
  balanced: { key: 'balanced', name: '밸런스카', color: '#ffd166', maxSpeed: 265, accel: 235, turnRate: 2.8, power: 6, durability: 80, mass: 80 },
};
const CAR_TYPE_KEYS = Object.keys(CAR_TYPES);
const CAR_RADIUS = 16;
const PED_RADIUS = 9;
const PED_SPEED = 100;
const PED_HP = 30;
const PICKUP_RADIUS = CAR_RADIUS + PED_RADIUS + 6;

const FRICTION = 0.9; // per-tick velocity retention while coasting

// ---- collisions --------------------------------------------------------
const MIN_HIT_SPEED = 60; // px/s of closing speed before a collision counts as damage
const DAMAGE_K = 0.09; // relSpeed * attackerPower * DAMAGE_K = damage dealt
const HIT_COOLDOWN_MS = 450; // per-pair cooldown so a sustained shove doesn't melt HP every tick
const RESTITUTION = 0.55;

// ---- zone (자기장) -------------------------------------------------------
const ZONE_PHASES = [
  { holdMs: 9000, shrinkMs: 14000, factor: 0.72 },
  { holdMs: 8000, shrinkMs: 13000, factor: 0.65 },
  { holdMs: 7000, shrinkMs: 12000, factor: 0.6 },
  { holdMs: 6000, shrinkMs: 10000, factor: 0.55 },
  { holdMs: 5000, shrinkMs: 9000, factor: 0.5 },
];
const ZONE_MIN_RADIUS = 110;
const ZONE_DAMAGE_BASE = 3.5; // HP/sec outside the circle, scales with phase index

module.exports = {
  CELL, COLS, ROWS, WORLD_W, WORLD_H,
  TILE, TILE_SPEED,
  MAX_PLAYERS, MIN_PLAYERS_TO_START, LOBBY_WAIT_MS, AI_FILL_BEFORE_END_MS,
  DROP_DURATION_MS, TICK_MS,
  CAR_TYPES, CAR_TYPE_KEYS, CAR_RADIUS, PED_RADIUS, PED_SPEED, PED_HP, PICKUP_RADIUS,
  FRICTION, MIN_HIT_SPEED, DAMAGE_K, HIT_COOLDOWN_MS, RESTITUTION,
  ZONE_PHASES, ZONE_MIN_RADIUS, ZONE_DAMAGE_BASE,
};
