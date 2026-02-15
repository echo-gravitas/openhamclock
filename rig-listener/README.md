# OpenHamClock Rig Listener

**Connect your radio to OpenHamClock — download, run, done.**

This lightweight listener talks directly to your radio via USB serial and feeds frequency, mode, and PTT data to OpenHamClock. Click any spot on the map or DX cluster to instantly tune your rig. No flrig, no rigctld, no other software needed.

## Supported Radios

| Brand | Models | Protocol |
|-------|--------|----------|
| **Yaesu** | FT-991A, FT-891, FT-710, FT-DX10, FT-DX101, FT-450D, FT-817/818 | CAT (text) |
| **Kenwood** | TS-590, TS-890, TS-480, TS-2000 | Kenwood (text) |
| **Elecraft** | K3, K4, KX3, KX2 | Kenwood-compatible |
| **Icom** | IC-7300, IC-7610, IC-705, IC-9700, IC-7100 | CI-V (binary) |

---

## Option A: Download & Run (Recommended)

No installation needed. Download the pre-built executable for your OS:

### Windows
1. Download `rig-listener-win-x64.zip` from [Releases](https://github.com/HAMDevs/openhamclock/releases)
2. Extract the zip
3. Double-click `rig-listener-win-x64.exe`
4. The setup wizard walks you through selecting your radio

### macOS
1. Download `rig-listener-mac-x64.zip` from [Releases](https://github.com/HAMDevs/openhamclock/releases)
2. Extract the zip
3. Open Terminal in that folder and run:
   ```bash
   chmod +x rig-listener-mac-x64
   ./rig-listener-mac-x64
   ```
4. If macOS blocks it: System Settings → Privacy & Security → "Allow Anyway"

### Linux
1. Download `rig-listener-linux-x64.zip` from [Releases](https://github.com/HAMDevs/openhamclock/releases)
2. Extract and run:
   ```bash
   chmod +x rig-listener-linux-x64
   ./rig-listener-linux-x64
   ```
3. If you get permission errors: `sudo usermod -a -G dialout $USER` then log out/in

---

## Option B: Run from Source (if you have Node.js)

### Quick Start

```bash
cd rig-listener
npm install
node rig-listener.js
```

### Or use the launcher scripts

**Windows:** Double-click `start-rig-listener.bat`
**Mac/Linux:** Run `./start-rig-listener.sh`

These check for Node.js, install dependencies automatically, and launch the listener.

---

## Setup Wizard

On first run, the wizard will:

```
╔══════════════════════════════════════════════════╗
║   OpenHamClock Rig Listener — Setup Wizard      ║
╚══════════════════════════════════════════════════╝

  📟 Available serial ports:

     1) COM3  —  Silicon Labs (FT-991A)
     2) COM5  —  FTDI

  Select port (1-2): 1

  📻 Radio brand:
     1) Yaesu
     2) Kenwood
     3) Elecraft
     4) Icom

  Select brand (1-4): 1

  ✅ Config saved! Run again anytime — it remembers your settings.
```

Your settings are saved to `rig-listener-config.json` next to the executable. Subsequent runs skip the wizard and connect automatically.

## Connect to OpenHamClock

In **OpenHamClock Settings → Rig Control**:
- ☑ **Enable Rig Control**
- Host: `http://localhost`
- Port: `5555`

**That's it!** Your radio's frequency appears on the dashboard. Click any spot to tune.

## Radio Setup

Before running the listener, make sure CAT control is enabled on your radio:

### Yaesu (FT-991A example)
- Menu → Operation Setting → **CAT Rate** → `38400` (match to wizard)
- Menu → Operation Setting → **CAT TOT** → `100 msec`
- Menu → Operation Setting → **CAT RTS** → `Enable`
- Connect the rear USB-B port to your computer

### Kenwood
- Menu → **COM port** → baud rate to `38400`
- Connect via USB or RS-232

### Icom (IC-7300 example)
- Menu → Connectors → **CI-V** → Baud Rate → `19200`
- Menu → Connectors → CI-V → **CI-V Address** → note the hex value (default `94h`)
- Menu → Connectors → CI-V → CI-V USB Port → **Unlink from [REMOTE]**
- Connect via rear USB port

### Elecraft
- CONFIG → RS232 → Baud → `38400`
- Uses Kenwood-compatible protocol

## Command Line Options

```
rig-listener --wizard             # Re-run setup wizard
rig-listener --port COM3          # Override serial port
rig-listener --baud 9600          # Override baud rate
rig-listener --brand icom         # Override radio brand
rig-listener --http-port 5556     # Different HTTP port
rig-listener --mock               # Simulation mode (no radio)
```

## Testing Without a Radio

```bash
rig-listener --mock
```

Starts in simulation mode (14.074 MHz, USB) so you can test the OpenHamClock integration without hardware connected.

## Troubleshooting

### "No serial ports detected"
- Is the USB cable plugged in?
- **Windows**: Check Device Manager → Ports. Look for "Silicon Labs CP210x" or "FTDI". If missing, install the driver:
  - Most Yaesu/Icom: [Silicon Labs CP210x](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
  - Some radios: [FTDI Drivers](https://ftdichip.com/drivers/)
- **Linux**: `ls /dev/ttyUSB*` — if permission denied: `sudo usermod -a -G dialout $USER`
- **Mac**: `ls /dev/tty.usb*`

### "Cannot open port" / "Port in use"
- Close any other program using the port: flrig, rigctld, WSJT-X, fldigi, etc.
- Only ONE program can use a serial port at a time.

### Connected but no frequency updates
- **Baud rate mismatch**: Must match your radio's CAT rate setting exactly.
- **Wrong brand**: Re-run with `--wizard` to change.
- **Icom CI-V address**: Must match your radio's setting. Check with `--wizard`.

### macOS "unidentified developer" warning
System Settings → Privacy & Security → scroll down → "Allow Anyway" next to the blocked app.

## How It Works

```
┌─────────┐    USB     ┌───────────────┐   HTTP/SSE    ┌──────────────┐
│  Radio   │◄─────────►│ Rig Listener  │◄─────────────►│ OpenHamClock │
│ (FT-991A)│  Serial   │ (port 5555)   │  localhost    │  (browser)   │
└─────────┘   CAT cmd  └───────────────┘               └──────────────┘
```

Polls your radio at 500ms intervals and pushes updates to OpenHamClock via SSE. When you click a spot, OHC sends the frequency back through the listener to the radio.

## Building Executables (for developers)

To build the compiled executables yourself:

```bash
cd rig-listener
npm install
node build.js              # Build for your current platform
node build.js --platform win   # Cross-compile for Windows
```

Output goes to `dist/`. The GitHub Actions workflow automatically builds for all platforms on tagged releases.

## Upgrading from the Old Rig Daemon

If you used the previous `rig-control/rig-daemon.js` with flrig or rigctld:

1. Stop the old daemon and flrig/rigctld
2. Run the rig listener (it uses the same port 5555 and API)
3. OpenHamClock settings stay the same

The old `rig-control/` folder still works if you prefer that setup.
