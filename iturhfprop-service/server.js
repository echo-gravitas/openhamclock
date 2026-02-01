/**
 * ITURHFProp Service
 * 
 * REST API wrapper for the ITURHFProp HF propagation prediction engine
 * Implements ITU-R P.533-14 "Method for the prediction of the performance of HF circuits"
 * 
 * Endpoints:
 *   GET /api/predict - Single point prediction
 *   GET /api/predict/hourly - 24-hour prediction
 *   GET /api/health - Health check
 */

const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Paths to ITURHFProp - DATA points to root which contains Data/ and IonMap/ subdirs
const ITURHFPROP_PATH = process.env.ITURHFPROP_PATH || '/opt/iturhfprop/ITURHFProp';
const ITURHFPROP_DATA = process.env.ITURHFPROP_DATA || '/opt/iturhfprop';

// Temp directory for input/output files
const TEMP_DIR = '/tmp/iturhfprop';

// Middleware
app.use(cors());
app.use(express.json());

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// HF band frequencies (MHz) - P.533 valid range is 2-30 MHz
const HF_BANDS = {
  '160m': 2.0,    // Adjusted from 1.9 to meet P.533 minimum of 2 MHz
  '80m': 3.5,
  '60m': 5.3,
  '40m': 7.1,
  '30m': 10.1,
  '20m': 14.1,
  '17m': 18.1,
  '15m': 21.1,
  '12m': 24.9,
  '10m': 28.1
  // Note: 6m (50 MHz) excluded - outside P.533 HF range (2-30 MHz)
};

/**
 * Generate ITURHFProp input file
 */
function generateInputFile(params) {
  const {
    txLat, txLon, rxLat, rxLon,
    year, month, hour,
    ssn = 100,
    txPower = 100,  // Watts
    txGain = 0,     // dBi
    rxGain = 0,     // dBi
    frequencies = Object.values(HF_BANDS),
    manMadeNoise = 'RESIDENTIAL',  // CITY, RESIDENTIAL, RURAL, QUIET
    requiredReliability = 90,
    requiredSNR = 15  // dB for SSB
  } = params;

  // Convert coordinates to ITURHFProp format (decimal degrees)
  const txLatStr = txLat >= 0 ? `${txLat.toFixed(2)} N` : `${Math.abs(txLat).toFixed(2)} S`;
  const txLonStr = txLon >= 0 ? `${txLon.toFixed(2)} E` : `${Math.abs(txLon).toFixed(2)} W`;
  const rxLatStr = rxLat >= 0 ? `${rxLat.toFixed(2)} N` : `${Math.abs(rxLat).toFixed(2)} S`;
  const rxLonStr = rxLon >= 0 ? `${rxLon.toFixed(2)} E` : `${Math.abs(rxLon).toFixed(2)} W`;

  // Format frequencies
  const freqList = frequencies.map(f => f.toFixed(3)).join(' ');
  
  // ITURHFProp input file format - complete version with all required fields
  const input = `PathName "OpenHamClock"
PathTXName "TX"
Path.L_tx.lat ${txLat.toFixed(4)}
Path.L_tx.lng ${txLon.toFixed(4)}
TXAntFilePath "ISOTROPIC"
TXGOS 0.0
PathRXName "RX"
Path.L_rx.lat ${rxLat.toFixed(4)}
Path.L_rx.lng ${rxLon.toFixed(4)}
RXAntFilePath "ISOTROPIC"
RXGOS 0.0
AntennaOrientation "TX2RX"
Path.year ${year}
Path.month ${month}
Path.hour ${hour}
Path.SSN ${ssn}
Path.frequency ${freqList}
Path.txpower ${(10 * Math.log10(txPower / 1000)).toFixed(1)}
Path.BW 3000
Path.SNRr ${requiredSNR}
Path.SNRXXp ${requiredReliability}
Path.ManMadeNoise "${manMadeNoise}"
Path.Modulation ANALOG
Path.SorL SHORTPATH
LL.lat ${rxLat.toFixed(4)}
LL.lng ${rxLon.toFixed(4)}
LR.lat ${rxLat.toFixed(4)}
LR.lng ${rxLon.toFixed(4)}
UL.lat ${rxLat.toFixed(4)}
UL.lng ${rxLon.toFixed(4)}
UR.lat ${rxLat.toFixed(4)}
UR.lng ${rxLon.toFixed(4)}
DataFilePath "${ITURHFPROP_DATA}/Data/"
RptFilePath "/tmp/"
RptFileFormat "RPT_PR | RPT_SNR | RPT_BCR"
`;

  return input;
}

