module.exports = {
  // Server configuration
  server: {
    httpsPort: 3000,
    httpPort: 3001
  },

  // Transcription configuration
  transcription: {
    // Provider: 'local-whisper' | 'groq'
    provider: process.env.TRANSCRIPTION_PROVIDER || 'groq',

    // Buffer duration in seconds before sending for transcription
    bufferDuration: 5,

    // Local Whisper settings
    localWhisper: {
      model: 'tiny',  // tiny, base, small, medium, large
      language: 'en'
    },

    // Groq settings
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      model: 'whisper-large-v3-turbo',  // whisper-large-v3-turbo is fastest
      language: 'en'
    }
  },

  // Transcripts storage
  transcripts: {
    directory: './transcripts'
  }
};
