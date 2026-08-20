const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Match } = require('./match');
const { MAX_PLAYERS } = require('./constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

let waitingMatch = null;
const matchesByPlayer = new Map(); // socketId -> Match

function getOrCreateLobby() {
  if (!waitingMatch || waitingMatch.phase !== 'lobby' || waitingMatch.playerCount >= MAX_PLAYERS) {
    waitingMatch = new Match(io);
  }
  return waitingMatch;
}

io.on('connection', (socket) => {
  socket.on('lobby:join', ({ name }) => {
    if (matchesByPlayer.has(socket.id)) return;
    const match = getOrCreateLobby();
    matchesByPlayer.set(socket.id, match);
    match.addPlayer(socket, name);
    socket.emit('lobby:joined', { matchId: match.id });
  });

  socket.on('input', (input) => {
    const match = matchesByPlayer.get(socket.id);
    if (match) match.setInput(socket.id, input);
  });

  socket.on('disconnect', () => {
    const match = matchesByPlayer.get(socket.id);
    if (match) {
      match.removePlayer(socket.id);
      matchesByPlayer.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CarRoyale server listening on port ${PORT}`);
});
