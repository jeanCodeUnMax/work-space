# WS Bridge Status

This WebSocket bridge connects to the orchestrator database and provides real-time updates to the VS Code extension.

## Features
- Read-only connection to orchestrator database at `C:/Program Files/servers/orchestrator-server/data/orchestrator.db`
- WebSocket server on port 7477
- Polls for snapshot and task updates every 2 seconds
- Broadcasts updates to all connected clients

## Dependencies
- better-sqlite3: For SQLite database access
- ws: WebSocket implementation

## Usage
Run `npm start` or `node bridge.js` to start the bridge.

## Notes
- The bridge runs as a separate process spawned by the VS Code extension
- Database connection is read-only for safety
- Automatic reconnection handling for WebSocket clients