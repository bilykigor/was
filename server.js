const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');

const app = express();

const certDir = path.join(__dirname, 'certs');
const privateKey = fs.readFileSync(path.join(certDir, 'private-key.pem'));
const certificate = fs.readFileSync(path.join(certDir, 'cert.pem'));

const options = {
  key: privateKey,
  cert: certificate
};

const server = https.createServer(options, app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

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
    socket.join(roomId);
    socket.to(roomId).emit('user-connected');
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

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebRTC Audio Streamer server running at https://localhost:${PORT}/audio`);
  console.log(`Accessible from network at https://YOUR_IP:${PORT}/audio`);
  console.log('Run npm install && npm start');
});