/**
 * Parse ITURHFProp output file
 */
function parseOutputFile(outputPath) {
  try {
    const output = fs.readFileSync(outputPath, 'utf8');
    const lines = output.split('\n');
    
    const results = {
      frequencies: [],
      raw: output.substring(0, 3000)  // Include raw for debugging
    };
    
    let headers = [];
    let inDataSection = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('*')) {
        continue;
      }
      
      // Look for CSV header line
      if (trimmed.includes('Freq') || trimmed.includes('FREQ') || trimmed.includes('frequency')) {
        headers = trimmed.split(/[,\t]+/).map(h => h.trim().toLowerCase());
        inDataSection = true;
        console.log('[Parse] Found headers:', headers);
        continue;
      }
      
      // Parse data lines (CSV or space-separated)
      if (inDataSection) {
        let parts;
        if (trimmed.includes(',')) {
          parts = trimmed.split(',').map(p => p.trim());
        } else {
          parts = trimmed.split(/\s+/);
        }
        
        if (parts.length >= 2 && !isNaN(parseFloat(parts[0]))) {
          const freqResult = {
            freq: parseFloat(parts[0])
          };
          
          // Map based on headers or position
          if (headers.length > 0) {
            headers.forEach((h, i) => {
              if (i < parts.length) {
                const val = parseFloat(parts[i]);
                if (!isNaN(val)) {
                  if (h.includes('snr')) freqResult.snr = val;
                  else if (h.includes('bcr') || h.includes('rel')) freqResult.reliability = val;
                  else if (h.includes('pr') || h.includes('power')) freqResult.sdbw = val;
                  else if (h.includes('muf')) freqResult.muf = val;
                }
              }
            });
          } else {
            // Fallback positional parsing
            if (parts.length >= 2) freqResult.reliability = parseFloat(parts[1]) || 0;
            if (parts.length >= 3) freqResult.snr = parseFloat(parts[2]) || null;
            if (parts.length >= 4) freqResult.sdbw = parseFloat(parts[3]) || null;
          }
          
          console.log('[Parse] Frequency result:', freqResult);
          results.frequencies.push(freqResult);
        }
      }
    }
    
    // Also look for MUF in header section
    const mufMatch = output.match(/(?:BMUF|MUF|Operational MUF)\s*[:=]?\s*([\d.]+)/i);
    if (mufMatch) {
      results.muf = parseFloat(mufMatch[1]);
    }
    
    console.log(`[Parse] Found ${results.frequencies.length} frequency results`);
    return results;
  } catch (err) {
    console.error('[Parse Error]', err.message);
    return { error: err.message, frequencies: [] };
  }
}

/**
 * Run ITURHFProp prediction
 */
