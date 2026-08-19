const LANES = 6;
const ROWS = 14;
const BOMB_COUNT = 5;
const ITEM_COUNT = 2;
const BOUNCE_COUNT = 2;

function randInt(max) {
  return Math.floor(Math.random() * max);
}

// Generate a classic ladder: rungs[row] is an array of booleans of length LANES-1
// rungs[row][i] === true means lane i and lane i+1 are connected at that row.
// Ensures no two adjacent connections at the same row (ladder crossing rule).
function generateRungs() {
  const rungs = [];
  for (let r = 0; r < ROWS; r++) {
    const row = new Array(LANES - 1).fill(false);
    let i = 0;
    while (i < LANES - 1) {
      if (Math.random() < 0.45) {
        row[i] = true;
        i += 2; // skip next to avoid adjacent connections
      } else {
        i += 1;
      }
    }
    rungs.push(row);
  }
  return rungs;
}

function randomBombs() {
  const bottomIndices = Array.from({ length: LANES }, (_, i) => i);
  shuffle(bottomIndices);
  return bottomIndices.slice(0, BOMB_COUNT).sort((a, b) => a - b);
}

function generateBoard() {
  const rungs = generateRungs();

  // items placed on random existing rungs (row, connection index)
  const rungSlots = [];
  rungs.forEach((row, r) => {
    row.forEach((connected, i) => {
      if (connected) rungSlots.push({ row: r, lane: i });
    });
  });
  shuffle(rungSlots);
  const items = rungSlots.slice(0, Math.min(ITEM_COUNT, rungSlots.length));

  // bounce pads sit on a vertical lane segment (not a rung). A player
  // travelling straight through that row on that lane gets forcibly pushed
  // sideways by `dir`, overriding whatever the rung at that row would do.
  const bouncePool = [];
  for (let r = 1; r < ROWS - 1; r++) {
    for (let lane = 0; lane < LANES; lane++) {
      bouncePool.push({ row: r, lane });
    }
  }
  shuffle(bouncePool);
  const bounces = bouncePool.slice(0, Math.min(BOUNCE_COUNT, bouncePool.length)).map((b) => ({
    ...b,
    dir: b.lane === 0 ? 1 : b.lane === LANES - 1 ? -1 : Math.random() < 0.5 ? -1 : 1,
  }));

  // bombs start empty; they are filled in either by a player's placement or
  // by randomBombs() as a fallback (see server/index.js bomb-placement phase).
  return { lanes: LANES, rows: ROWS, rungs, bombs: [], items, bounces };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Trace the full path of a lane: final lane reached, and item slots collected.
// board.items entries are {row, lane} where `lane` is the left index of the
// connection (i.e. it connects lane <-> lane+1 at that row).
function tracePath(board, startLane) {
  let lane = startLane;
  const path = [{ row: -1, lane }];
  const collectedItems = [];
  const hitBounces = [];
  for (let r = 0; r < board.rows; r++) {
    const enteringLane = lane;
    const bounce = (board.bounces || []).find((b) => b.row === r && b.lane === enteringLane);
    if (bounce) {
      lane = Math.min(board.lanes - 1, Math.max(0, enteringLane + bounce.dir));
      hitBounces.push(bounce);
    } else {
      const row = board.rungs[r];
      if (lane > 0 && row[lane - 1]) {
        lane -= 1;
      } else if (lane < board.lanes - 1 && row[lane]) {
        lane += 1;
      }
    }
    path.push({ row: r, lane });
  }
  board.items.forEach((it) => {
    // collected if the player crossed exactly this connection at this row
    const before = path.find((p) => p.row === it.row - 1) || path[0];
    const after = path.find((p) => p.row === it.row);
    if (!after) return;
    const a = Math.min(before.lane, after.lane);
    if (before.lane !== after.lane && a === it.lane) {
      collectedItems.push(it);
    }
  });
  return { finalLane: lane, items: collectedItems, bounces: hitBounces, path };
}

module.exports = { generateBoard, tracePath, randomBombs, LANES, ROWS, BOMB_COUNT, ITEM_COUNT, BOUNCE_COUNT };
