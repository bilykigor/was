# WebRTC Audio Streamer

Minimal P2P WebRTC duplex audio streaming between devices. Stream microphone audio and text-to-speech from laptop to phone (Safari iOS supported) with low latency (~100-300ms).

## Features

- **Duplex audio**: Bidirectional mic streaming between devices
- **TTS integration**: Text-to-speech mixed with microphone audio
- **Safari iOS support**: Works on iPhone/iPad (HTTPS required)
- **Auto-connect**: Instant room connection on page load
- **API endpoint**: Send TTS remotely via HTTP
- **Zero config**: Self-signed HTTPS cert auto-generated

## Quick Start

```bash
# Install dependencies
npm install

# Generate certs and start server
npm start
```

Server runs at `https://localhost:3000`

### Connect Devices

1. **Laptop** (Chrome/Firefox): Open `https://localhost:3000/audio`
2. **Phone** (Safari): Open `https://<LAPTOP_IP>:3000/audio`
   - Find IP: `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux)
   - Accept self-signed certificate warning
3. Allow microphone access on both devices
4. Status shows "Connection: connected" when paired

### Test Audio

- **Mic**: Speak into one device → hear on the other
- **TTS**: Type text + press Enter or click "Speak" → plays on peer device

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /audio` | Web client interface |
| `GET /tts?text=hello` | Returns TTS audio (MP3) |
| `GET /say?text=hello` | Broadcasts TTS to all connected clients |

### Remote TTS

Send text-to-speech to connected devices via curl:

```bash
curl -k "https://localhost:3000/say?text=Hello%20world"
```

## Configuration

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |

### Multi-room Support

Change `roomId` in `public/index.html` to create separate audio channels.

### Production Deployment

1. **HTTPS**: Use Let's Encrypt or reverse proxy (nginx/Caddy)
2. **TURN server**: Add for NAT traversal (e.g., coturn)
   ```javascript
   iceServers: [
     { urls: 'stun:stun.l.google.com:19302' },
     { urls: 'turn:your-server:3478', username: '...', credential: '...' }
   ]
   ```
3. **TTS**: Replace Google TTS with ElevenLabs/OpenAI for production use

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No audio | Check browser console, verify `connectionState: connected` |
| Safari cert error | Tap "Show Details" → "Visit Website" |
| Autoplay blocked | Click anywhere on page to enable audio |
| High latency | Check WiFi quality, consider adding TURN server |
| TTS fails | Google TTS has rate limits; use production TTS API |

## Tech Stack

- **Server**: Node.js, Express, Socket.IO
- **Client**: Vanilla JS, WebRTC, Web Audio API
- **Signaling**: WebSocket (Socket.IO)

## License

MIT
