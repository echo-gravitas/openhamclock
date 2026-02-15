#!/usr/bin/env node
/**
 * OpenHamClock Rig Listener v1.0.0
 *
 * A single, self-contained bridge between your radio and OpenHamClock.
 * Talks directly to your radio via USB/serial — no flrig, no rigctld needed.
 *
 * Supported radios:
 *   • Yaesu  (FT-991A, FT-891, FT-710, FT-DX10, FT-DX101, FT-450, FT-817/818, etc.)
 *   • Kenwood / Elecraft  (TS-590, TS-890, K3, K4, KX3, KX2, etc.)
 *   • Icom  (IC-7300, IC-7610, IC-705, IC-9700, etc.)
 *
 * Usage:
 *   node rig-listener.js              (interactive wizard on first run)
 *   node rig-listener.js --port COM3  (quick start with port override)
 *   node rig-listener.js --mock       (simulation mode, no radio needed)
 *
 * The wizard saves your config to rig-listener-config.json so subsequent
 * runs just work with: node rig-listener.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = '1.0.0';

// When compiled with pkg, __dirname points inside the snapshot filesystem.
// Config must be saved next to the actual executable so it persists.
const EXE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(EXE_DIR, 'rig-listener-config.json');
const HTTP_PORT_DEFAULT = 5555;

// ============================================
// DEFAULT CONFIG
// ============================================
const DEFAULT_CONFIG = {
  serial: {
    port: '',           // e.g. COM3, /dev/ttyUSB0
    baudRate: 38400,
    dataBits: 8,
    stopBits: 2,        // Yaesu default; Kenwood/Icom usually 1
    parity: 'none',
  },
  radio: {
    brand: 'yaesu',     // yaesu | kenwood | icom
    model: '',          // user-friendly, e.g. "FT-991A"
    civAddress: 0x94,   // Icom only — default IC-7300
    pollInterval: 500,
    pttEnabled: false,
  },
  server: {
    port: HTTP_PORT_DEFAULT,
  },
};

// ============================================
// RADIO STATE
// ============================================
const state = {
  freq: 0,
  mode: '',
  width: 0,
  ptt: false,
  connected: false,
  lastUpdate: 0,
};

// SSE clients
let sseClients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.write(msg); return true; } catch { return false; }
  });
}

function updateState(prop, value) {
  if (state[prop] === value) return;
  state[prop] = value;
  state.lastUpdate = Date.now();
  broadcast({ type: 'update', prop, value });
}

// ============================================
// YAESU CAT PROTOCOL (text, semicolon-terminated)
// FT-991A, FT-891, FT-710, FT-DX10, FT-DX101, FT-450D, etc.
// ============================================
const YAESU_MODES = {
  '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM',
  '6': 'RTTY-LSB', '7': 'CW-R', '8': 'DATA-LSB', '9': 'RTTY-USB',
  'A': 'DATA-FM', 'B': 'FM-N', 'C': 'DATA-USB', 'D': 'AM-N',
};
const YAESU_MODES_REV = Object.fromEntries(
  Object.entries(YAESU_MODES).map(([k, v]) => [v, k])
);

const YaesuProtocol = {
  buffer: '',

  buildPollCommands() {
    return ['FA;', 'MD0;', 'TX;'];
  },

  parseResponse(chunk) {
    this.buffer += chunk;
    const commands = [];
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      commands.push(this.buffer.substring(0, idx + 1));
      this.buffer = this.buffer.substring(idx + 1);
    }
    for (const cmd of commands) {
      if (cmd.startsWith('FA') && cmd.length >= 11) {
        const freq = parseInt(cmd.substring(2, cmd.length - 1));
        if (freq > 0) updateState('freq', freq);
      } else if (cmd.startsWith('MD0') && cmd.length >= 4) {
        const code = cmd.charAt(3);
        const mode = YAESU_MODES[code] || code;
        updateState('mode', mode);
      } else if (cmd.startsWith('TX') && cmd.length >= 3) {
        const txState = cmd.charAt(2);
        updateState('ptt', txState !== '0');
      } else if (cmd.startsWith('IF') && cmd.length >= 27) {
        // IF response contains freq at positions 5-13 (9 digits) and mode at position 21
        const freq = parseInt(cmd.substring(5, 14));
        if (freq > 0) updateState('freq', freq);
        const modeCode = cmd.charAt(21);
        const mode = YAESU_MODES[modeCode] || modeCode;
        if (mode) updateState('mode', mode);
      }
    }
  },

  setFreqCmd(hz) {
    return `FA${String(Math.round(hz)).padStart(9, '0')};`;
  },

  setModeCmd(mode) {
    const code = YAESU_MODES_REV[mode] || YAESU_MODES_REV[mode.toUpperCase()];
    if (!code) return null;
    return `MD0${code};`;
  },

  setPttCmd(on) {
    return on ? 'TX1;' : 'TX0;';
  },
};

// ============================================
// KENWOOD / ELECRAFT PROTOCOL (text, semicolon-terminated)
// TS-590, TS-890, K3, K4, KX3, KX2, etc.
// ============================================
const KENWOOD_MODES = {
  '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM',
  '6': 'FSK', '7': 'CW-R', '9': 'FSK-R',
};
const KENWOOD_MODES_REV = Object.fromEntries(
  Object.entries(KENWOOD_MODES).map(([k, v]) => [v, k])
);

const KenwoodProtocol = {
  buffer: '',

  buildPollCommands() {
    return ['FA;', 'MD;', 'TX;'];
  },

  parseResponse(chunk) {
    this.buffer += chunk;
    const commands = [];
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      commands.push(this.buffer.substring(0, idx + 1));
      this.buffer = this.buffer.substring(idx + 1);
    }
    for (const cmd of commands) {
      if (cmd.startsWith('FA') && cmd.length >= 13) {
        const freq = parseInt(cmd.substring(2, cmd.length - 1));
        if (freq > 0) updateState('freq', freq);
      } else if (cmd.startsWith('MD') && cmd.length >= 3) {
        const code = cmd.charAt(2);
        const mode = KENWOOD_MODES[code] || code;
        updateState('mode', mode);
      } else if (cmd.startsWith('TX') && cmd.length >= 3) {
        const txState = cmd.charAt(2);
        updateState('ptt', txState !== '0');
      } else if (cmd.startsWith('IF') && cmd.length >= 37) {
        // Kenwood IF: positions 2-12 = freq (11 digits), 29 = mode
        const freq = parseInt(cmd.substring(2, 13));
        if (freq > 0) updateState('freq', freq);
        const modeCode = cmd.charAt(29);
        const mode = KENWOOD_MODES[modeCode] || modeCode;
        if (mode) updateState('mode', mode);
      }
    }
  },

  setFreqCmd(hz) {
    return `FA${String(Math.round(hz)).padStart(11, '0')};`;
  },

  setModeCmd(mode) {
    const code = KENWOOD_MODES_REV[mode] || KENWOOD_MODES_REV[mode.toUpperCase()];
    if (!code) return null;
    return `MD${code};`;
  },

  setPttCmd(on) {
    return on ? 'TX1;' : 'RX;';
  },
};

// ============================================
// ICOM CI-V PROTOCOL (binary)
// IC-7300, IC-7610, IC-705, IC-9700, etc.
// ============================================
const ICOM_MODES = {
  0x00: 'LSB', 0x01: 'USB', 0x02: 'AM', 0x03: 'CW', 0x04: 'RTTY',
  0x05: 'FM', 0x06: 'WFM', 0x07: 'CW-R', 0x08: 'RTTY-R',
  0x17: 'DV',
};
const ICOM_MODES_REV = Object.fromEntries(
  Object.entries(ICOM_MODES).map(([k, v]) => [v, parseInt(k)])
);
// Common Icom CI-V addresses
const ICOM_ADDRESSES = {
  'IC-7300': 0x94, 'IC-7610': 0x98, 'IC-705': 0xA4,
  'IC-9700': 0xA2, 'IC-7100': 0x88, 'IC-7851': 0x8E,
  'IC-7600': 0x7A, 'IC-746': 0x56, 'IC-718': 0x5E,
};

const IcomProtocol = {
  buffer: Buffer.alloc(0),
  civAddr: 0x94,     // set from config
  controllerAddr: 0xE0,

  buildPollCommands() {
    // 03 = read freq, 04 = read mode, 1C 00 = read TX status
    return [
      this._frame([0x03]),
      this._frame([0x04]),
      this._frame([0x1C, 0x00]),
    ];
  },

  _frame(payload) {
    const buf = Buffer.from([0xFE, 0xFE, this.civAddr, this.controllerAddr, ...payload, 0xFD]);
    return buf;
  },

  parseResponse(chunk) {
    // chunk is a Buffer
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk]);

    while (true) {
      // Find preamble
      const start = this.buffer.indexOf(Buffer.from([0xFE, 0xFE]));
      if (start === -1) { this.buffer = Buffer.alloc(0); return; }

      // Find end
      const endIdx = this.buffer.indexOf(0xFD, start + 2);
      if (endIdx === -1) {
        // Keep from start onwards
        this.buffer = this.buffer.subarray(start);
        return;
      }

      const frame = this.buffer.subarray(start, endIdx + 1);
      this.buffer = this.buffer.subarray(endIdx + 1);

      // Minimum frame: FE FE TO FROM CMD FD = 6 bytes
      if (frame.length < 6) continue;

      const to = frame[2];
      const from = frame[3];

      // Only process frames addressed to us (controller) from the radio
      if (to !== this.controllerAddr) continue;

      const cmd = frame[4];
      const data = frame.subarray(5, frame.length - 1); // strip FD

      if (cmd === 0x03 || cmd === 0x00) {
        // Frequency response (or unsolicited freq)
        // Also cmd 0x00 is freq data in transceive mode
        if (data.length >= 5) {
          const freq = this._bcdToFreq(data);
          if (freq > 0) updateState('freq', freq);
        }
      } else if (cmd === 0x04 || cmd === 0x01) {
        // Mode response
        if (data.length >= 1) {
          const mode = ICOM_MODES[data[0]] || `MODE_${data[0].toString(16)}`;
          updateState('mode', mode);
        }
      } else if (cmd === 0x1C) {
        // TX status response
        if (data.length >= 2 && data[0] === 0x00) {
          updateState('ptt', data[1] === 0x01);
        }
      }
    }
  },

  _bcdToFreq(data) {
    // Icom BCD: 5 bytes, little-endian BCD
    // byte0 = 1Hz,10Hz  byte1 = 100Hz,1kHz  byte2 = 10kHz,100kHz  byte3 = 1MHz,10MHz  byte4 = 100MHz,1GHz
    let freq = 0;
    let mult = 1;
    for (let i = 0; i < Math.min(data.length, 5); i++) {
      freq += (data[i] & 0x0F) * mult;
      mult *= 10;
      freq += ((data[i] >> 4) & 0x0F) * mult;
      mult *= 10;
    }
    return freq;
  },

  _freqToBcd(hz) {
    const buf = Buffer.alloc(5);
    let f = Math.round(hz);
    for (let i = 0; i < 5; i++) {
      const lo = f % 10; f = Math.floor(f / 10);
      const hi = f % 10; f = Math.floor(f / 10);
      buf[i] = (hi << 4) | lo;
    }
    return buf;
  },

  setFreqCmd(hz) {
    return this._frame([0x05, ...this._freqToBcd(hz)]);
  },

  setModeCmd(mode) {
    const code = ICOM_MODES_REV[mode] ?? ICOM_MODES_REV[mode.toUpperCase()];
    if (code === undefined) return null;
    return this._frame([0x06, code, 0x01]); // 0x01 = default filter
  },

  setPttCmd(on) {
    return this._frame([0x1C, 0x00, on ? 0x01 : 0x00]);
  },
};

// ============================================
// MOCK PROTOCOL (no radio, simulation)
// ============================================
const MockProtocol = {
  buildPollCommands() { return []; },
  parseResponse() {},
  setFreqCmd() { return null; },
  setModeCmd() { return null; },
  setPttCmd() { return null; },
};

// ============================================
// SERIAL ENGINE
// ============================================
let serialPort = null;
let protocol = null;
let pollTimer = null;
let config = null;

async function initSerial(cfg) {
  config = cfg;

  // Select protocol
  const brand = cfg.radio.brand.toLowerCase();
  if (brand === 'yaesu') {
    protocol = YaesuProtocol;
  } else if (brand === 'kenwood' || brand === 'elecraft') {
    protocol = KenwoodProtocol;
  } else if (brand === 'icom') {
    protocol = IcomProtocol;
    IcomProtocol.civAddr = cfg.radio.civAddress || 0x94;
  } else if (brand === 'mock') {
    protocol = MockProtocol;
    state.connected = true;
    state.freq = 14074000;
    state.mode = 'USB';
    console.log('[Mock] Simulation mode active');
    return;
  } else {
    console.error(`[Error] Unknown brand: ${brand}`);
    process.exit(1);
  }

  // Dynamic import of serialport
  let SerialPort;
  try {
    const sp = require('serialport');
    SerialPort = sp.SerialPort;
  } catch (e) {
    console.error('\n❌ The "serialport" package is not installed.');
    console.error('   Run: npm install');
    console.error(`   (Error: ${e.message})\n`);
    process.exit(1);
  }

  const portPath = cfg.serial.port;
  console.log(`[Serial] Opening ${portPath} at ${cfg.serial.baudRate} baud...`);

  try {
    serialPort = new SerialPort({
      path: portPath,
      baudRate: cfg.serial.baudRate,
      dataBits: cfg.serial.dataBits || 8,
      stopBits: cfg.serial.stopBits || 2,
      parity: cfg.serial.parity || 'none',
      autoOpen: false,
    });
  } catch (e) {
    console.error(`[Serial] Failed to create port: ${e.message}`);
    process.exit(1);
  }

  serialPort.on('open', () => {
    console.log(`[Serial] Connected to ${portPath}`);
    state.connected = true;
    broadcast({ type: 'update', prop: 'connected', value: true });

    // Start polling
    const interval = cfg.radio.pollInterval || 500;
    pollTimer = setInterval(() => {
      if (!serialPort || !serialPort.isOpen) return;
      const cmds = protocol.buildPollCommands();
      for (const cmd of cmds) {
        try {
          serialPort.write(cmd);
        } catch (e) {
          // write error handled by error event
        }
      }
    }, interval);
  });

  serialPort.on('data', (data) => {
    // Icom uses binary, Yaesu/Kenwood use text
    if (brand === 'icom') {
      protocol.parseResponse(data);
    } else {
      protocol.parseResponse(data.toString('utf8'));
    }
  });

  serialPort.on('error', (err) => {
    console.error(`[Serial] Error: ${err.message}`);
    state.connected = false;
    broadcast({ type: 'update', prop: 'connected', value: false });
  });

  serialPort.on('close', () => {
    console.log('[Serial] Port closed — reconnecting in 5s...');
    state.connected = false;
    broadcast({ type: 'update', prop: 'connected', value: false });
    if (pollTimer) clearInterval(pollTimer);
    setTimeout(() => reconnect(cfg), 5000);
  });

  // Open
  serialPort.open((err) => {
    if (err) {
      console.error(`[Serial] Cannot open ${portPath}: ${err.message}`);
      console.error('');
      console.error('  Troubleshooting:');
      console.error('    • Is the USB cable connected?');
      console.error('    • Is another program using this port? (flrig, WSJT-X, etc.)');
      console.error('    • On Linux, you may need: sudo usermod -a -G dialout $USER');
      console.error('    • On Windows, check Device Manager → Ports for the correct COM port');
      console.error('');
      // Don't exit — try to reconnect
      setTimeout(() => reconnect(cfg), 5000);
    }
  });
}

function reconnect(cfg) {
  if (serialPort) {
    try { serialPort.close(); } catch {}
    serialPort = null;
  }
  console.log(`[Serial] Attempting reconnect to ${cfg.serial.port}...`);
  initSerial(cfg);
}

function sendToRadio(data) {
  if (!serialPort || !serialPort.isOpen) return false;
  try {
    serialPort.write(data);
    return true;
  } catch (e) {
    console.error(`[Serial] Write error: ${e.message}`);
    return false;
  }
}

// ============================================
// HTTP SERVER (zero dependencies)
// ============================================
function startServer(port) {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // GET /status
    if (req.method === 'GET' && pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: state.connected,
        freq: state.freq,
        mode: state.mode,
        width: state.width,
        ptt: state.ptt,
        timestamp: state.lastUpdate,
      }));
      return;
    }

    // GET /stream (SSE)
    if (req.method === 'GET' && pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial state
      const init = {
        type: 'init',
        connected: state.connected,
        freq: state.freq,
        mode: state.mode,
        width: state.width,
        ptt: state.ptt,
      };
      res.write(`data: ${JSON.stringify(init)}\n\n`);
      sseClients.push(res);

      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // POST /freq
    if (req.method === 'POST' && pathname === '/freq') {
      parseBody(req, (body) => {
        if (!body || !body.freq) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing freq' }));
          return;
        }
        const cmd = protocol.setFreqCmd(body.freq);
        if (cmd) {
          console.log(`[CMD] Set freq: ${body.freq} Hz`);
          sendToRadio(cmd);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }

    // POST /mode
    if (req.method === 'POST' && pathname === '/mode') {
      parseBody(req, (body) => {
        if (!body || !body.mode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing mode' }));
          return;
        }
        const cmd = protocol.setModeCmd(body.mode);
        if (cmd) {
          console.log(`[CMD] Set mode: ${body.mode}`);
          sendToRadio(cmd);
        } else {
          console.warn(`[CMD] Unknown mode: ${body.mode}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }

    // POST /ptt
    if (req.method === 'POST' && pathname === '/ptt') {
      parseBody(req, (body) => {
        if (!config.radio.pttEnabled && body?.ptt) {
          console.warn('[CMD] PTT blocked — pttEnabled is false in config');
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'PTT disabled in configuration' }));
          return;
        }
        const cmd = protocol.setPttCmd(!!body?.ptt);
        if (cmd) {
          console.log(`[CMD] PTT: ${body.ptt ? 'ON' : 'OFF'}`);
          sendToRadio(cmd);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }

    // GET / — health/info
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'OpenHamClock Rig Listener',
        version: VERSION,
        connected: state.connected,
        radio: config ? `${config.radio.brand} ${config.radio.model}` : 'unconfigured',
      }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[HTTP] Rig Listener running on port ${port}`);
    console.log(`[HTTP] OpenHamClock connects to: http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${port} is already in use.`);
      console.error('   Is another rig daemon running?\n');
      process.exit(1);
    }
    console.error(`[HTTP] Server error: ${err.message}`);
  });
}

function parseBody(req, cb) {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    try { cb(JSON.parse(data)); }
    catch { cb(null); }
  });
}

// ============================================
// INTERACTIVE SETUP WIZARD
// ============================================
async function runWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   OpenHamClock Rig Listener — Setup Wizard      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // List serial ports
  let ports = [];
  try {
    const { SerialPort } = require('serialport');
    ports = await SerialPort.list();
  } catch (e) {
    console.log('  ⚠️  Could not list serial ports (serialport not installed yet?)');
    console.log(`     Error: ${e.message}`);
  }

  if (ports.length > 0) {
    console.log('  📟 Available serial ports:\n');
    ports.forEach((p, i) => {
      const desc = p.manufacturer
        ? `${p.path}  —  ${p.manufacturer}${p.serialNumber ? ` (${p.serialNumber})` : ''}`
        : p.path;
      console.log(`     ${i + 1}) ${desc}`);
    });
    console.log('');
  } else {
    console.log('  ⚠️  No serial ports detected.');
    console.log('     Make sure your radio is connected via USB.\n');
  }

  // Select port
  let selectedPort = '';
  if (ports.length > 0) {
    const portChoice = await ask(`  Select port (1-${ports.length}, or type path manually): `);
    const idx = parseInt(portChoice) - 1;
    if (idx >= 0 && idx < ports.length) {
      selectedPort = ports[idx].path;
    } else {
      selectedPort = portChoice.trim();
    }
  } else {
    selectedPort = await ask('  Enter serial port (e.g. COM3 or /dev/ttyUSB0): ');
    selectedPort = selectedPort.trim();
  }

  if (!selectedPort) {
    console.log('\n  ❌ No port selected. Exiting.\n');
    rl.close();
    process.exit(1);
  }

  console.log(`\n  ✅ Port: ${selectedPort}\n`);

  // Select brand
  console.log('  📻 Radio brand:\n');
  console.log('     1) Yaesu     (FT-991A, FT-891, FT-710, FT-DX10, FT-817/818, etc.)');
  console.log('     2) Kenwood   (TS-590, TS-890, etc.)');
  console.log('     3) Elecraft  (K3, K4, KX3, KX2, etc.)');
  console.log('     4) Icom      (IC-7300, IC-7610, IC-705, IC-9700, etc.)');
  console.log('');

  const brandChoice = await ask('  Select brand (1-4): ');
  const brands = { '1': 'yaesu', '2': 'kenwood', '3': 'elecraft', '4': 'icom' };
  const brand = brands[brandChoice.trim()] || 'yaesu';

  console.log(`\n  ✅ Brand: ${brand}\n`);

  // Model (optional)
  const model = await ask('  Radio model (optional, e.g. FT-991A): ');

  // Baud rate
  const defaultBaud = brand === 'icom' ? 19200 : 38400;
  console.log(`\n  ⚡ Baud rate (must match your radio's CAT/CI-V rate setting)`);
  console.log(`     Common: 4800, 9600, 19200, 38400, 115200`);
  const baudInput = await ask(`  Baud rate [${defaultBaud}]: `);
  const baudRate = parseInt(baudInput.trim()) || defaultBaud;

  // Stop bits
  const defaultStop = brand === 'yaesu' ? 2 : 1;
  const stopInput = await ask(`  Stop bits (1 or 2) [${defaultStop}]: `);
  const stopBits = parseInt(stopInput.trim()) || defaultStop;

  // Icom CI-V address
  let civAddress = 0x94;
  if (brand === 'icom') {
    console.log('\n  🔧 Icom CI-V Addresses (common defaults):');
    const addrList = Object.entries(ICOM_ADDRESSES);
    addrList.forEach(([name, addr]) => {
      console.log(`     ${name}: 0x${addr.toString(16).toUpperCase()}`);
    });
    const civInput = await ask(`\n  CI-V address [0x${civAddress.toString(16).toUpperCase()}]: `);
    if (civInput.trim()) {
      civAddress = parseInt(civInput.trim(), 16) || civAddress;
    }
  }

  // HTTP port
  const httpInput = await ask(`\n  HTTP port for OpenHamClock [${HTTP_PORT_DEFAULT}]: `);
  const httpPort = parseInt(httpInput.trim()) || HTTP_PORT_DEFAULT;

  rl.close();

  // Build config
  const cfg = {
    serial: {
      port: selectedPort,
      baudRate,
      dataBits: 8,
      stopBits,
      parity: 'none',
    },
    radio: {
      brand,
      model: model.trim() || '',
      civAddress,
      pollInterval: 500,
      pttEnabled: false,
    },
    server: {
      port: httpPort,
    },
  };

  // Save
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`\n  💾 Config saved to ${path.basename(CONFIG_FILE)}`);
  console.log('     Edit this file to change settings or delete it to re-run the wizard.\n');

  return cfg;
}

// ============================================
// CLI ARGUMENT PARSING
// ============================================
function parseCLI() {
  const args = process.argv.slice(2);
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port': case '-p':
        overrides.serialPort = args[++i];
        break;
      case '--baud': case '-b':
        overrides.baudRate = parseInt(args[++i]);
        break;
      case '--brand':
        overrides.brand = args[++i];
        break;
      case '--http-port':
        overrides.httpPort = parseInt(args[++i]);
        break;
      case '--mock':
        overrides.mock = true;
        break;
      case '--wizard':
        overrides.forceWizard = true;
        break;
      case '--help': case '-h':
        console.log(`
OpenHamClock Rig Listener v${VERSION}

Connects your radio directly to OpenHamClock via USB serial.
No flrig or rigctld needed!

First run:
  node rig-listener.js              Interactive setup wizard

Subsequent runs:
  node rig-listener.js              Uses saved config

Options:
  --port, -p <port>    Serial port (e.g. COM3, /dev/ttyUSB0)
  --baud, -b <rate>    Baud rate (default: 38400)
  --brand <brand>      Radio brand: yaesu, kenwood, elecraft, icom
  --http-port <port>   HTTP server port (default: 5555)
  --mock               Simulation mode (no radio needed)
  --wizard             Force re-run of setup wizard
  --help, -h           Show this help

In OpenHamClock Settings:
  Enable Rig Control
  Host: http://localhost
  Port: 5555
`);
        process.exit(0);
    }
  }
  return overrides;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const cli = parseCLI();

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  OpenHamClock Rig Listener v${VERSION}              ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Mock mode
  if (cli.mock) {
    const cfg = {
      ...DEFAULT_CONFIG,
      radio: { ...DEFAULT_CONFIG.radio, brand: 'mock' },
      server: { port: cli.httpPort || HTTP_PORT_DEFAULT },
    };
    config = cfg;
    protocol = MockProtocol;
    state.connected = true;
    state.freq = 14074000;
    state.mode = 'USB';
    console.log('  📻 Simulation mode — no radio needed\n');
    startServer(cfg.server.port);
    return;
  }

  // Load or create config
  let cfg;
  if (cli.forceWizard || !fs.existsSync(CONFIG_FILE)) {
    cfg = await runWizard();
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(`  📂 Config loaded from ${path.basename(CONFIG_FILE)}`);
    } catch (e) {
      console.error(`  ⚠️  Error reading config: ${e.message}`);
      cfg = await runWizard();
    }
  }

  // Apply CLI overrides
  if (cli.serialPort) cfg.serial.port = cli.serialPort;
  if (cli.baudRate) cfg.serial.baudRate = cli.baudRate;
  if (cli.brand) cfg.radio.brand = cli.brand;
  if (cli.httpPort) cfg.server.port = cli.httpPort;

  // Validate
  if (!cfg.serial.port) {
    console.error('\n  ❌ No serial port configured. Run with --wizard to set up.\n');
    process.exit(1);
  }

  console.log(`  📻 Radio: ${cfg.radio.brand.toUpperCase()} ${cfg.radio.model || ''}`);
  console.log(`  🔌 Port:  ${cfg.serial.port} @ ${cfg.serial.baudRate} baud`);
  console.log(`  🌐 HTTP:  http://localhost:${cfg.server.port}`);
  console.log('');

  // Start
  startServer(cfg.server.port);
  await initSerial(cfg);

  console.log('');
  console.log('  In OpenHamClock Settings → Rig Control:');
  console.log('    ☑ Enable Rig Control');
  console.log(`    Host: http://localhost`);
  console.log(`    Port: ${cfg.server.port}`);
  console.log('');
  console.log('  Ctrl+C to stop. 73!');
  console.log('');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n  Shutting down...');
  if (pollTimer) clearInterval(pollTimer);
  if (serialPort && serialPort.isOpen) {
    serialPort.close(() => {
      console.log('  Serial port closed. 73!');
      process.exit(0);
    });
  } else {
    console.log('  73!');
    process.exit(0);
  }
});

process.on('SIGTERM', () => process.emit('SIGINT'));

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}\n`);
  process.exit(1);
});
