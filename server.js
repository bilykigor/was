const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');

const app = express();

// HTTPS server with self-signed certs (for local development)
const certDir = path.join(__dirname, 'certs');
const privateKey = fs.readFileSync(path.join(certDir, 'private-key.pem'));
const certificate = fs.readFileSync(path.join(certDir, 'cert.pem'));

const httpsOptions = {
  key: privateKey,
  cert: certificate
};

const httpsServer = https.createServer(httpsOptions, app);

// HTTP server (for use behind tunnels like ngrok/cloudflare)
const httpServer = http.createServer(app);

// Socket.IO attached to both servers
const io = new Server({
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
io.attach(httpsServer);
io.attach(httpServer);

// Room tracking (persists even when empty)
const rooms = new Map(); // roomId -> { name, createdAt }

// Ensure default room exists
rooms.set('default', { name: 'Default Room', createdAt: Date.now() });

app.use(express.static(path.join(__dirname, 'public')));

// API: List all rooms with connected user counts
app.get('/api/rooms', (req, res) => {
  const roomList = [];
  for (const [id, data] of rooms) {
    const socketsInRoom = io.sockets.adapter.rooms.get(id);
    roomList.push({
      id,
      name: data.name,
      userCount: socketsInRoom ? socketsInRoom.size : 0,
      createdAt: data.createdAt
    });
  }
  res.json(roomList);
});

// API: Create a new room
app.post('/api/rooms', express.json(), (req, res) => {
  const { id, name } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Room ID required' });
  }
  if (rooms.has(id)) {
    return res.status(409).json({ error: 'Room already exists' });
  }
  rooms.set(id, { name: name || id, createdAt: Date.now() });
  res.json({ id, name: name || id });
});

// API: Delete a room (only if empty)
app.delete('/api/rooms/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'default') {
    return res.status(400).json({ error: 'Cannot delete default room' });
  }
  const socketsInRoom = io.sockets.adapter.rooms.get(id);
  if (socketsInRoom && socketsInRoom.size > 0) {
    return res.status(400).json({ error: 'Room not empty' });
  }
  rooms.delete(id);
  res.json({ deleted: id });
});

app.get('/tts', (req, res) => {
  const { text, tl = 'en', ttsspeed = '1' } = req.query;
  if (!text) {
    return res.status(400).send('Missing text');
  }
  const params = new URLSearchParams({
    ie: 'UTF-8',
    client: 'tw-ob',
    tl: tl,
    q: text,
    ttsspeed: ttsspeed
  });
  const ttsUrl = `https://translate.google.com/translate_tts?${params}`;
  https.get(ttsUrl, (ttsRes) => {
    res.set('Content-Type', 'audio/mpeg');
    ttsRes.pipe(res);
  }).on('error', (err) => {
    console.error('TTS proxy error:', err);
    res.status(500).send('TTS proxy failed');
  });
});

app.get('/audio', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Broadcast TTS text to all clients - they generate audio and send via WebRTC
app.get('/say', (req, res) => {
  const { text, room = 'default' } = req.query;
  if (!text) {
    return res.status(400).send('Missing text parameter');
  }
  io.to(room).emit('tts-text', text);
  res.send(`Sent "${text}" to room ${room}`);
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomId) => {
    console.log(`Client ${socket.id} joins room ${roomId}`);
    // Auto-create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { name: roomId, createdAt: Date.now() });
    }
    socket.join(roomId);
    socket.to(roomId).emit('user-connected');
    // Notify all clients about room update
    io.emit('rooms-updated');
  });

  socket.on('leave-room', (roomId) => {
    console.log(`Client ${socket.id} leaves room ${roomId}`);
    socket.leave(roomId);
    io.emit('rooms-updated');
  });

  socket.on('offer', (data) => {
    console.log('Offer sent to room', data.roomId);
    socket.to(data.roomId).emit('offer', data.offer);
  });

  socket.on('answer', (data) => {
    console.log('Answer sent to room', data.roomId);
    socket.to(data.roomId).emit('answer', data.answer);
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', data.candidate);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const HTTPS_PORT = 3000;
const HTTP_PORT = 3001;

httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`HTTPS server running at https://localhost:${HTTPS_PORT}/audio`);
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server running at http://localhost:${HTTP_PORT}/audio`);
  console.log(`Use HTTP port ${HTTP_PORT} with ngrok/cloudflare tunnels`);
});