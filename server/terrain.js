const { COLS, ROWS, TILE, CELL } = require('./constants');

function generateTerrain() {
  let grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const roll = Math.random();
      if (roll < 0.05) row.push(TILE.ROCK);
      else if (roll < 0.10) row.push(TILE.WATER);
      else if (roll < 0.17) row.push(TILE.MUD);
      else row.push(TILE.GRASS);
    }
    grid.push(row);
  }

  // cellular-automata smoothing so obstacles clump into blobs instead of
  // salt-and-pepper noise
  for (let iter = 0; iter < 3; iter++) {
    const next = grid.map((row) => row.slice());
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const counts = {};
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            const t = (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) ? grid[nr][nc] : TILE.GRASS;
            counts[t] = (counts[t] || 0) + 1;
          }
        }
        let best = TILE.GRASS;
        let bestCount = -1;
        Object.entries(counts).forEach(([t, n]) => {
          if (n > bestCount) { bestCount = n; best = Number(t); }
        });
        // keep some grass baseline so the map doesn't collapse into one blob
        next[r][c] = bestCount >= 5 ? best : (Math.random() < 0.6 ? grid[r][c] : TILE.GRASS);
      }
    }
    grid = next;
  }

  carveRoads(grid);
  return grid;
}

function carveRoads(grid) {
  const roadCount = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < roadCount; i++) {
    const horizontal = Math.random() < 0.5;
    if (horizontal) {
      const r = 3 + Math.floor(Math.random() * (ROWS - 6));
      for (let c = 0; c < COLS; c++) {
        grid[r][c] = TILE.ROAD;
        if (r + 1 < ROWS) grid[r + 1][c] = TILE.ROAD;
      }
    } else {
      const c = 3 + Math.floor(Math.random() * (COLS - 6));
      for (let r = 0; r < ROWS; r++) {
        grid[r][c] = TILE.ROAD;
        if (c + 1 < COLS) grid[r][c + 1] = TILE.ROAD;
      }
    }
  }
}

function tileAt(grid, x, y) {
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return TILE.ROCK;
  return grid[r][c];
}

function isBlocked(grid, x, y) {
  return tileAt(grid, x, y) === TILE.ROCK;
}

function randomOpenPosition(grid) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const x = Math.random() * (COLS * CELL - 40) + 20;
    const y = Math.random() * (ROWS * CELL - 40) + 20;
    if (!isBlocked(grid, x, y)) return { x, y };
  }
  return { x: (COLS * CELL) / 2, y: (ROWS * CELL) / 2 };
}

module.exports = { generateTerrain, tileAt, isBlocked, randomOpenPosition };
