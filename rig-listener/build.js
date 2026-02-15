#!/usr/bin/env node
/**
 * Build script for OpenHamClock Rig Listener
 *
 * Compiles rig-listener.js into standalone executables for Windows, Mac, and Linux.
 * Uses @yao-pkg/pkg to bundle Node.js runtime + serialport native addon + our code.
 *
 * Usage:
 *   node build.js                  # Build for current platform
 *   node build.js --platform win   # Build for Windows
 *   node build.js --platform mac   # Build for macOS
 *   node build.js --platform linux # Build for Linux
 *   node build.js --all            # Build for all platforms (CI only)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = require('./package.json').version;
const DIST = path.join(__dirname, 'dist');

// Parse args
const args = process.argv.slice(2);
let platform = null;
let buildAll = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' || args[i] === '-p') platform = args[++i];
  if (args[i] === '--all') buildAll = true;
}

// Detect current platform
function detectPlatform() {
  switch (process.platform) {
    case 'win32': return 'win';
    case 'darwin': return 'mac';
    default: return 'linux';
  }
}

// Platform → pkg target mapping
const TARGETS = {
  win:   { pkg: 'node18-win-x64',   name: `rig-listener-win-x64`,   ext: '.exe' },
  mac:   { pkg: 'node18-macos-x64', name: `rig-listener-mac-x64`,   ext: '' },
  linux: { pkg: 'node18-linux-x64', name: `rig-listener-linux-x64`, ext: '' },
};

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
}

function build(plat) {
  const target = TARGETS[plat];
  if (!target) {
    console.error(`Unknown platform: ${plat}. Use: win, mac, linux`);
    process.exit(1);
  }

  const outFile = path.join(DIST, target.name + target.ext);

  console.log(`\n  Building for ${plat} (${target.pkg})...`);
  console.log(`  Output: ${outFile}\n`);

  // Ensure dist dir
  fs.mkdirSync(DIST, { recursive: true });

  // Run pkg
  // --compress GZip shrinks the binary ~30%
  // The pkg.assets in package.json handles the serialport native addon
  run(`npx @yao-pkg/pkg rig-listener.js --target ${target.pkg} --output "${outFile}" --compress GZip`);

  // Verify
  if (fs.existsSync(outFile)) {
    const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
    console.log(`\n  ✅ Built: ${path.basename(outFile)} (${size} MB)`);
  } else {
    console.error(`\n  ❌ Build failed — output not found`);
    process.exit(1);
  }

  return outFile;
}

function createZip(plat, exePath) {
  const target = TARGETS[plat];
  const zipName = `${target.name}-v${VERSION}.zip`;
  const zipPath = path.join(DIST, zipName);

  // Include a README in the zip
  const quickstart = `OpenHamClock Rig Listener v${VERSION}
=====================================

1. Run ${path.basename(exePath)}${plat === 'win' ? ' (double-click)' : ''}
${plat !== 'win' ? '   (You may need: chmod +x ' + path.basename(exePath) + ')\n' : ''}
2. The wizard will walk you through selecting your radio.

3. In OpenHamClock Settings → Rig Control:
   ☑ Enable Rig Control
   Host: http://localhost
   Port: 5555

That's it! Click spots on the map to tune your rig. 73!

Troubleshooting: https://github.com/HAMDevs/openhamclock/blob/main/rig-listener/README.md
`;
  fs.writeFileSync(path.join(DIST, 'QUICKSTART.txt'), quickstart);

  console.log(`  Zipping → ${zipName}`);

  if (plat === 'win') {
    // Use PowerShell on Windows
    try {
      run(`powershell -Command "Compress-Archive -Path '${exePath}','${path.join(DIST, 'QUICKSTART.txt')}' -DestinationPath '${zipPath}' -Force"`);
    } catch {
      console.log('  ⚠️  Could not create zip (PowerShell not available). Skipping zip.');
      return null;
    }
  } else {
    // Use zip command on Mac/Linux
    try {
      run(`cd "${DIST}" && zip -j "${zipName}" "${path.basename(exePath)}" "QUICKSTART.txt"`);
    } catch {
      console.log('  ⚠️  zip command not available. Skipping zip.');
      return null;
    }
  }

  // Clean up temp readme
  try { fs.unlinkSync(path.join(DIST, 'QUICKSTART.txt')); } catch {}

  if (fs.existsSync(zipPath)) {
    const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ✅ Zipped: ${zipName} (${size} MB)`);
  }

  return zipPath;
}

// ============================================
// MAIN
// ============================================
console.log('');
console.log('╔══════════════════════════════════════════════════╗');
console.log(`║  Rig Listener Build — v${VERSION}                    ║`);
console.log('╚══════════════════════════════════════════════════╝');

// Check deps
if (!fs.existsSync(path.join(__dirname, 'node_modules', 'serialport'))) {
  console.log('\n  📦 Installing dependencies...\n');
  run('npm install');
}

if (buildAll) {
  // CI mode: build all platforms (only works on the matching OS for native addons)
  // GitHub Actions will call this once per OS runner
  const plat = platform || detectPlatform();
  const exe = build(plat);
  createZip(plat, exe);
} else {
  // Local build: build for specified or current platform
  const plat = platform || detectPlatform();
  const exe = build(plat);
  createZip(plat, exe);
}

console.log('\n  Done! 73 🎉\n');