async function runPrediction(params) {
  const id = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(TEMP_DIR, `input_${id}.txt`);
  const outputPath = path.join(TEMP_DIR, `output_${id}.txt`);
  
  try {
    // Generate input file
    const inputContent = generateInputFile(params);
    fs.writeFileSync(inputPath, inputContent);
    
    console.log(`[ITURHFProp] Running prediction ${id}`);
    console.log(`[ITURHFProp] TX: ${params.txLat}, ${params.txLon} -> RX: ${params.rxLat}, ${params.rxLon}`);
    console.log(`[ITURHFProp] Input file:\n${inputContent}`);
    
    // Run ITURHFProp
    const startTime = Date.now();
    const cmd = `${ITURHFPROP_PATH} ${inputPath} ${outputPath}`;
    console.log(`[ITURHFProp] Command: ${cmd}`);
    
    try {
      const result = execSync(cmd, {
        timeout: 30000,  // 30 second timeout
        encoding: 'utf8',
        env: { ...process.env, LD_LIBRARY_PATH: '/opt/iturhfprop:' + (process.env.LD_LIBRARY_PATH || '') }
      });
      console.log(`[ITURHFProp] stdout: ${result}`);
    } catch (execError) {
      console.error('[ITURHFProp] Execution failed!');
      console.error('[ITURHFProp] Exit code:', execError.status);
      console.error('[ITURHFProp] stderr:', execError.stderr?.toString() || 'none');
      console.error('[ITURHFProp] stdout:', execError.stdout?.toString() || 'none');
      console.error('[ITURHFProp] Error:', execError.message);
      
      // Try to get any output that was generated
      if (!fs.existsSync(outputPath)) {
        // Check if binary exists and is executable
        try {
          const stats = fs.statSync(ITURHFPROP_PATH);
          console.log(`[ITURHFProp] Binary exists, size: ${stats.size}, mode: ${stats.mode.toString(8)}`);
        } catch (e) {
          console.error(`[ITURHFProp] Binary not found at ${ITURHFPROP_PATH}`);
        }
        
        // Check data directory
        try {
          const dataFiles = fs.readdirSync(ITURHFPROP_DATA + '/Data').slice(0, 5);
          console.log(`[ITURHFProp] Data dir contains: ${dataFiles.join(', ')}...`);
        } catch (e) {
          console.error(`[ITURHFProp] Data dir error: ${e.message}`);
        }
        
        throw new Error(`ITURHFProp failed: ${execError.stderr?.toString() || execError.message}`);
      }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[ITURHFProp] Completed in ${elapsed}ms`);
    
    // Log raw output for debugging
    if (fs.existsSync(outputPath)) {
      const rawOutput = fs.readFileSync(outputPath, 'utf8');
      console.log(`[ITURHFProp] Raw output (first 2000 chars):\n${rawOutput.substring(0, 2000)}`);
    }
    
    // Parse output
    const results = parseOutputFile(outputPath);
    results.elapsed = elapsed;
    results.params = {
      txLat: params.txLat,
      txLon: params.txLon,
      rxLat: params.rxLat,
      rxLon: params.rxLon,
      hour: params.hour,
      month: params.month,
      ssn: params.ssn
    };
    
    return results;
    
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  const binaryExists = fs.existsSync(ITURHFPROP_PATH);
  const dataExists = fs.existsSync(ITURHFPROP_DATA);
  const dataSubExists = fs.existsSync(ITURHFPROP_DATA + '/Data');
  
  // Check for shared libraries
  const libp533Exists = fs.existsSync('/opt/iturhfprop/libp533.so');
  const libp372Exists = fs.existsSync('/opt/iturhfprop/libp372.so');
  
  // Check for ionospheric data (ionos12.bin in Data folder)
  const ionosDataExists = fs.existsSync(ITURHFPROP_DATA + '/Data/ionos12.bin');
  
  res.json({
    status: binaryExists && dataSubExists && libp533Exists && ionosDataExists ? 'healthy' : 'degraded',
    service: 'iturhfprop',
    version: '1.0.0',
    engine: 'ITURHFProp (ITU-R P.533-14)',
    binary: binaryExists ? 'found' : 'missing',
    libp533: libp533Exists ? 'found' : 'missing',
    libp372: libp372Exists ? 'found' : 'missing',
    dataDir: dataSubExists ? 'found' : 'missing',
    ionosData: ionosDataExists ? 'found' : 'missing',
    paths: {
      binary: ITURHFPROP_PATH,
      data: ITURHFPROP_DATA
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * Diagnostic endpoint - test binary execution
 */
app.get('/api/diag', async (req, res) => {
  const results = {
    binary: {},
    libraries: {},
    data: {},
    testRun: {}
  };
  
  // Check binary
  try {
    const stats = fs.statSync(ITURHFPROP_PATH);
    results.binary = {
      exists: true,
      size: stats.size,
      mode: stats.mode.toString(8),
      path: ITURHFPROP_PATH
    };
  } catch (e) {
    results.binary = { exists: false, error: e.message };
  }
  
  // Check libraries
  try {
    const libs = fs.readdirSync('/opt/iturhfprop').filter(f => f.endsWith('.so'));
    results.libraries = { found: libs };
  } catch (e) {
    results.libraries = { error: e.message };
  }
  
  // Check data files
  try {
    const dataFiles = fs.readdirSync(ITURHFPROP_DATA + '/Data').slice(0, 15);
    results.data.dataDir = dataFiles;
  } catch (e) {
    results.data.dataDir = { error: e.message };
  }
  
  // Check for ionospheric data
  try {
    const ionosExists = fs.existsSync(ITURHFPROP_DATA + '/Data/ionos12.bin');
    results.data.ionosData = ionosExists ? 'found' : 'missing';
  } catch (e) {
    results.data.ionosData = { error: e.message };
  }
  
  // Try running ldd on the binary
  try {
    const { execSync } = require('child_process');
    const lddOutput = execSync(`ldd ${ITURHFPROP_PATH} 2>&1`, { encoding: 'utf8' });
    results.testRun.ldd = lddOutput.split('\n').slice(0, 10);
  } catch (e) {
    results.testRun.ldd = { error: e.message };
  }
  
  // Try running the binary with no args to see usage
  try {
    const { execSync } = require('child_process');
    const output = execSync(`${ITURHFPROP_PATH} 2>&1 || true`, { 
      encoding: 'utf8',
      env: { ...process.env, LD_LIBRARY_PATH: '/opt/iturhfprop' }
    });
    results.testRun.usage = output.split('\n').slice(0, 10);
  } catch (e) {
    results.testRun.usage = { error: e.message, stderr: e.stderr?.toString(), stdout: e.stdout?.toString() };
  }
  
  // List ALL files in Data directory
  try {
    const allDataFiles = fs.readdirSync(ITURHFPROP_DATA + '/Data');
    results.data.allFiles = allDataFiles;
    results.data.hasIonos = allDataFiles.some(f => f.includes('ionos'));
    results.data.hasAnt = allDataFiles.some(f => f.endsWith('.ant'));
    results.data.fileCount = allDataFiles.length;
  } catch (e) {
    results.data.allFiles = { error: e.message };
  }
  
  // Create a minimal test input file and try to run
  try {
    const { execSync } = require('child_process');
    const testInput = `PathName "Test"
PathTXName "TX"
Path.L_tx.lat 40.0
Path.L_tx.lng -75.0
TXAntFilePath "ISOTROPIC"
TXGOS 0.0
PathRXName "RX"
Path.L_rx.lat 51.0
Path.L_rx.lng 0.0
RXAntFilePath "ISOTROPIC"
RXGOS 0.0
AntennaOrientation "TX2RX"
Path.year 2025
Path.month 6
Path.hour 12
Path.SSN 100
Path.frequency 14.0
Path.txpower -10.0
Path.BW 3000
Path.SNRr 15
Path.SNRXXp 90
Path.ManMadeNoise "RESIDENTIAL"
Path.Modulation ANALOG
Path.SorL SHORTPATH
LL.lat 51.0
LL.lng 0.0
LR.lat 51.0
LR.lng 0.0
UL.lat 51.0
UL.lng 0.0
UR.lat 51.0
UR.lng 0.0
DataFilePath "${ITURHFPROP_DATA}/Data/"
RptFilePath "/tmp/"
RptFileFormat "RPT_PR | RPT_SNR | RPT_BCR"
`;
    fs.writeFileSync('/tmp/test_input.txt', testInput);
    results.testRun.inputFile = testInput.split('\n');
    
    const testOutput = execSync(`${ITURHFPROP_PATH} /tmp/test_input.txt /tmp/test_output.txt 2>&1 || echo "Exit code: $?"`, {
      encoding: 'utf8',
      env: { ...process.env, LD_LIBRARY_PATH: '/opt/iturhfprop' }
    });
    results.testRun.testExec = testOutput.split('\n').slice(0, 20);
    
    // Check if output was created
    if (fs.existsSync('/tmp/test_output.txt')) {
      const output = fs.readFileSync('/tmp/test_output.txt', 'utf8');
      results.testRun.testOutput = output.split('\n').slice(0, 20);
    } else {
      results.testRun.testOutput = 'No output file created';
    }
  } catch (e) {
    results.testRun.testExec = { error: e.message, stderr: e.stderr?.toString(), stdout: e.stdout?.toString() };
  }
  
  res.json(results);
});

/**
 * Single point prediction
 * 
 * GET /api/predict?txLat=40&txLon=-74&rxLat=51&rxLon=0&month=1&hour=12&ssn=100
 */
app.get('/api/predict', async (req, res) => {
  try {
    const {
      txLat, txLon, rxLat, rxLon,
      month, hour, ssn,
      year = new Date().getFullYear(),
      txPower, frequencies
    } = req.query;
    
    // Validate required params
    if (!txLat || !txLon || !rxLat || !rxLon) {
      return res.status(400).json({ error: 'Missing required coordinates (txLat, txLon, rxLat, rxLon)' });
    }
    
    const params = {
      txLat: parseFloat(txLat),
      txLon: parseFloat(txLon),
      rxLat: parseFloat(rxLat),
      rxLon: parseFloat(rxLon),
      year: parseInt(year),
      month: parseInt(month) || new Date().getMonth() + 1,
      hour: parseInt(hour) || new Date().getUTCHours(),
      ssn: parseInt(ssn) || 100,
      txPower: parseInt(txPower) || 100
    };
    
    if (frequencies) {
      params.frequencies = frequencies.split(',').map(f => parseFloat(f));
    }
    
    const results = await runPrediction(params);
    
    res.json({
      model: 'ITU-R P.533-14',
      engine: 'ITURHFProp',
      ...results
    });
    
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 24-hour prediction
 * 
 * GET /api/predict/hourly?txLat=40&txLon=-74&rxLat=51&rxLon=0&month=1&ssn=100
 */
app.get('/api/predict/hourly', async (req, res) => {
  try {
    const {
      txLat, txLon, rxLat, rxLon,
      month, ssn,
      year = new Date().getFullYear()
    } = req.query;
    
    // Validate required params
    if (!txLat || !txLon || !rxLat || !rxLon) {
      return res.status(400).json({ error: 'Missing required coordinates (txLat, txLon, rxLat, rxLon)' });
    }
    
    const baseParams = {
      txLat: parseFloat(txLat),
      txLon: parseFloat(txLon),
      rxLat: parseFloat(rxLat),
      rxLon: parseFloat(rxLon),
      year: parseInt(year),
      month: parseInt(month) || new Date().getMonth() + 1,
      ssn: parseInt(ssn) || 100
    };
    
    // Run predictions for each hour (0-23 UTC)
    const hourlyResults = [];
    
    for (let hour = 0; hour < 24; hour++) {
      const params = { ...baseParams, hour };
      try {
        const result = await runPrediction(params);
        hourlyResults.push({
          hour,
          muf: result.muf,
          frequencies: result.frequencies
        });
      } catch (err) {
        hourlyResults.push({
          hour,
          error: err.message
        });
      }
    }
    
    res.json({
      model: 'ITU-R P.533-14',
      engine: 'ITURHFProp',
      path: {
        tx: { lat: baseParams.txLat, lon: baseParams.txLon },
        rx: { lat: baseParams.rxLat, lon: baseParams.rxLon }
      },
      month: baseParams.month,
      year: baseParams.year,
      ssn: baseParams.ssn,
      hourly: hourlyResults
    });
    
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Band conditions (simplified format for OpenHamClock)
 * 
 * GET /api/bands?txLat=40&txLon=-74&rxLat=51&rxLon=0
 */
app.get('/api/bands', async (req, res) => {
  try {
    const {
      txLat, txLon, rxLat, rxLon,
      month, hour, ssn
    } = req.query;
    
    if (!txLat || !txLon || !rxLat || !rxLon) {
      return res.status(400).json({ error: 'Missing required coordinates' });
    }
    
    const params = {
      txLat: parseFloat(txLat),
      txLon: parseFloat(txLon),
      rxLat: parseFloat(rxLat),
      rxLon: parseFloat(rxLon),
      year: new Date().getFullYear(),
      month: parseInt(month) || new Date().getMonth() + 1,
      hour: parseInt(hour) ?? new Date().getUTCHours(),
      ssn: parseInt(ssn) || 100,
      frequencies: Object.values(HF_BANDS)
    };
    
    const results = await runPrediction(params);
    
    // Map to band names
    const bands = {};
    const bandFreqs = Object.entries(HF_BANDS);
    
    for (const freqResult of results.frequencies) {
      const bandEntry = bandFreqs.find(([name, freq]) => 
        Math.abs(freq - freqResult.freq) < 1
      );
      
      if (bandEntry) {
        const [bandName] = bandEntry;
        bands[bandName] = {
          freq: freqResult.freq,
          reliability: freqResult.reliability,
          snr: freqResult.snr,
          sdbw: freqResult.sdbw,
          status: freqResult.reliability >= 70 ? 'GOOD' :
                  freqResult.reliability >= 40 ? 'FAIR' : 'POOR'
        };
      }
    }
    
    res.json({
      model: 'ITU-R P.533-14',
      muf: results.muf,
      bands,
      debug: {
        rawOutput: results.raw,
        freqCount: results.frequencies.length,
        parsedFreqs: results.frequencies
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('[API Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`ITURHFProp Service running on port ${PORT}`);
  console.log(`Binary: ${ITURHFPROP_PATH}`);
  console.log(`Data: ${ITURHFPROP_DATA}`);
});
