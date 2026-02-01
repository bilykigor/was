const { RTCPeerConnection } = require('@roamhq/wrtc');
const { RTCAudioSink } = require('@roamhq/wrtc').nonstandard;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

class Transcriber {
  constructor(io, transcriptsDir) {
    this.io = io;
    this.peers = new Map(); // socketId -> { pc, audioSink, buffer, userId, roomId }
    this.sessions = new Map(); // roomId -> { filePath, startedAt, transcriptions }
    this.tmpDir = path.join(os.tmpdir(), 'whisper-audio');
    this.transcriptsDir = transcriptsDir || path.join(process.cwd(), 'transcripts');
    this.isProcessing = false;
    this.queue = [];

    // Ensure directories exist
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }
  }

  // Start a new session for a room
  startSession(roomId) {
    if (this.sessions.has(roomId)) {
      return this.sessions.get(roomId);
    }

    const startedAt = new Date();
    const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const fileName = `${roomId}_${timestamp}.yaml`;
    const filePath = path.join(this.transcriptsDir, fileName);

    const session = {
      filePath,
      startedAt,
      transcriptions: []
    };

    // Write initial session file
    const sessionData = {
      room: roomId,
      startedAt: startedAt.toISOString(),
      transcriptions: []
    };
    fs.writeFileSync(filePath, yaml.dump(sessionData));

    this.sessions.set(roomId, session);
    console.log(`[Transcriber] Started session for room ${roomId}: ${fileName}`);

    return session;
  }

  // End a session when room becomes empty
  endSession(roomId) {
    const session = this.sessions.get(roomId);
    if (session) {
      // Update file with end time
      const sessionData = {
        room: roomId,
        startedAt: session.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        transcriptions: session.transcriptions
      };
      fs.writeFileSync(session.filePath, yaml.dump(sessionData));
      console.log(`[Transcriber] Ended session for room ${roomId}`);
      this.sessions.delete(roomId);
    }
  }

  // Save transcription to session file
  saveTranscription(roomId, userId, text, timestamp) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    const entry = {
      timestamp: new Date(timestamp).toISOString(),
      userId,
      text
    };

    session.transcriptions.push(entry);

    // Update YAML file
    const sessionData = {
      room: roomId,
      startedAt: session.startedAt.toISOString(),
      transcriptions: session.transcriptions
    };
    fs.writeFileSync(session.filePath, yaml.dump(sessionData));
  }

  // Check if room has any connected peers
  roomHasPeers(roomId) {
    for (const [, peerData] of this.peers) {
      if (peerData.roomId === roomId) return true;
    }
    return false;
  }

  // Create a peer connection for a user in a room
  async createPeer(socketId, roomId, userId) {
    // Start session if this is first peer in room
    if (!this.roomHasPeers(roomId)) {
      this.startSession(roomId);
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const peerData = {
      pc,
      audioSink: null,
      buffer: [],
      bufferDuration: 0,
      userId: userId || socketId,
      roomId,
      sampleRate: 48000,
      channelCount: 1
    };

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        console.log(`[Transcriber] Audio track received from ${peerData.userId} in room ${roomId}`);
        this.setupAudioSink(socketId, event.track, peerData);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.io.to(socketId).emit('transcriber-ice-candidate', event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Transcriber] Connection state for ${socketId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.removePeer(socketId);
      }
    };

    this.peers.set(socketId, peerData);
    return pc;
  }

  setupAudioSink(socketId, track, peerData) {
    const sink = new RTCAudioSink(track);
    peerData.audioSink = sink;

    sink.ondata = (data) => {
      peerData.buffer.push(Buffer.from(data.samples.buffer));
      peerData.bufferDuration += data.samples.length / data.sampleRate;
      peerData.sampleRate = data.sampleRate;
      peerData.channelCount = data.channelCount;

      if (peerData.bufferDuration >= 10) {
        this.queueTranscription(socketId, peerData);
      }
    };
  }

  queueTranscription(socketId, peerData) {
    if (peerData.buffer.length === 0) return;

    const audioBuffer = Buffer.concat(peerData.buffer);
    peerData.buffer = [];
    peerData.bufferDuration = 0;

    if (this.queue.length >= 3) {
      console.log('[Transcriber] Queue full, dropping oldest chunk');
      this.queue.shift();
    }

    this.queue.push({
      socketId,
      userId: peerData.userId,
      roomId: peerData.roomId,
      audioBuffer,
      sampleRate: peerData.sampleRate,
      channelCount: peerData.channelCount
    });

    this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const item = this.queue.shift();

    const wavPath = path.join(this.tmpDir, `${item.socketId}-${Date.now()}.wav`);
    this.writeWav(wavPath, item.audioBuffer, item.sampleRate, item.channelCount);

    try {
      const transcript = await this.runWhisper(wavPath);
      if (transcript && transcript.trim()) {
        const text = transcript.trim();
        const timestamp = Date.now();

        console.log(`[Transcriber] ${item.userId}: ${text}`);

        // Save to YAML file
        this.saveTranscription(item.roomId, item.userId, text, timestamp);

        // Emit transcription to room
        this.io.to(item.roomId).emit('transcription', {
          userId: item.userId,
          text,
          timestamp
        });
      }
    } catch (err) {
      console.error('[Transcriber] Whisper error:', err.message);
    } finally {
      fs.unlink(wavPath, () => {});
      this.isProcessing = false;
      this.processQueue();
    }
  }

  writeWav(filePath, pcmBuffer, sampleRate, channelCount) {
    const bitsPerSample = 16;
    const byteRate = sampleRate * channelCount * (bitsPerSample / 8);
    const blockAlign = channelCount * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channelCount, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
  }

  runWhisper(audioPath) {
    return new Promise((resolve, reject) => {
      const whisper = spawn('whisper', [
        audioPath,
        '--model', 'tiny',
        '--output_format', 'txt',
        '--output_dir', this.tmpDir,
        '--language', 'en',
        '--task', 'transcribe'
      ]);

      let stderr = '';
      whisper.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      whisper.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
          return;
        }

        const baseName = path.basename(audioPath, '.wav');
        const txtPath = path.join(this.tmpDir, `${baseName}.txt`);

        if (fs.existsSync(txtPath)) {
          const transcript = fs.readFileSync(txtPath, 'utf8');
          fs.unlink(txtPath, () => {});
          resolve(transcript);
        } else {
          resolve('');
        }
      });

      whisper.on('error', reject);
    });
  }

  async handleOffer(socketId, offer, roomId, userId) {
    const pc = await this.createPeer(socketId, roomId, userId);

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    return pc.localDescription;
  }

  async handleIceCandidate(socketId, candidate) {
    const peerData = this.peers.get(socketId);
    if (peerData && peerData.pc) {
      await peerData.pc.addIceCandidate(candidate);
    }
  }

  removePeer(socketId) {
    const peerData = this.peers.get(socketId);
    if (peerData) {
      const roomId = peerData.roomId;

      if (peerData.audioSink) {
        peerData.audioSink.stop();
      }
      if (peerData.pc) {
        peerData.pc.close();
      }
      this.peers.delete(socketId);
      console.log(`[Transcriber] Removed peer ${socketId}`);

      // End session if room is now empty
      if (!this.roomHasPeers(roomId)) {
        this.endSession(roomId);
      }
    }
  }

  cleanup() {
    for (const [socketId] of this.peers) {
      this.removePeer(socketId);
    }
  }
}

module.exports = Transcriber;
