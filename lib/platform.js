'use strict';
// Where the app keeps its own files, and how the dashboard reaches the session host.
//   Windows  %LOCALAPPDATA%\ClaudeSessions, named pipe
//   macOS    ~/Library/Application Support/ClaudeSessions, Unix socket in that folder

const path = require('path');
const os = require('os');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function appRoot() {
  if (WIN) return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ClaudeSessions');
  if (MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSessions');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'ClaudeSessions');
}

function dataDir() {
  return process.env.CS_DATA || path.join(appRoot(), 'data');
}

function hostPipe() {
  if (process.env.CS_HOST_PIPE) return process.env.CS_HOST_PIPE;
  if (WIN) return `\\\\.\\pipe\\claude-sessions-host-${os.userInfo().username}`;
  return path.join(appRoot(), 'host.sock');
}

module.exports = { WIN, MAC, appRoot, dataDir, hostPipe };
