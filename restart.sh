#!/bin/bash

# Load environment variables from .env if it exists
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Kill existing server
pkill -f "node server.js" 2>/dev/null

# Wait a moment
sleep 1

# Start server
node server.js
