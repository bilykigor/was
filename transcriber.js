const { RTCPeerConnection } = require('@roamhq/wrtc');
const { RTCAudioSink } = require('@roamhq/wrtc').nonstandard;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const Groq = require('groq-sdk');
const config = require('./config');

class Transcriber {
  constructor(io, transcriptsDir) {
    this.io = io;
    this.peers = new Map();
    this.sessions = new Map();
    this.tmpDir = path.join(os.tmpdir(), 'whisper-audio');
    this.transcriptsDir = transcriptsDir || path.resolve(config.transcripts.directory);
    this.isProcessing = false;
    this.queue = [];
    this.provider = config.transcription.provider;
    this.bufferDuration = config.transcription.bufferDuration;

    // Initialize Groq client if needed
    if (this.provider === 'groq') {
      if (config.transcription.groq.apiKey) {
        this.groq = new Groq({ apiKey: config.transcription.groq.apiKey });
        console.log('[Transcriber] Using Groq for transcription');
      } else {
        console.warn('[Transcriber] GROQ_API_KEY not set, falling back to local-whisper');
        this.provider = 'local-whisper';
      }
    }

    if (this.provider === 'local-whisper') {
      console.log('[Transcriber] Using local Whisper for transcription');
    }

    // Ensure directories exist
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }
  }

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

  endSession(roomId) {
    const session = this.sessions.get(roomId);
    if (session) {
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

  saveTranscription(roomId, userId, text, timestamp) {
    const session = this.sessions.get(roomId);
    if (!session) return;

    const entry = {
      timestamp: new Date(timestamp).toISOString(),
      userId,
      text
    };

    session.transcriptions.push(entry);

    const sessionData = {
      room: roomId,
      startedAt: session.startedAt.toISOString(),
      transcriptions: session.transcriptions
    };
    fs.writeFileSync(session.filePath, yaml.dump(sessionData));
  }

  roomHasPeers(roomId) {
    for (const [, peerData] of this.peers) {
      if (peerData.roomId === roomId) return true;
    }
    return false;
  }

  async createPeer(socketId, roomId, userId) {
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

      if (peerData.bufferDuration >= this.bufferDuration) {
        this.queueTranscription(socketId, peerData);
      }
    };
  }

  queueTranscription(socketId, peerData) {
    if (peerData.buffer.length === 0) return;

    const audioBuffer = Buffer.concat(peerData.buffer);
    peerData.buffer = [];
    peerData.bufferDuration = 0;

    // Skip silent chunks early (before queuing)
    if (!this.hasVoiceActivity(audioBuffer)) {
      return;
    }

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
      let transcript;
      if (this.provider === 'groq') {
        transcript = await this.transcribeWithGroq(wavPath);
      } else {
        transcript = await this.transcribeWithLocalWhisper(wavPath);
      }

      if (transcript && transcript.trim()) {
        const text = transcript.trim();
        const timestamp = Date.now();

        console.log(`[Transcriber] ${item.userId}: ${text}`);

        this.saveTranscription(item.roomId, item.userId, text, timestamp);

        this.io.to(item.roomId).emit('transcription', {
          userId: item.userId,
          text,
          timestamp
        });
      }
    } catch (err) {
      console.error('[Transcriber] Transcription error:', err.message);
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

  // Check if audio has enough energy (simple VAD)
  hasVoiceActivity(pcmBuffer) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i]);
    }
    const avgEnergy = sum / samples.length;
    console.log(`[Transcriber] Audio energy: ${avgEnergy.toFixed(0)}`);
    // Threshold for voice activity (lowered from 500)
    return avgEnergy > 50;
  }

  async transcribeWithGroq(audioPath) {
    const audioBuffer = fs.readFileSync(audioPath);

    // Skip if no voice activity detected
    if (!this.hasVoiceActivity(audioBuffer)) {
      console.log('[Transcriber] Skipping silent chunk');
      return '';
    }

    const file = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

    const transcription = await this.groq.audio.transcriptions.create({
      file,
      model: config.transcription.groq.model,
      language: config.transcription.groq.language,
      response_format: 'text',
      prompt: 'This is a conversation. Transcribe only actual speech, not filler words.'
    });

    // Filter out common Whisper hallucinations
    const hallucinations = [
      'thank you', 'thanks for watching', 'thanks for listening',
      'subscribe', 'like and subscribe', 'see you next time',
      'bye', 'goodbye', 'the end'
    ];

    const text = transcription.trim().toLowerCase();
    if (hallucinations.some(h => text === h || text === h + '.')) {
      console.log('[Transcriber] Filtered hallucination:', transcription);
      return '';
    }

    return transcription;
  }

  transcribeWithLocalWhisper(audioPath) {
    return new Promise((resolve, reject) => {
      const { model, language } = config.transcription.localWhisper;

      const whisper = spawn('whisper', [
        audioPath,
        '--model', model,
        '--output_format', 'txt',
        '--output_dir', this.tmpDir,
        '--language', language,
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
