/**
 * OpenHamClock Server v3.9.0
 * 
 * Express server that:
 * 1. Serves the static web application
 * 2. Proxies API requests to avoid CORS issues
 * 3. Provides hybrid HF propagation predictions (ITURHFProp + real-time ionosonde)
 * 4. Provides WebSocket support for future real-time features
 * 
 * Propagation Model: Hybrid ITU-R P.533-14
 * - ITURHFProp service provides base P.533-14 predictions
 * - KC2G/GIRO ionosonde network provides real-time corrections
 * - Combines both for best accuracy
 * 
 * Usage:
 *   node server.js
 *   PORT=8080 node server.js
 *   ITURHFPROP_URL=https://your-service.railway.app node server.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

// ITURHFProp service URL (optional - enables hybrid mode)
const ITURHFPROP_URL = process.env.ITURHFPROP_URL || null;

// Log configuration
if (ITURHFPROP_URL) {
  console.log(`[Propagation] Hybrid mode enabled - ITURHFProp service: ${ITURHFPROP_URL}`);
} else {
  console.log('[Propagation] Standalone mode - using built-in calculations');
}

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// RATE-LIMITED LOGGING
// ============================================
// Prevents log spam when services are down
const errorLogState = {};
const ERROR_LOG_INTERVAL = 60000; // Only log same error once per minute

function logErrorOnce(category, message) {
  const key = `${category}:${message}`;
  const now = Date.now();
  const lastLogged = errorLogState[key] || 0;
  
  if (now - lastLogged >= ERROR_LOG_INTERVAL) {
    errorLogState[key] = now;
    console.error(`[${category}] ${message}`);
    return true;
  }
  return false;
}

// Serve static files - use 'dist' in production (Vite build), 'public' in development
const staticDir = process.env.NODE_ENV === 'production' 
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, 'public');
app.use(express.static(staticDir));

// Also serve public folder for any additional assets
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'public')));
}

// ============================================
// API PROXY ENDPOINTS
// ============================================

// NOAA Space Weather - Solar Flux
app.get('/api/noaa/flux', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA Flux API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch solar flux data' });
  }
});

// NOAA Space Weather - K-Index
app.get('/api/noaa/kindex', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA K-Index API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch K-index data' });
  }
});

// NOAA Space Weather - Sunspots
app.get('/api/noaa/sunspots', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA Sunspots API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch sunspot data' });
  }
});

// Solar Indices with History and Kp Forecast
app.get('/api/solar-indices', async (req, res) => {
  try {
    const [fluxRes, kIndexRes, kForecastRes, sunspotRes] = await Promise.allSettled([
      fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json')
    ]);

    const result = {
      sfi: { current: null, history: [] },
      kp: { current: null, history: [], forecast: [] },
      ssn: { current: null, history: [] },
      timestamp: new Date().toISOString()
    };

    // Process SFI data (last 30 days)
    if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
      const data = await fluxRes.value.json();
      if (data?.length) {
        // Get last 30 entries
        const recent = data.slice(-30);
        result.sfi.history = recent.map(d => ({
          date: d.time_tag || d.date,
          value: Math.round(d.flux || d.value || 0)
        }));
        result.sfi.current = result.sfi.history[result.sfi.history.length - 1]?.value || null;
      }
    }

    // Process Kp history (last 3 days, data comes in 3-hour intervals)
    if (kIndexRes.status === 'fulfilled' && kIndexRes.value.ok) {
      const data = await kIndexRes.value.json();
      if (data?.length > 1) {
        // Skip header row, get last 24 entries (3 days)
        const recent = data.slice(1).slice(-24);
        result.kp.history = recent.map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
        result.kp.current = result.kp.history[result.kp.history.length - 1]?.value || null;
      }
    }

    // Process Kp forecast
    if (kForecastRes.status === 'fulfilled' && kForecastRes.value.ok) {
      const data = await kForecastRes.value.json();
      if (data?.length > 1) {
        // Skip header row
        result.kp.forecast = data.slice(1).map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
      }
    }

    // Process Sunspot data (last 12 months)
    if (sunspotRes.status === 'fulfilled' && sunspotRes.value.ok) {
      const data = await sunspotRes.value.json();
      if (data?.length) {
        // Get last 12 entries (monthly data)
        const recent = data.slice(-12);
        result.ssn.history = recent.map(d => ({
          date: `${d['time-tag'] || d.time_tag || ''}`,
          value: Math.round(d.ssn || 0)
        }));
        result.ssn.current = result.ssn.history[result.ssn.history.length - 1]?.value || null;
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Solar Indices API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch solar indices' });
  }
});

// DXpedition Calendar - fetches from NG3K ADXO plain text version
let dxpeditionCache = { data: null, timestamp: 0, maxAge: 30 * 60 * 1000 }; // 30 min cache

app.get('/api/dxpeditions', async (req, res) => {
  try {
    const now = Date.now();
    console.log('[DXpeditions] API called');
    
    // Return cached data if fresh
    if (dxpeditionCache.data && (now - dxpeditionCache.timestamp) < dxpeditionCache.maxAge) {
      console.log('[DXpeditions] Returning cached data:', dxpeditionCache.data.dxpeditions?.length, 'entries');
      return res.json(dxpeditionCache.data);
    }
    
    // Fetch NG3K ADXO plain text version
    console.log('[DXpeditions] Fetching from NG3K...');
    const response = await fetch('https://www.ng3k.com/Misc/adxoplain.html');
    if (!response.ok) {
      console.log('[DXpeditions] NG3K fetch failed:', response.status);
      throw new Error('Failed to fetch NG3K: ' + response.status);
    }
    
    let text = await response.text();
    console.log('[DXpeditions] Received', text.length, 'bytes raw');
    
    // Strip HTML tags and decode entities - the "plain" page is actually HTML!
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles  
      .replace(/<br\s*\/?>/gi, '\n') // Convert br to newlines
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    console.log('[DXpeditions] Cleaned text length:', text.length);
    console.log('[DXpeditions] First 500 chars:', text.substring(0, 500));
    
    const dxpeditions = [];
    
    // Each entry starts with a date pattern like "Jan 1-Feb 16, 2026 DXCC:"
    // Split on date patterns that are followed by DXCC
    const entryPattern = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}[^D]*?DXCC:[^·]+?)(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|$)/gi;
    const entries = text.match(entryPattern) || [];
    
    console.log('[DXpeditions] Found', entries.length, 'potential entries');
    
    // Log first 3 entries for debugging
    entries.slice(0, 3).forEach((e, i) => {
      console.log(`[DXpeditions] Entry ${i}:`, e.substring(0, 150));
    });
    
    for (const entry of entries) {
      if (!entry.trim()) continue;
      
      // Skip header/footer/legend content
      if (entry.includes('ADXB=') || entry.includes('OPDX=') || entry.includes('425DX=') ||
          entry.includes('Last updated') || entry.includes('Copyright') || 
          entry.includes('Expired Announcements') || entry.includes('Table Version') ||
          entry.includes('About ADXO') || entry.includes('Search ADXO') ||
          entry.includes('GazDX=') || entry.includes('LNDX=') || entry.includes('TDDX=') ||
          entry.includes('DXW.Net=') || entry.includes('DXMB=')) continue;
      
      // Try multiple parsing strategies
      let callsign = null;
      let entity = null;
      let qsl = null;
      let info = null;
      let dateStr = null;
      
      // Strategy 1: "DXCC: xxx Callsign: xxx" format
      const dxccMatch = entry.match(/DXCC:\s*([^C\n]+?)(?=Callsign:|QSL:|Source:|Info:|$)/i);
      const callMatch = entry.match(/Callsign:\s*([A-Z0-9\/]+)/i);
      
      if (callMatch && dxccMatch) {
        callsign = callMatch[1].trim().toUpperCase();
        entity = dxccMatch[1].trim();
      }
      
      // Strategy 2: Look for callsign patterns directly (like "3Y0K" or "VP8/G3ABC")
      if (!callsign) {
        const directCallMatch = entry.match(/\b([A-Z]{1,2}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]+)?)\b/);
        if (directCallMatch) {
          callsign = directCallMatch[1];
        }
      }
      
      // Strategy 3: Parse "Entity - Callsign" or similar patterns
      if (!callsign) {
        const altMatch = entry.match(/([A-Za-z\s&]+?)\s*[-–:]\s*([A-Z]{1,2}\d[A-Z0-9]*)/);
        if (altMatch) {
          entity = altMatch[1].trim();
          callsign = altMatch[2].trim();
        }
      }
      
      // Extract other fields
      const qslMatch = entry.match(/QSL:\s*([A-Za-z0-9]+)/i);
      const infoMatch = entry.match(/Info:\s*(.+)/i);
      // Date is at the start of entry: "Jan 1-Feb 16, 2026"
      const dateMatch = entry.match(/^([A-Za-z]{3}\s+\d{1,2}[^D]*?)(?=DXCC:)/i);
      
      qsl = qslMatch ? qslMatch[1].trim() : '';
      info = infoMatch ? infoMatch[1].trim() : '';
      dateStr = dateMatch ? dateMatch[1].trim() : '';
      
      // Skip if we couldn't find a callsign
      if (!callsign || callsign.length < 3) continue;
      
      // Skip obviously wrong matches
      if (/^(DXCC|QSL|INFO|SOURCE|THE|AND|FOR)$/i.test(callsign)) continue;
      
      // Log first few successful parses
      if (dxpeditions.length < 3) {
        console.log(`[DXpeditions] Parsed: ${callsign} - ${entity} - ${dateStr}`);
      }
      
      // Try to extract entity from context if not found
      if (!entity && info) {
        // Look for "from Entity" or "fm Entity" patterns
        const fromMatch = info.match(/(?:from|fm)\s+([A-Za-z\s]+?)(?:;|,|$)/i);
        if (fromMatch) entity = fromMatch[1].trim();
      }
      
      // Parse dates
      let startDate = null;
      let endDate = null;
      let isActive = false;
      let isUpcoming = false;
      
      if (dateStr) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const datePattern = /([A-Za-z]{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\s*[-–]\s*([A-Za-z]{3})?\s*(\d{1,2})(?:,?\s*(\d{4}))?)?/i;
        const dateParsed = dateStr.match(datePattern);
        
        if (dateParsed) {
          const currentYear = new Date().getFullYear();
          const startMonth = monthNames.indexOf(dateParsed[1].toLowerCase());
          const startDay = parseInt(dateParsed[2]);
          const startYear = dateParsed[3] ? parseInt(dateParsed[3]) : currentYear;
          
          const endMonthStr = dateParsed[4] || dateParsed[1];
          const endMonth = monthNames.indexOf(endMonthStr.toLowerCase());
          const endDay = parseInt(dateParsed[5]) || startDay + 14;
          const endYear = dateParsed[6] ? parseInt(dateParsed[6]) : startYear;
          
          if (startMonth >= 0) {
            startDate = new Date(startYear, startMonth, startDay);
            endDate = new Date(endYear, endMonth >= 0 ? endMonth : startMonth, endDay);
            
            if (endDate < startDate && !dateParsed[6]) {
              endDate.setFullYear(endYear + 1);
            }
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            isActive = startDate <= today && endDate >= today;
            isUpcoming = startDate > today;
          }
        }
      }
      
      // Extract bands and modes
      const bandsMatch = entry.match(/(\d+(?:-\d+)?m)/g);
      const bands = bandsMatch ? [...new Set(bandsMatch)].join(' ') : '';
      
      const modesMatch = entry.match(/\b(CW|SSB|FT8|FT4|RTTY|PSK|FM|AM|DIGI)\b/gi);
      const modes = modesMatch ? [...new Set(modesMatch.map(m => m.toUpperCase()))].join(' ') : '';
      
      dxpeditions.push({
        callsign,
        entity: entity || 'Unknown',
        dates: dateStr,
        qsl,
        info: (info || '').substring(0, 100),
        bands,
        modes,
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
        isActive,
        isUpcoming
      });
    }
    
    // Remove duplicates by callsign
    const seen = new Set();
    const uniqueDxpeditions = dxpeditions.filter(d => {
      if (seen.has(d.callsign)) return false;
      seen.add(d.callsign);
      return true;
    });
    
    // Sort: active first, then upcoming by start date
    uniqueDxpeditions.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isUpcoming && !b.isUpcoming) return -1;
      if (!a.isUpcoming && b.isUpcoming) return 1;
      if (a.startDate && b.startDate) return new Date(a.startDate) - new Date(b.startDate);
      return 0;
    });
    
    console.log('[DXpeditions] Parsed', uniqueDxpeditions.length, 'unique entries');
    if (uniqueDxpeditions.length > 0) {
      console.log('[DXpeditions] First entry:', JSON.stringify(uniqueDxpeditions[0]));
    }
    
    const result = {
      dxpeditions: uniqueDxpeditions.slice(0, 50),
      active: uniqueDxpeditions.filter(d => d.isActive).length,
      upcoming: uniqueDxpeditions.filter(d => d.isUpcoming).length,
      source: 'NG3K ADXO',
      timestamp: new Date().toISOString()
    };
    
    console.log('[DXpeditions] Result:', result.active, 'active,', result.upcoming, 'upcoming');
    
    dxpeditionCache.data = result;
    dxpeditionCache.timestamp = now;
    
    res.json(result);
  } catch (error) {
    console.error('[DXpeditions] API error:', error.message);
    
    if (dxpeditionCache.data) {
      console.log('[DXpeditions] Returning stale cache');
      return res.json({ ...dxpeditionCache.data, stale: true });
    }
    
    res.status(500).json({ error: 'Failed to fetch DXpedition data' });
  }
});

// NOAA Space Weather - X-Ray Flux
app.get('/api/noaa/xray', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA X-Ray API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch X-ray data' });
  }
});

// POTA Spots
app.get('/api/pota/spots', async (req, res) => {
  try {
    const response = await fetch('https://api.pota.app/spot/activator');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('POTA API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch POTA spots' });
  }
});

// SOTA Spots
app.get('/api/sota/spots', async (req, res) => {
  try {
    const response = await fetch('https://api2.sota.org.uk/api/spots/50/all');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('SOTA API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch SOTA spots' });
  }
});

// HamQSL Band Conditions
app.get('/api/hamqsl/conditions', async (req, res) => {
  try {
    const response = await fetch('https://www.hamqsl.com/solarxml.php');
    const text = await response.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (error) {
    console.error('HamQSL API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch band conditions' });
  }
});

// DX Cluster proxy - fetches from selectable sources
// Query param: ?source=hamqth|dxspider|proxy|auto (default: auto)
// Note: DX Spider uses telnet - works locally but may be blocked on cloud hosting
// The 'proxy' source uses our DX Spider Proxy microservice

// DX Spider Proxy URL (sibling service on Railway or external)
const DXSPIDER_PROXY_URL = process.env.DXSPIDER_PROXY_URL || 'https://dxspider-proxy-production-1ec7.up.railway.app';

// Cache for DX Spider telnet spots (to avoid excessive connections)
let dxSpiderCache = { spots: [], timestamp: 0 };
const DXSPIDER_CACHE_TTL = 90000; // 90 seconds cache - reduces reconnection frequency

app.get('/api/dxcluster/spots', async (req, res) => {
  const source = (req.query.source || 'auto').toLowerCase();
  
  // Helper function for HamQTH (HTTP-based, works everywhere)
  async function fetchHamQTH() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=25', {
        headers: { 'User-Agent': 'OpenHamClock/3.5' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const text = await response.text();
        // HamQTH CSV format: Spotter^Frequency^DXCall^Comment^TimeDate^^^Continent^Band^Country^DXCC
        // Example: KF0NYM^18070.0^TX5U^Correction, Good Sig MO, 73^2149 2025-05-27^^^EU^17M^France^227
        const lines = text.trim().split('\n').filter(line => line.includes('^'));
        
        if (lines.length > 0) {
          const spots = lines.slice(0, 25).map(line => {
            const parts = line.split('^');
            const spotter = parts[0] || '';
            const freqKhz = parseFloat(parts[1]) || 0;
            const dxCall = parts[2] || 'UNKNOWN';
            const comment = parts[3] || '';
            const timeDate = parts[4] || '';
            
            // Frequency: convert from kHz to MHz
            const freqMhz = freqKhz > 1000 ? (freqKhz / 1000).toFixed(3) : String(freqKhz);
            
            // Time: extract HHMM from "2149 2025-05-27" format
            let time = '';
            if (timeDate && timeDate.length >= 4) {
              const timeStr = timeDate.substring(0, 4);
              time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
            }
            
            return {
              freq: freqMhz,
              call: dxCall,
              comment: comment,
              time: time,
              spotter: spotter,
              source: 'HamQTH'
            };
          });
          console.log('[DX Cluster] HamQTH:', spots.length, 'spots');
          return spots;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name !== 'AbortError') {
        logErrorOnce('DX Cluster', `HamQTH: ${error.message}`);
      }
    }
    return null;
  }
  
  // Helper function for DX Spider Proxy (our microservice)
  async function fetchDXSpiderProxy() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch(`${DXSPIDER_PROXY_URL}/api/dxcluster/spots?limit=50`, {
        headers: { 'User-Agent': 'OpenHamClock/3.5' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const spots = await response.json();
        if (Array.isArray(spots) && spots.length > 0) {
          console.log('[DX Cluster] DX Spider Proxy:', spots.length, 'spots');
          return spots;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name !== 'AbortError') {
        logErrorOnce('DX Cluster', `Proxy: ${error.message}`);
      }
    }
    return null;
  }
  
  // Helper function for DX Spider (telnet-based, works locally/Pi)
  // Multiple nodes for failover
  // DX Spider nodes - dxspider.co.uk primary per G6NHU
  // SSID -56 for OpenHamClock (HamClock uses -55)
  const DXSPIDER_NODES = [
    { host: 'dxspider.co.uk', port: 7300 },
    { host: 'dxc.nc7j.com', port: 7373 },
    { host: 'dxc.ai9t.com', port: 7373 },
    { host: 'dxc.w6cua.org', port: 7300 }
  ];
  const DXSPIDER_SSID = '-56'; // OpenHamClock SSID
  
  async function fetchDXSpider() {
    // Check cache first (use longer cache to reduce connection attempts)
    if (Date.now() - dxSpiderCache.timestamp < DXSPIDER_CACHE_TTL && dxSpiderCache.spots.length > 0) {
      console.log('[DX Cluster] DX Spider: returning', dxSpiderCache.spots.length, 'cached spots');
      return dxSpiderCache.spots;
    }
    
    // Try each node until one succeeds
    for (const node of DXSPIDER_NODES) {
      const result = await tryDXSpiderNode(node);
      if (result && result.length > 0) {
        return result;
      }
    }
    
    console.log('[DX Cluster] DX Spider: all nodes failed');
    return null;
  }
  
  function tryDXSpiderNode(node) {
    return new Promise((resolve) => {
      const spots = [];
      let buffer = '';
      let loginSent = false;
      let commandSent = false;
      let resolved = false;
      
      const client = new net.Socket();
      client.setTimeout(12000);
      
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try { client.destroy(); } catch(e) {}
        }
      };
      
      // Try connecting to DX Spider node
      client.connect(node.port, node.host, () => {
        console.log(`[DX Cluster] DX Spider: connected to ${node.host}:${node.port}`);
      });
      
      client.on('data', (data) => {
        buffer += data.toString();
        
        // Wait for login prompt
        if (!loginSent && (buffer.includes('login:') || buffer.includes('Please enter your call') || buffer.includes('enter your callsign'))) {
          loginSent = true;
          client.write('GUEST\r\n');
          return;
        }
        
        // Wait for prompt after login, then send command
        if (loginSent && !commandSent && (buffer.includes('Hello') || buffer.includes('de ') || buffer.includes('>') || buffer.includes('GUEST'))) {
          commandSent = true;
          setTimeout(() => {
            if (!resolved) {
              client.write('sh/dx 25\r\n');
            }
          }, 1000);
          return;
        }
        
        // Parse DX spots from the output
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.includes('DX de ')) {
            const match = line.match(/DX de ([A-Z0-9\/\-]+):\s+(\d+\.?\d*)\s+([A-Z0-9\/\-]+)\s+(.+?)\s+(\d{4})Z/i);
            if (match) {
              const spotter = match[1].replace(':', '');
              const freqKhz = parseFloat(match[2]);
              const dxCall = match[3];
              const comment = match[4].trim();
              const timeStr = match[5];
              
              if (!isNaN(freqKhz) && freqKhz > 0 && dxCall) {
                const freqMhz = (freqKhz / 1000).toFixed(3);
                const time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
                
                // Avoid duplicates
                if (!spots.find(s => s.call === dxCall && s.freq === freqMhz)) {
                  spots.push({
                    freq: freqMhz,
                    call: dxCall,
                    comment: comment,
                    time: time,
                    spotter: spotter,
                    source: 'DX Spider'
                  });
                }
              }
            }
          }
        }
        
        // If we have enough spots, close connection
        if (spots.length >= 20) {
          client.write('bye\r\n');
          setTimeout(cleanup, 500);
        }
      });
      
      client.on('timeout', () => {
        cleanup();
      });
      
      client.on('error', (err) => {
        // Only log unexpected errors, not connection issues (they're common)
        if (!err.message.includes('ECONNRESET') && !err.message.includes('ETIMEDOUT') && !err.message.includes('ENOTFOUND') && !err.message.includes('ECONNREFUSED')) {
          logErrorOnce('DX Cluster', `DX Spider ${node.host}: ${err.message}`);
        }
        cleanup();
      });
      
      client.on('close', () => {
        if (!resolved) {
          resolved = true;
          if (spots.length > 0) {
            console.log('[DX Cluster] DX Spider:', spots.length, 'spots from', node.host);
            dxSpiderCache = { spots: spots, timestamp: Date.now() };
            resolve(spots);
          } else {
            resolve(null);
          }
        }
      });
      
      // Fallback timeout - close after 15 seconds regardless
      setTimeout(() => {
        if (!resolved) {
          if (spots.length > 0) {
            resolved = true;
            console.log('[DX Cluster] DX Spider:', spots.length, 'spots from', node.host);
            dxSpiderCache = { spots: spots, timestamp: Date.now() };
            resolve(spots);
          }
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      }, 15000);
    });
  }
  
  // Fetch based on selected source
  let spots = null;
  
  if (source === 'hamqth') {
    spots = await fetchHamQTH();
  } else if (source === 'proxy') {
    spots = await fetchDXSpiderProxy();
    // Fallback to HamQTH if proxy fails
    if (!spots) {
      console.log('[DX Cluster] Proxy failed, falling back to HamQTH');
      spots = await fetchHamQTH();
    }
  } else if (source === 'dxspider') {
    spots = await fetchDXSpider();
    // Fallback to HamQTH if DX Spider fails
    if (!spots) {
      console.log('[DX Cluster] DX Spider failed, falling back to HamQTH');
      spots = await fetchHamQTH();
    }
  } else {
    // Auto mode - try Proxy first (best for Railway), then HamQTH, then DX Spider
    spots = await fetchDXSpiderProxy();
    if (!spots) {
      spots = await fetchHamQTH();
    }
    if (!spots) {
      spots = await fetchDXSpider();
    }
  }
  
  res.json(spots || []);
});

// Get available DX cluster sources
app.get('/api/dxcluster/sources', (req, res) => {
  res.json([
    { id: 'auto', name: 'Auto (Best Available)', description: 'Tries Proxy first, then HamQTH, then direct telnet' },
    { id: 'proxy', name: 'DX Spider Proxy ⭐', description: 'Our dedicated proxy service - real-time telnet feed via HTTP' },
    { id: 'hamqth', name: 'HamQTH', description: 'HamQTH.com CSV feed (HTTP, works everywhere)' },
    { id: 'dxspider', name: 'DX Spider Direct', description: 'Direct telnet to dxspider.co.uk (G6NHU) - works locally/Pi' }
  ]);
});

// ============================================
// DX SPOT PATHS API - Get spots with locations for map visualization
// Returns spots from the last 5 minutes with spotter and DX locations
// ============================================

// Cache for DX spot paths to avoid excessive lookups
let dxSpotPathsCache = { paths: [], allPaths: [], timestamp: 0 };
const DXPATHS_CACHE_TTL = 5000; // 5 seconds cache between fetches
const DXPATHS_RETENTION = 30 * 60 * 1000; // 30 minute spot retention

app.get('/api/dxcluster/paths', async (req, res) => {
  // Check cache first
  if (Date.now() - dxSpotPathsCache.timestamp < DXPATHS_CACHE_TTL && dxSpotPathsCache.paths.length > 0) {
    console.log('[DX Paths] Returning', dxSpotPathsCache.paths.length, 'cached paths');
    return res.json(dxSpotPathsCache.paths);
  }
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const now = Date.now();
    
    // Try proxy first for better real-time data
    let newSpots = [];
    let usedSource = 'none';
    
    try {
      const proxyResponse = await fetch(`${DXSPIDER_PROXY_URL}/api/spots?limit=100`, {
        headers: { 'User-Agent': 'OpenHamClock/3.7' },
        signal: controller.signal
      });
      
      if (proxyResponse.ok) {
        const proxyData = await proxyResponse.json();
        if (proxyData.spots && proxyData.spots.length > 0) {
          usedSource = 'proxy';
          newSpots = proxyData.spots.map(s => ({
            spotter: s.spotter,
            spotterGrid: s.spotterGrid || null,
            dxCall: s.call,
            dxGrid: s.dxGrid || null,
            freq: s.freq,
            comment: s.comment || '',
            time: s.time || '',
            id: `${s.call}-${s.freqKhz || s.freq}-${s.spotter}`
          }));
          console.log('[DX Paths] Got', newSpots.length, 'spots from proxy');
        }
      }
    } catch (proxyErr) {
      console.log('[DX Paths] Proxy failed, trying HamQTH');
    }
    
    // Fallback to HamQTH if proxy failed
    if (newSpots.length === 0) {
      try {
        const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=50', {
          headers: { 'User-Agent': 'OpenHamClock/3.7' },
          signal: controller.signal
        });
        
        if (response.ok) {
          const text = await response.text();
          const lines = text.trim().split('\n').filter(line => line.includes('^'));
          usedSource = 'hamqth';
          
          for (const line of lines) {
            const parts = line.split('^');
            if (parts.length < 5) continue;
            
            const spotter = parts[0]?.trim().toUpperCase();
            const freqKhz = parseFloat(parts[1]) || 0;
            const dxCall = parts[2]?.trim().toUpperCase();
            const comment = parts[3]?.trim() || '';
            const timeDate = parts[4]?.trim() || '';
            
            if (!spotter || !dxCall || freqKhz <= 0) continue;
            
            // Extract grids from comment for HamQTH data too
            const grids = extractGridsFromComment(comment);
            
            newSpots.push({
              spotter,
              spotterGrid: grids.spotterGrid,
              dxCall,
              dxGrid: grids.dxGrid,
              freq: (freqKhz / 1000).toFixed(3),
              comment,
              time: timeDate.length >= 4 ? timeDate.substring(0, 2) + ':' + timeDate.substring(2, 4) + 'z' : '',
              id: `${dxCall}-${freqKhz}-${spotter}`
            });
          }
          console.log('[DX Paths] Got', newSpots.length, 'spots from HamQTH');
        }
      } catch (hamqthErr) {
        console.log('[DX Paths] HamQTH also failed');
      }
    }
    
    clearTimeout(timeout);
    
    if (newSpots.length === 0) {
      // Return existing paths if fetch failed
      const validPaths = dxSpotPathsCache.allPaths.filter(p => (now - p.timestamp) < DXPATHS_RETENTION);
      return res.json(validPaths.slice(0, 50));
    }
    
    // Get unique callsigns to look up
    const allCalls = new Set();
    newSpots.forEach(s => {
      allCalls.add(s.spotter);
      allCalls.add(s.dxCall);
    });
    
    // Look up prefix-based locations for all callsigns (includes grid squares!)
    const prefixLocations = {};
    const callsToLookup = [...allCalls].slice(0, 100);
    
    for (const call of callsToLookup) {
      const loc = estimateLocationFromPrefix(call);
      if (loc) {
        prefixLocations[call] = { 
          lat: loc.lat, 
          lon: loc.lon, 
          country: loc.country, 
          grid: loc.grid || null,  // Include grid from prefix mapping!
          source: loc.grid ? 'prefix-grid' : 'prefix' 
        };
      }
    }
    
    // Build new paths with locations - try grid first, fall back to prefix
    const newPaths = newSpots
      .map(spot => {
        // DX station location - try grid from spot data first, then comment, then prefix
        let dxLoc = null;
        let dxGridSquare = null;
        
        // Check if spot already has dxGrid from proxy
        if (spot.dxGrid) {
          const gridLoc = maidenheadToLatLon(spot.dxGrid);
          if (gridLoc) {
            dxLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
            dxGridSquare = spot.dxGrid;
          }
        }
        
        // If no grid yet, try extracting from comment
        if (!dxLoc && spot.comment) {
          const extractedGrids = extractGridsFromComment(spot.comment);
          if (extractedGrids.dxGrid) {
            const gridLoc = maidenheadToLatLon(extractedGrids.dxGrid);
            if (gridLoc) {
              dxLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
              dxGridSquare = extractedGrids.dxGrid;
            }
          }
        }
        
        // Fall back to prefix location (now includes grid-based coordinates!)
        if (!dxLoc) {
          dxLoc = prefixLocations[spot.dxCall];
          if (dxLoc && dxLoc.grid) {
            dxGridSquare = dxLoc.grid;
          }
        }
        
        // Spotter location - try grid first, then prefix
        let spotterLoc = null;
        let spotterGridSquare = null;
        
        // Check if spot already has spotterGrid from proxy
        if (spot.spotterGrid) {
          const gridLoc = maidenheadToLatLon(spot.spotterGrid);
          if (gridLoc) {
            spotterLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
            spotterGridSquare = spot.spotterGrid;
          }
        }
        
        // If no grid yet, try extracting from comment (in case of dual grid format)
        if (!spotterLoc && spot.comment) {
          const extractedGrids = extractGridsFromComment(spot.comment);
          if (extractedGrids.spotterGrid) {
            const gridLoc = maidenheadToLatLon(extractedGrids.spotterGrid);
            if (gridLoc) {
              spotterLoc = { lat: gridLoc.lat, lon: gridLoc.lon, country: '', source: 'grid' };
              spotterGridSquare = extractedGrids.spotterGrid;
            }
          }
        }
        
        // Fall back to prefix location for spotter (now includes grid-based coordinates!)
        if (!spotterLoc) {
          spotterLoc = prefixLocations[spot.spotter];
          if (spotterLoc && spotterLoc.grid) {
            spotterGridSquare = spotterLoc.grid;
          }
        }
        
        if (spotterLoc && dxLoc) {
          return {
            spotter: spot.spotter,
            spotterLat: spotterLoc.lat,
            spotterLon: spotterLoc.lon,
            spotterCountry: spotterLoc.country || '',
            spotterGrid: spotterGridSquare,
            spotterLocSource: spotterLoc.source,
            dxCall: spot.dxCall,
            dxLat: dxLoc.lat,
            dxLon: dxLoc.lon,
            dxCountry: dxLoc.country || '',
            dxGrid: dxGridSquare,
            dxLocSource: dxLoc.source,
            freq: spot.freq,
            comment: spot.comment,
            time: spot.time,
            id: spot.id,
            timestamp: now
          };
        }
        return null;
      })
      .filter(p => p !== null);
    
    // Merge with existing paths, removing expired and duplicates
    const existingValidPaths = dxSpotPathsCache.allPaths.filter(p => 
      (now - p.timestamp) < DXPATHS_RETENTION
    );
    
    // Add new paths, avoiding duplicates (same dxCall+freq within 2 minutes)
    const mergedPaths = [...existingValidPaths];
    for (const newPath of newPaths) {
      const isDuplicate = mergedPaths.some(existing => 
        existing.dxCall === newPath.dxCall && 
        existing.freq === newPath.freq &&
        (now - existing.timestamp) < 120000 // 2 minute dedup window
      );
      if (!isDuplicate) {
        mergedPaths.push(newPath);
      }
    }
    
    // Sort by timestamp (newest first) and limit
    const sortedPaths = mergedPaths.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
    
    console.log('[DX Paths]', sortedPaths.length, 'total paths (', newPaths.length, 'new from', newSpots.length, 'spots)');
    
    // Update cache
    dxSpotPathsCache = { 
      paths: sortedPaths.slice(0, 50), // Return 50 for display
      allPaths: sortedPaths, // Keep all for accumulation
      timestamp: now 
    };
    
    res.json(dxSpotPathsCache.paths);
  } catch (error) {
    console.error('[DX Paths] Error:', error.message);
    // Return cached data on error
    res.json(dxSpotPathsCache.paths || []);
  }
});

// ============================================
// CALLSIGN LOOKUP API (for getting location from callsign)
// ============================================

// Simple callsign to grid/location lookup using HamQTH
app.get('/api/callsign/:call', async (req, res) => {
  const callsign = req.params.call.toUpperCase();
  console.log('[Callsign Lookup] Looking up:', callsign);
  
  try {
    // Try HamQTH XML API (no auth needed for basic lookup)
    const response = await fetch(`https://www.hamqth.com/dxcc.php?callsign=${callsign}`);
    if (response.ok) {
      const text = await response.text();
      
      // Parse basic info from response
      const latMatch = text.match(/<lat>([^<]+)<\/lat>/);
      const lonMatch = text.match(/<lng>([^<]+)<\/lng>/);
      const countryMatch = text.match(/<name>([^<]+)<\/name>/);
      const cqMatch = text.match(/<cq>([^<]+)<\/cq>/);
      const ituMatch = text.match(/<itu>([^<]+)<\/itu>/);
      
      if (latMatch && lonMatch) {
        const result = {
          callsign,
          lat: parseFloat(latMatch[1]),
          lon: parseFloat(lonMatch[1]),
          country: countryMatch ? countryMatch[1] : 'Unknown',
          cqZone: cqMatch ? cqMatch[1] : '',
          ituZone: ituMatch ? ituMatch[1] : ''
        };
        console.log('[Callsign Lookup] Found:', result);
        return res.json(result);
      }
    }
    
    // Fallback: estimate location from callsign prefix
    const estimated = estimateLocationFromPrefix(callsign);
    if (estimated) {
      console.log('[Callsign Lookup] Estimated from prefix:', estimated);
      return res.json(estimated);
    }
    
    res.status(404).json({ error: 'Callsign not found' });
  } catch (error) {
    console.error('[Callsign Lookup] Error:', error.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Convert Maidenhead grid locator to lat/lon (center of grid square)
function maidenheadToLatLon(grid) {
  if (!grid || typeof grid !== 'string') return null;
  
  grid = grid.toUpperCase().trim();
  
  // Validate grid format (2, 4, 6, or 8 characters)
  if (!/^[A-R]{2}([0-9]{2}([A-X]{2}([0-9]{2})?)?)?$/.test(grid)) return null;
  
  let lon = -180;
  let lat = -90;
  
  // Field (2 chars): 20° lon x 10° lat
  lon += (grid.charCodeAt(0) - 65) * 20;
  lat += (grid.charCodeAt(1) - 65) * 10;
  
  if (grid.length >= 4) {
    // Square (2 digits): 2° lon x 1° lat
    lon += parseInt(grid[2]) * 2;
    lat += parseInt(grid[3]) * 1;
  }
  
  if (grid.length >= 6) {
    // Subsquare (2 chars): 5' lon x 2.5' lat
    lon += (grid.charCodeAt(4) - 65) * (5 / 60);
    lat += (grid.charCodeAt(5) - 65) * (2.5 / 60);
  }
  
  if (grid.length >= 8) {
    // Extended square (2 digits): 0.5' lon x 0.25' lat
    lon += parseInt(grid[6]) * (0.5 / 60);
    lat += parseInt(grid[7]) * (0.25 / 60);
  }
  
  // Add offset to center of the grid square
  if (grid.length === 2) {
    lon += 10; lat += 5;
  } else if (grid.length === 4) {
    lon += 1; lat += 0.5;
  } else if (grid.length === 6) {
    lon += 2.5 / 60; lat += 1.25 / 60;
  } else if (grid.length === 8) {
    lon += 0.25 / 60; lat += 0.125 / 60;
  }
  
  return { lat, lon, grid };
}

// Try to extract grid locators from a comment string
// Returns { spotterGrid, dxGrid } - may have one, both, or neither
function extractGridsFromComment(comment) {
  if (!comment || typeof comment !== 'string') return { spotterGrid: null, dxGrid: null };
  
  // Check for dual grid format: FN20<>EM79 or FN20->EM79 or FN20/EM79
  const dualGridMatch = comment.match(/\b([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\s*(?:<>|->|\/|<)\s*([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\b/);
  if (dualGridMatch) {
    const grid1 = dualGridMatch[1].toUpperCase();
    const grid2 = dualGridMatch[2].toUpperCase();
    // Validate both are real grids
    if (isValidGrid(grid1) && isValidGrid(grid2)) {
      return { spotterGrid: grid1, dxGrid: grid2 };
    }
  }
  
  // Look for all grids in the comment
  const gridPattern = /\b([A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?)\b/g;
  const grids = [];
  let match;
  while ((match = gridPattern.exec(comment)) !== null) {
    const grid = match[1].toUpperCase();
    if (isValidGrid(grid)) {
      grids.push(grid);
    }
  }
  
  // If we found two grids, assume first is spotter, second is DX
  if (grids.length >= 2) {
    return { spotterGrid: grids[0], dxGrid: grids[1] };
  }
  
  // If we found one grid, assume it's the DX station
  if (grids.length === 1) {
    return { spotterGrid: null, dxGrid: grids[0] };
  }
  
  return { spotterGrid: null, dxGrid: null };
}

// Validate a grid square is realistic (not "CQ00", "DE12", etc)
function isValidGrid(grid) {
  if (!grid || grid.length < 4) return false;
  const firstChar = grid.charCodeAt(0);
  const secondChar = grid.charCodeAt(1);
  // First char should be A-R, second char should be A-R
  return firstChar >= 65 && firstChar <= 82 && secondChar >= 65 && secondChar <= 82;
}

// Legacy single-grid extraction (kept for compatibility)
function extractGridFromComment(comment) {
  const grids = extractGridsFromComment(comment);
  return grids.dxGrid;
}

// Estimate location from callsign prefix using grid squares
// This gives much better precision than country centers
function estimateLocationFromPrefix(callsign) {
  if (!callsign) return null;
  
  // Comprehensive prefix to grid mapping
  // Uses typical/central grid for each prefix area
  const prefixGrids = {
    // USA - by call district
    'W1': 'FN41', 'K1': 'FN41', 'N1': 'FN41', 'AA1': 'FN41', // New England
    'W2': 'FN20', 'K2': 'FN20', 'N2': 'FN20', 'AA2': 'FN20', // NY/NJ
    'W3': 'FM19', 'K3': 'FM19', 'N3': 'FM19', 'AA3': 'FM19', // PA/MD/DE
    'W4': 'EM73', 'K4': 'EM73', 'N4': 'EM73', 'AA4': 'EM73', // SE USA
    'W5': 'EM12', 'K5': 'EM12', 'N5': 'EM12', 'AA5': 'EM12', // TX/OK/LA/AR/MS
    'W6': 'CM97', 'K6': 'CM97', 'N6': 'CM97', 'AA6': 'CM97', // California
    'W7': 'DN31', 'K7': 'DN31', 'N7': 'DN31', 'AA7': 'DN31', // Pacific NW/Mountain
    'W8': 'EN81', 'K8': 'EN81', 'N8': 'EN81', 'AA8': 'EN81', // MI/OH/WV
    'W9': 'EN52', 'K9': 'EN52', 'N9': 'EN52', 'AA9': 'EN52', // IL/IN/WI
    'W0': 'EN31', 'K0': 'EN31', 'N0': 'EN31', 'AA0': 'EN31', // Central USA
    // Generic USA (no district) - AA through AL are all US prefixes
    'W': 'EM79', 'K': 'EM79', 'N': 'EM79', 
    'AA': 'EM79', 'AB': 'EM79', 'AC': 'EM79', 'AD': 'EM79', 'AE': 'EM79', 'AF': 'EM79',
    'AG': 'EM79', 'AH': 'EM79', 'AI': 'EM79', 'AJ': 'EM79', 'AK': 'EM79', 'AL': 'EM79',
    // US A-prefixes by call district
    'AE0': 'EN31', 'AE1': 'FN41', 'AE2': 'FN20', 'AE3': 'FM19', 'AE4': 'EM73', 
    'AE5': 'EM12', 'AE6': 'CM97', 'AE7': 'DN31', 'AE8': 'EN81', 'AE9': 'EN52',
    'AC0': 'EN31', 'AC1': 'FN41', 'AC2': 'FN20', 'AC3': 'FM19', 'AC4': 'EM73',
    'AC5': 'EM12', 'AC6': 'CM97', 'AC7': 'DN31', 'AC8': 'EN81', 'AC9': 'EN52',
    'AD0': 'EN31', 'AD1': 'FN41', 'AD2': 'FN20', 'AD3': 'FM19', 'AD4': 'EM73',
    'AD5': 'EM12', 'AD6': 'CM97', 'AD7': 'DN31', 'AD8': 'EN81', 'AD9': 'EN52',
    'AF0': 'EN31', 'AF1': 'FN41', 'AF2': 'FN20', 'AF3': 'FM19', 'AF4': 'EM73',
    'AF5': 'EM12', 'AF6': 'CM97', 'AF7': 'DN31', 'AF8': 'EN81', 'AF9': 'EN52',
    'AG0': 'EN31', 'AG1': 'FN41', 'AG2': 'FN20', 'AG3': 'FM19', 'AG4': 'EM73',
    'AG5': 'EM12', 'AG6': 'CM97', 'AG7': 'DN31', 'AG8': 'EN81', 'AG9': 'EN52',
    'AI0': 'EN31', 'AI1': 'FN41', 'AI2': 'FN20', 'AI3': 'FM19', 'AI4': 'EM73',
    'AI5': 'EM12', 'AI6': 'CM97', 'AI7': 'DN31', 'AI8': 'EN81', 'AI9': 'EN52',
    'AJ0': 'EN31', 'AJ1': 'FN41', 'AJ2': 'FN20', 'AJ3': 'FM19', 'AJ4': 'EM73',
    'AJ5': 'EM12', 'AJ6': 'CM97', 'AJ7': 'DN31', 'AJ8': 'EN81', 'AJ9': 'EN52',
    'AK0': 'EN31', 'AK1': 'FN41', 'AK2': 'FN20', 'AK3': 'FM19', 'AK4': 'EM73',
    'AK5': 'EM12', 'AK6': 'CM97', 'AK7': 'DN31', 'AK8': 'EN81', 'AK9': 'EN52',
    'AL0': 'EN31', 'AL1': 'FN41', 'AL2': 'FN20', 'AL3': 'FM19', 'AL4': 'EM73',
    'AL5': 'EM12', 'AL6': 'CM97', 'AL7': 'BP51', 'AL8': 'EN81', 'AL9': 'EN52', // AL7 = Alaska
    
    // Canada - by province
    'VE1': 'FN74', 'VA1': 'FN74', // Maritime
    'VE2': 'FN35', 'VA2': 'FN35', // Quebec
    'VE3': 'FN03', 'VA3': 'FN03', // Ontario
    'VE4': 'EN19', 'VA4': 'EN19', // Manitoba
    'VE5': 'DO51', 'VA5': 'DO51', // Saskatchewan
    'VE6': 'DO33', 'VA6': 'DO33', // Alberta
    'VE7': 'CN89', 'VA7': 'CN89', // British Columbia
    'VE8': 'DP31', 'VA8': 'DP31', // NWT
    'VE9': 'FN65', 'VA9': 'FN65', // New Brunswick
    'VY1': 'CP28', // Yukon
    'VY2': 'FN86', // PEI
    'VO1': 'GN37', 'VO2': 'GO17', // Newfoundland/Labrador
    'VE': 'FN03', 'VA': 'FN03', // Generic Canada
    
    // UK & Ireland
    'G': 'IO91', 'M': 'IO91', '2E': 'IO91', 'GW': 'IO81', // England/Wales
    'GM': 'IO85', 'MM': 'IO85', '2M': 'IO85', // Scotland
    'GI': 'IO64', 'MI': 'IO64', '2I': 'IO64', // N. Ireland
    'EI': 'IO63', 'EJ': 'IO63', // Ireland
    
    // Germany
    'DL': 'JO51', 'DJ': 'JO51', 'DK': 'JO51', 'DA': 'JO51', 'DB': 'JO51', 'DC': 'JO51', 'DD': 'JO51', 'DF': 'JO51', 'DG': 'JO51', 'DH': 'JO51', 'DO': 'JO51',
    
    // Rest of Europe
    'F': 'JN18', // France
    'I': 'JN61', 'IK': 'JN45', 'IZ': 'JN61', // Italy
    'EA': 'IN80', 'EC': 'IN80', 'EB': 'IN80', // Spain
    'CT': 'IM58', // Portugal
    'PA': 'JO21', 'PD': 'JO21', 'PE': 'JO21', 'PH': 'JO21', // Netherlands
    'ON': 'JO20', 'OO': 'JO20', 'OR': 'JO20', 'OT': 'JO20', // Belgium
    'HB': 'JN47', 'HB9': 'JN47', // Switzerland
    'OE': 'JN78', // Austria
    'OZ': 'JO55', 'OU': 'JO55', // Denmark
    'SM': 'JO89', 'SA': 'JO89', 'SB': 'JO89', 'SE': 'JO89', // Sweden
    'LA': 'JO59', 'LB': 'JO59', // Norway
    'OH': 'KP20', 'OF': 'KP20', 'OG': 'KP20', 'OI': 'KP20', // Finland
    'SP': 'JO91', 'SQ': 'JO91', 'SO': 'JO91', '3Z': 'JO91', // Poland
    'OK': 'JN79', 'OL': 'JN79', // Czech Republic
    'OM': 'JN88', // Slovakia
    'HA': 'JN97', 'HG': 'JN97', // Hungary
    'YO': 'KN34', // Romania
    'LZ': 'KN22', // Bulgaria
    'YU': 'KN04', // Serbia
    '9A': 'JN75', // Croatia
    'S5': 'JN76', // Slovenia
    'SV': 'KM17', 'SX': 'KM17', // Greece
    '9H': 'JM75', // Malta
    'LY': 'KO24', // Lithuania
    'ES': 'KO29', // Estonia
    'YL': 'KO26', // Latvia
    
    // Russia & Ukraine
    'UA': 'KO85', 'RA': 'KO85', 'RU': 'KO85', 'RV': 'KO85', 'RW': 'KO85', 'RX': 'KO85', 'RZ': 'KO85',
    'UA0': 'OO33', 'RA0': 'OO33', 'R0': 'OO33', // Asiatic Russia
    'UA9': 'MO06', 'RA9': 'MO06', 'R9': 'MO06', // Ural
    'UR': 'KO50', 'UT': 'KO50', 'UX': 'KO50', 'US': 'KO50', // Ukraine
    
    // Japan - by call area
    'JA1': 'PM95', 'JH1': 'PM95', 'JR1': 'PM95', 'JE1': 'PM95', 'JF1': 'PM95', 'JG1': 'PM95', 'JI1': 'PM95', 'JJ1': 'PM95', 'JK1': 'PM95', 'JL1': 'PM95', 'JM1': 'PM95', 'JN1': 'PM95', 'JO1': 'PM95', 'JP1': 'PM95', 'JQ1': 'PM95', 'JS1': 'PM95', '7K1': 'PM95', '7L1': 'PM95', '7M1': 'PM95', '7N1': 'PM95',
    'JA2': 'PM84', 'JA3': 'PM74', 'JA4': 'PM64', 'JA5': 'PM63', 'JA6': 'PM53', 'JA7': 'QM07', 'JA8': 'QN02', 'JA9': 'PM86', 'JA0': 'PM97',
    'JA': 'PM95', 'JH': 'PM95', 'JR': 'PM95', 'JE': 'PM95', 'JF': 'PM95', 'JG': 'PM95', // Generic Japan
    
    // Rest of Asia
    'HL': 'PM37', 'DS': 'PM37', '6K': 'PM37', '6L': 'PM37', // South Korea
    'BV': 'PL04', 'BW': 'PL04', 'BX': 'PL04', // Taiwan
    'BY': 'OM92', 'BT': 'OM92', 'BA': 'OM92', 'BD': 'OM92', 'BG': 'OM92', // China
    'VU': 'MK82', 'VU2': 'MK82', 'VU3': 'MK82', // India
    'HS': 'OK03', 'E2': 'OK03', // Thailand
    '9V': 'OJ11', // Singapore
    '9M': 'OJ05', '9W': 'OJ05', // Malaysia
    'DU': 'PK04', 'DV': 'PK04', 'DW': 'PK04', 'DX': 'PK04', 'DY': 'PK04', 'DZ': 'PK04', '4D': 'PK04', '4E': 'PK04', '4F': 'PK04', '4G': 'PK04', '4H': 'PK04', '4I': 'PK04', // Philippines
    'YB': 'OI33', 'YC': 'OI33', 'YD': 'OI33', 'YE': 'OI33', 'YF': 'OI33', 'YG': 'OI33', 'YH': 'OI33', // Indonesia
    
    // Oceania
    'VK': 'QF56', 'VK1': 'QF44', 'VK2': 'QF56', 'VK3': 'QF22', 'VK4': 'QG62', 'VK5': 'PF95', 'VK6': 'OF86', 'VK7': 'QE38', // Australia
    'ZL': 'RF70', 'ZL1': 'RF72', 'ZL2': 'RF70', 'ZL3': 'RE66', 'ZL4': 'RE54', // New Zealand
    'KH6': 'BL01', // Hawaii
    'KH2': 'QK24', // Guam
    'FK': 'RG37', // New Caledonia
    
    // South America
    'LU': 'GF05', 'LW': 'GF05', 'LO': 'GF05', 'L2': 'GF05', 'L3': 'GF05', 'L4': 'GF05', 'L5': 'GF05', 'L6': 'GF05', 'L7': 'GF05', 'L8': 'GF05', 'L9': 'GF05', // Argentina
    'PY': 'GG87', 'PP': 'GG87', 'PQ': 'GG87', 'PR': 'GG87', 'PS': 'GG87', 'PT': 'GG87', 'PU': 'GG87', 'PV': 'GG87', 'PW': 'GG87', 'PX': 'GG87', // Brazil
    'CE': 'FF46', 'CA': 'FF46', 'CB': 'FF46', 'CC': 'FF46', 'CD': 'FF46', 'XQ': 'FF46', 'XR': 'FF46', '3G': 'FF46', // Chile
    'CX': 'GF15', // Uruguay
    'HC': 'FI09', 'HD': 'FI09', // Ecuador
    'OA': 'FH17', 'OB': 'FH17', 'OC': 'FH17', // Peru
    'HK': 'FJ35', 'HJ': 'FJ35', '5J': 'FJ35', '5K': 'FJ35', // Colombia
    'YV': 'FK60', 'YW': 'FK60', 'YX': 'FK60', 'YY': 'FK60', // Venezuela
    
    // Caribbean
    'KP4': 'FK68', 'NP4': 'FK68', 'WP4': 'FK68', // Puerto Rico
    'VP5': 'FL31', // Turks & Caicos
    'HI': 'FK49', // Dominican Republic
    'CO': 'FL10', 'CM': 'FL10', // Cuba
    'FG': 'FK96', // Guadeloupe
    'FM': 'FK94', // Martinique
    'PJ': 'FK52', // Netherlands Antilles
    
    // Africa
    'ZS': 'KG33', 'ZR': 'KG33', 'ZT': 'KG33', 'ZU': 'KG33', // South Africa
    '5N': 'JJ55', // Nigeria
    'CN': 'IM63', // Morocco
    '7X': 'JM16', // Algeria
    'SU': 'KL30', // Egypt
    '5Z': 'KI88', // Kenya
    'ET': 'KJ49', // Ethiopia
    'EA8': 'IL18', 'EA9': 'IM75', // Canary Islands, Ceuta
    
    // Middle East
    'A4': 'LL93', 'A41': 'LL93', 'A45': 'LL93', // Oman
    'A6': 'LL65', 'A61': 'LL65', // UAE
    'A7': 'LL45', 'A71': 'LL45', // Qatar
    'HZ': 'LL24', // Saudi Arabia
    '4X': 'KM72', '4Z': 'KM72', // Israel
    'OD': 'KM73', // Lebanon
    
    // Other
    'VP8': 'GD18', // Falkland Islands
    'CE9': 'FC56', 'DP0': 'IB59', 'KC4': 'FC56', // Antarctica
    'SV5': 'KM46', 'SV9': 'KM25', // Dodecanese, Crete
  };
  
  const upper = callsign.toUpperCase();
  
  // Smart US callsign detection - US prefixes follow specific patterns
  // K, N, W + anything = USA
  // A[A-L] + digit = USA (e.g., AA0, AE5, AL7)
  const usCallPattern = /^([KNW][0-9]?|A[A-L][0-9])/;
  const usMatch = upper.match(usCallPattern);
  if (usMatch) {
    // Extract call district (the digit) for more precise location
    const districtMatch = upper.match(/^[KNWA][A-L]?([0-9])/);
    const district = districtMatch ? districtMatch[1] : null;
    
    const usDistrictGrids = {
      '0': 'EN31', // Central (CO, IA, KS, MN, MO, NE, ND, SD)
      '1': 'FN41', // New England (CT, MA, ME, NH, RI, VT)
      '2': 'FN20', // NY, NJ
      '3': 'FM19', // PA, MD, DE
      '4': 'EM73', // Southeast (AL, FL, GA, KY, NC, SC, TN, VA)
      '5': 'EM12', // TX, OK, LA, AR, MS, NM
      '6': 'CM97', // California
      '7': 'DN31', // Pacific NW/Mountain (AZ, ID, MT, NV, OR, UT, WA, WY)
      '8': 'EN81', // MI, OH, WV
      '9': 'EN52', // IL, IN, WI
    };
    
    const grid = district && usDistrictGrids[district] ? usDistrictGrids[district] : 'EM79';
    const gridLoc = maidenheadToLatLon(grid);
    if (gridLoc) {
      return {
        callsign,
        lat: gridLoc.lat,
        lon: gridLoc.lon,
        grid: grid,
        country: 'USA',
        estimated: true,
        source: 'prefix-grid'
      };
    }
  }
  
  // Try longest prefix match first (up to 4 chars) for non-US calls
  for (let len = 4; len >= 1; len--) {
    const prefix = upper.substring(0, len);
    if (prefixGrids[prefix]) {
      const gridLoc = maidenheadToLatLon(prefixGrids[prefix]);
      if (gridLoc) {
        return { 
          callsign, 
          lat: gridLoc.lat, 
          lon: gridLoc.lon, 
          grid: prefixGrids[prefix],
          country: getCountryFromPrefix(prefix),
          estimated: true,
          source: 'prefix-grid'
        };
      }
    }
  }
  
  // Fallback to first character (most likely country for each letter)
  const firstCharGrids = {
    'A': 'EM79', 'B': 'PL02', 'C': 'FN03', 'D': 'JO51', 'E': 'IO63', // A=USA (AA-AL), B=China, C=Canada, D=Germany, E=Spain/Ireland
    'F': 'JN18', 'G': 'IO91', 'H': 'KM72', 'I': 'JN61', 'J': 'PM95', // F=France, G=UK, H=varies, I=Italy, J=Japan
    'K': 'EM79', 'L': 'GF05', 'M': 'IO91', 'N': 'EM79', 'O': 'KP20', // K=USA, L=Argentina, M=UK, N=USA, O=Finland
    'P': 'GG87', 'R': 'KO85', 'S': 'JO89', 'T': 'KI88', 'U': 'KO85', // P=Brazil, R=Russia, S=Sweden, T=varies, U=Russia
    'V': 'QF56', 'W': 'EM79', 'X': 'EK09', 'Y': 'JO91', 'Z': 'KG33'  // V=Australia, W=USA, X=Mexico, Y=varies, Z=South Africa
  };
  
  const firstChar = upper[0];
  if (firstCharGrids[firstChar]) {
    const gridLoc = maidenheadToLatLon(firstCharGrids[firstChar]);
    if (gridLoc) {
      return {
        callsign,
        lat: gridLoc.lat,
        lon: gridLoc.lon,
        grid: firstCharGrids[firstChar],
        country: 'Unknown',
        estimated: true,
        source: 'prefix-grid'
      };
    }
  }
  
  return null;
}

// Helper to get country name from prefix
function getCountryFromPrefix(prefix) {
  const prefixCountries = {
    'W': 'USA', 'K': 'USA', 'N': 'USA', 'AA': 'USA',
    'VE': 'Canada', 'VA': 'Canada', 'VY': 'Canada', 'VO': 'Canada',
    'G': 'England', 'M': 'England', '2E': 'England', 'GM': 'Scotland', 'GW': 'Wales', 'GI': 'N. Ireland',
    'EI': 'Ireland', 'F': 'France', 'DL': 'Germany', 'I': 'Italy', 'EA': 'Spain', 'CT': 'Portugal',
    'PA': 'Netherlands', 'ON': 'Belgium', 'HB': 'Switzerland', 'OE': 'Austria',
    'OZ': 'Denmark', 'SM': 'Sweden', 'LA': 'Norway', 'OH': 'Finland',
    'SP': 'Poland', 'OK': 'Czech Rep', 'HA': 'Hungary', 'YO': 'Romania', 'LZ': 'Bulgaria',
    'UA': 'Russia', 'UR': 'Ukraine',
    'JA': 'Japan', 'HL': 'S. Korea', 'BV': 'Taiwan', 'BY': 'China', 'VU': 'India', 'HS': 'Thailand',
    'VK': 'Australia', 'ZL': 'New Zealand', 'KH6': 'Hawaii',
    'LU': 'Argentina', 'PY': 'Brazil', 'CE': 'Chile', 'HK': 'Colombia', 'YV': 'Venezuela',
    'ZS': 'South Africa', 'CN': 'Morocco', 'SU': 'Egypt'
  };
  
  for (let len = 3; len >= 1; len--) {
    const p = prefix.substring(0, len);
    if (prefixCountries[p]) return prefixCountries[p];
  }
  return 'Unknown';
}

// ============================================
// MY SPOTS API - Get spots involving a specific callsign
// ============================================

app.get('/api/myspots/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  console.log('[My Spots] Searching for callsign:', callsign);
  
  const mySpots = [];
  
  try {
    // Try HamQTH for spots involving this callsign
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(
      `https://www.hamqth.com/dxc_csv.php?limit=100`,
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('^');
        if (parts.length < 3) continue;
        
        const spotter = parts[0]?.trim().toUpperCase();
        const dxCall = parts[2]?.trim().toUpperCase();
        const freq = parts[1]?.trim();
        const comment = parts[3]?.trim() || '';
        const timeStr = parts[4]?.trim() || '';
        
        // Check if our callsign is involved (as spotter or spotted)
        if (spotter === callsign || dxCall === callsign || 
            spotter.includes(callsign) || dxCall.includes(callsign)) {
          mySpots.push({
            spotter,
            dxCall,
            freq: freq ? (parseFloat(freq) / 1000).toFixed(3) : '0.000',
            comment,
            time: timeStr ? timeStr.substring(0, 5) + 'z' : '',
            isMySpot: spotter.includes(callsign),
            isSpottedMe: dxCall.includes(callsign)
          });
        }
      }
    }
    
    console.log('[My Spots] Found', mySpots.length, 'spots involving', callsign);
    
    // Now try to get locations for each unique callsign
    const uniqueCalls = [...new Set(mySpots.map(s => s.isMySpot ? s.dxCall : s.spotter))];
    const locations = {};
    
    for (const call of uniqueCalls.slice(0, 10)) { // Limit to 10 lookups
      try {
        const loc = estimateLocationFromPrefix(call);
        if (loc) {
          locations[call] = { lat: loc.lat, lon: loc.lon, country: loc.country };
        }
      } catch (e) {
        // Ignore lookup errors
      }
    }
    
    // Add locations to spots
    const spotsWithLocations = mySpots.map(spot => {
      const targetCall = spot.isMySpot ? spot.dxCall : spot.spotter;
      const loc = locations[targetCall];
      return {
        ...spot,
        targetCall,
        lat: loc?.lat,
        lon: loc?.lon,
        country: loc?.country
      };
    }).filter(s => s.lat && s.lon); // Only return spots with valid locations
    
    res.json(spotsWithLocations);
  } catch (error) {
    logErrorOnce('My Spots', error.message);
    res.json([]);
  }
});

// ============================================
// SATELLITE TRACKING API
// ============================================

// Comprehensive ham radio satellites - NORAD IDs
// Updated list of active amateur radio satellites
const HAM_SATELLITES = {
  // High Priority - Popular FM satellites
  'ISS': { norad: 25544, name: 'ISS (ZARYA)', color: '#00ffff', priority: 1, mode: 'FM/APRS/SSTV' },
  'SO-50': { norad: 27607, name: 'SO-50', color: '#00ff00', priority: 1, mode: 'FM' },
  'AO-91': { norad: 43017, name: 'AO-91 (Fox-1B)', color: '#ff6600', priority: 1, mode: 'FM' },
  'AO-92': { norad: 43137, name: 'AO-92 (Fox-1D)', color: '#ff9900', priority: 1, mode: 'FM/L-band' },
  'PO-101': { norad: 43678, name: 'PO-101 (Diwata-2)', color: '#ff3399', priority: 1, mode: 'FM' },
  
  // Linear Transponder Satellites
  'RS-44': { norad: 44909, name: 'RS-44 (DOSAAF)', color: '#ff0066', priority: 1, mode: 'Linear' },
  'AO-7': { norad: 7530, name: 'AO-7', color: '#ffcc00', priority: 2, mode: 'Linear (daylight)' },
  'FO-29': { norad: 24278, name: 'FO-29 (JAS-2)', color: '#ff6699', priority: 2, mode: 'Linear' },
  'FO-99': { norad: 43937, name: 'FO-99 (NEXUS)', color: '#ff99cc', priority: 2, mode: 'Linear' },
  'JO-97': { norad: 43803, name: 'JO-97 (JY1Sat)', color: '#cc99ff', priority: 2, mode: 'Linear/FM' },
  'XW-2A': { norad: 40903, name: 'XW-2A (CAS-3A)', color: '#66ff99', priority: 2, mode: 'Linear' },
  'XW-2B': { norad: 40911, name: 'XW-2B (CAS-3B)', color: '#66ffcc', priority: 2, mode: 'Linear' },
  'XW-2C': { norad: 40906, name: 'XW-2C (CAS-3C)', color: '#99ffcc', priority: 2, mode: 'Linear' },
  'XW-2D': { norad: 40907, name: 'XW-2D (CAS-3D)', color: '#99ff99', priority: 2, mode: 'Linear' },
  'XW-2E': { norad: 40909, name: 'XW-2E (CAS-3E)', color: '#ccff99', priority: 2, mode: 'Linear' },
  'XW-2F': { norad: 40910, name: 'XW-2F (CAS-3F)', color: '#ccffcc', priority: 2, mode: 'Linear' },
  
  // CAS (Chinese Amateur Satellites)
  'CAS-4A': { norad: 42761, name: 'CAS-4A', color: '#9966ff', priority: 2, mode: 'Linear' },
  'CAS-4B': { norad: 42759, name: 'CAS-4B', color: '#9933ff', priority: 2, mode: 'Linear' },
  'CAS-6': { norad: 44881, name: 'CAS-6 (TO-108)', color: '#cc66ff', priority: 2, mode: 'Linear' },
  
  // GreenCube / IO satellites
  'IO-117': { norad: 53106, name: 'IO-117 (GreenCube)', color: '#00ff99', priority: 2, mode: 'Digipeater' },
  
  // TEVEL constellation
  'TEVEL-1': { norad: 50988, name: 'TEVEL-1', color: '#66ccff', priority: 3, mode: 'FM' },
  'TEVEL-2': { norad: 50989, name: 'TEVEL-2', color: '#66ddff', priority: 3, mode: 'FM' },
  'TEVEL-3': { norad: 50994, name: 'TEVEL-3', color: '#66eeff', priority: 3, mode: 'FM' },
  'TEVEL-4': { norad: 50998, name: 'TEVEL-4', color: '#77ccff', priority: 3, mode: 'FM' },
  'TEVEL-5': { norad: 51062, name: 'TEVEL-5', color: '#77ddff', priority: 3, mode: 'FM' },
  'TEVEL-6': { norad: 51063, name: 'TEVEL-6', color: '#77eeff', priority: 3, mode: 'FM' },
  'TEVEL-7': { norad: 51069, name: 'TEVEL-7', color: '#88ccff', priority: 3, mode: 'FM' },
  'TEVEL-8': { norad: 51084, name: 'TEVEL-8', color: '#88ddff', priority: 3, mode: 'FM' },
  
  // OSCAR satellites
  'AO-27': { norad: 22825, name: 'AO-27', color: '#ff9966', priority: 3, mode: 'FM' },
  'AO-73': { norad: 39444, name: 'AO-73 (FUNcube-1)', color: '#ffcc66', priority: 3, mode: 'Linear/Telemetry' },
  'EO-88': { norad: 42017, name: 'EO-88 (Nayif-1)', color: '#ffaa66', priority: 3, mode: 'Linear/Telemetry' },
  
  // Russian satellites
  'RS-15': { norad: 23439, name: 'RS-15', color: '#ff6666', priority: 3, mode: 'Linear' },
  
  // QO-100 (Geostationary - special)
  'QO-100': { norad: 43700, name: 'QO-100 (Es\'hail-2)', color: '#ffff00', priority: 1, mode: 'Linear (GEO)' },
  
  // APRS Digipeaters
  'ARISS': { norad: 25544, name: 'ARISS (ISS)', color: '#00ffff', priority: 1, mode: 'APRS' },
  
  // Cubesats with amateur payloads
  'UVSQ-SAT': { norad: 47438, name: 'UVSQ-SAT', color: '#ff66ff', priority: 4, mode: 'Telemetry' },
  'MEZNSAT': { norad: 46489, name: 'MeznSat', color: '#66ff66', priority: 4, mode: 'Telemetry' },
  
  // SSTV/Slow Scan
  'SSTV-ISS': { norad: 25544, name: 'ISS SSTV', color: '#00ffff', priority: 2, mode: 'SSTV' }
};

// Cache for TLE data (refresh every 6 hours)
let tleCache = { data: null, timestamp: 0 };
const TLE_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/satellites/tle', async (req, res) => {
  console.log('[Satellites] Fetching TLE data...');
  
  try {
    const now = Date.now();
    
    // Return cached data if fresh
    if (tleCache.data && (now - tleCache.timestamp) < TLE_CACHE_DURATION) {
      console.log('[Satellites] Returning cached TLE data');
      return res.json(tleCache.data);
    }
    
    // Fetch fresh TLE data from CelesTrak
    const tleData = {};
    
    // Fetch amateur radio satellites TLE
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle',
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      // Parse TLE data (3 lines per satellite: name, line1, line2)
      for (let i = 0; i < lines.length - 2; i += 3) {
        const name = lines[i].trim();
        const line1 = lines[i + 1]?.trim();
        const line2 = lines[i + 2]?.trim();
        
        if (line1 && line2 && line1.startsWith('1 ') && line2.startsWith('2 ')) {
          // Extract NORAD ID from line 1
          const noradId = parseInt(line1.substring(2, 7));
          
          // Check if this is a satellite we care about
          for (const [key, sat] of Object.entries(HAM_SATELLITES)) {
            if (sat.norad === noradId) {
              tleData[key] = {
                ...sat,
                tle1: line1,
                tle2: line2
              };
              console.log('[Satellites] Found TLE for:', key, noradId);
            }
          }
        }
      }
    }
    
    // Also try to get ISS specifically (it's in the stations group)
    if (!tleData['ISS']) {
      try {
        const issResponse = await fetch(
          'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle',
          { headers: { 'User-Agent': 'OpenHamClock/3.3' } }
        );
        if (issResponse.ok) {
          const issText = await issResponse.text();
          const issLines = issText.trim().split('\n');
          if (issLines.length >= 3) {
            tleData['ISS'] = {
              ...HAM_SATELLITES['ISS'],
              tle1: issLines[1].trim(),
              tle2: issLines[2].trim()
            };
            console.log('[Satellites] Found ISS TLE');
          }
        }
      } catch (e) {
        console.log('[Satellites] Could not fetch ISS TLE:', e.message);
      }
    }
    
    // Cache the result
    tleCache = { data: tleData, timestamp: now };
    
    console.log('[Satellites] Loaded TLE for', Object.keys(tleData).length, 'satellites');
    res.json(tleData);
    
  } catch (error) {
    console.error('[Satellites] TLE fetch error:', error.message);
    // Return cached data even if stale, or empty object
    res.json(tleCache.data || {});
  }
});

// ============================================
// IONOSONDE DATA API (Real-time ionospheric data from KC2G/GIRO)
// ============================================

// Cache for ionosonde data (refresh every 10 minutes)
let ionosondeCache = {
  data: null,
  timestamp: 0,
  maxAge: 10 * 60 * 1000 // 10 minutes
};

// Fetch real-time ionosonde data from KC2G (GIRO network)
async function fetchIonosondeData() {
  const now = Date.now();
  
  // Return cached data if fresh
  if (ionosondeCache.data && (now - ionosondeCache.timestamp) < ionosondeCache.maxAge) {
    return ionosondeCache.data;
  }
  
  try {
    const response = await fetch('https://prop.kc2g.com/api/stations.json', {
      headers: { 'User-Agent': 'OpenHamClock/3.5' },
      timeout: 15000
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    
    // Filter to only recent data (within last 2 hours) with valid readings
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const validStations = data.filter(s => {
      if (!s.fof2 || !s.station) return false;
      const stationTime = new Date(s.time);
      return stationTime > twoHoursAgo && s.cs > 0; // confidence score > 0
    }).map(s => ({
      code: s.station.code,
      name: s.station.name,
      lat: parseFloat(s.station.latitude),
      lon: parseFloat(s.station.longitude) > 180 ? parseFloat(s.station.longitude) - 360 : parseFloat(s.station.longitude),
      foF2: s.fof2,
      mufd: s.mufd, // MUF at 3000km
      hmF2: s.hmf2, // Height of F2 layer
      md: parseFloat(s.md) || 3.0, // M(3000)F2 factor
      confidence: s.cs,
      time: s.time
    }));
    
    ionosondeCache = {
      data: validStations,
      timestamp: now
    };
    
    console.log(`[Ionosonde] Fetched ${validStations.length} valid stations from KC2G`);
    return validStations;
    
  } catch (error) {
    logErrorOnce('Ionosonde', `Fetch error: ${error.message}`);
    return ionosondeCache.data || [];
  }
}

// API endpoint to get ionosonde data
app.get('/api/ionosonde', async (req, res) => {
  try {
    const stations = await fetchIonosondeData();
    res.json({
      count: stations.length,
      timestamp: new Date().toISOString(),
      stations: stations
    });
  } catch (error) {
    logErrorOnce('Ionosonde', `API: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch ionosonde data' });
  }
});

// Calculate distance between two points in km
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Interpolate foF2 at a given location using inverse distance weighting
function interpolateFoF2(lat, lon, stations) {
  if (!stations || stations.length === 0) return null;
  
  // Maximum distance (km) to consider ionosonde data valid
  // Beyond this, the data is too far away to be representative
  const MAX_VALID_DISTANCE = 3000; // km
  
  // Calculate distances to all stations
  const stationsWithDist = stations.map(s => ({
    ...s,
    distance: haversineDistance(lat, lon, s.lat, s.lon)
  })).filter(s => s.foF2 > 0);
  
  if (stationsWithDist.length === 0) return null;
  
  // Sort by distance and take nearest 5
  stationsWithDist.sort((a, b) => a.distance - b.distance);
  
  // Check if nearest station is within valid range
  if (stationsWithDist[0].distance > MAX_VALID_DISTANCE) {
    console.log(`[Ionosonde] Nearest station ${stationsWithDist[0].name} is ${Math.round(stationsWithDist[0].distance)}km away - too far, using estimates`);
    return {
      foF2: null,
      mufd: null,
      hmF2: null,
      md: 3.0,
      nearestStation: stationsWithDist[0].name,
      nearestDistance: Math.round(stationsWithDist[0].distance),
      stationsUsed: 0,
      method: 'no-coverage',
      reason: `Nearest ionosonde (${stationsWithDist[0].name}) is ${Math.round(stationsWithDist[0].distance)}km away - no local coverage`
    };
  }
  
  // Filter to only stations within valid range
  const validStations = stationsWithDist.filter(s => s.distance <= MAX_VALID_DISTANCE);
  const nearest = validStations.slice(0, 5);
  
  // If very close to a station, use its value directly
  if (nearest[0].distance < 100) {
    return {
      foF2: nearest[0].foF2,
      mufd: nearest[0].mufd,
      hmF2: nearest[0].hmF2,
      md: nearest[0].md,
      source: nearest[0].name,
      confidence: nearest[0].confidence,
      nearestDistance: Math.round(nearest[0].distance),
      method: 'direct'
    };
  }
  
  // Inverse distance weighted interpolation
  let sumWeights = 0;
  let sumFoF2 = 0;
  let sumMufd = 0;
  let sumHmF2 = 0;
  let sumMd = 0;
  
  nearest.forEach(s => {
    const weight = (s.confidence / 100) / Math.pow(s.distance, 2);
    sumWeights += weight;
    sumFoF2 += s.foF2 * weight;
    if (s.mufd) sumMufd += s.mufd * weight;
    if (s.hmF2) sumHmF2 += s.hmF2 * weight;
    if (s.md) sumMd += s.md * weight;
  });
  
  return {
    foF2: sumFoF2 / sumWeights,
    mufd: sumMufd > 0 ? sumMufd / sumWeights : null,
    hmF2: sumHmF2 > 0 ? sumHmF2 / sumWeights : null,
    md: sumMd > 0 ? sumMd / sumWeights : 3.0,
    nearestStation: nearest[0].name,
    nearestDistance: Math.round(nearest[0].distance),
    stationsUsed: nearest.length,
    method: 'interpolated'
  };
}

// ============================================
// HYBRID PROPAGATION SYSTEM
// Combines ITURHFProp (ITU-R P.533-14) with real-time ionosonde data
// ============================================

// Cache for ITURHFProp predictions (5-minute cache)
let iturhfpropCache = {
  data: null,
  key: null,
  timestamp: 0,
  maxAge: 5 * 60 * 1000  // 5 minutes
};

/**
 * Fetch base prediction from ITURHFProp service
 */
async function fetchITURHFPropPrediction(txLat, txLon, rxLat, rxLon, ssn, month, hour) {
  if (!ITURHFPROP_URL) return null;
  
  const cacheKey = `${txLat.toFixed(1)},${txLon.toFixed(1)}-${rxLat.toFixed(1)},${rxLon.toFixed(1)}-${ssn}-${month}-${hour}`;
  const now = Date.now();
  
  // Check cache
  if (iturhfpropCache.key === cacheKey && (now - iturhfpropCache.timestamp) < iturhfpropCache.maxAge) {
    console.log('[Hybrid] Using cached ITURHFProp prediction');
    return iturhfpropCache.data;
  }
  
  try {
    console.log('[Hybrid] Fetching from ITURHFProp service:', ITURHFPROP_URL);
    const url = `${ITURHFPROP_URL}/api/bands?txLat=${txLat}&txLon=${txLon}&rxLat=${rxLat}&rxLon=${rxLon}&ssn=${ssn}&month=${month}&hour=${hour}`;
    console.log('[Hybrid] Request URL:', url);
    
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      logErrorOnce('Hybrid', `ITURHFProp returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    // Only log success occasionally to reduce noise
    
    // Cache the result
    iturhfpropCache = {
      data,
      key: cacheKey,
      timestamp: now,
      maxAge: iturhfpropCache.maxAge
    };
    
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      logErrorOnce('Hybrid', `ITURHFProp: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch 24-hour predictions from ITURHFProp
 */
async function fetchITURHFPropHourly(txLat, txLon, rxLat, rxLon, ssn, month) {
  if (!ITURHFPROP_URL) return null;
  
  try {
    const url = `${ITURHFPROP_URL}/api/predict/hourly?txLat=${txLat}&txLon=${txLon}&rxLat=${rxLat}&rxLon=${rxLon}&ssn=${ssn}&month=${month}`;
    
    const response = await fetch(url, { timeout: 60000 }); // 60s timeout for 24-hour calc
    if (!response.ok) return null;
    
    const data = await response.json();
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      logErrorOnce('Hybrid', `ITURHFProp hourly: ${err.message}`);
    }
    return null;
  }
}

/**
 * Calculate ionospheric correction factor
 * Compares expected foF2 (from P.533 model) vs actual ionosonde foF2
 * Returns multiplier to adjust reliability predictions
 */
function calculateIonoCorrection(expectedFoF2, actualFoF2, kIndex) {
  if (!expectedFoF2 || !actualFoF2) return { factor: 1.0, confidence: 'low' };
  
  // Ratio of actual to expected ionospheric conditions
  const ratio = actualFoF2 / expectedFoF2;
  
  // Geomagnetic correction (storms reduce reliability)
  const kFactor = kIndex <= 3 ? 1.0 : 1.0 - (kIndex - 3) * 0.1;
  
  // Combined correction factor
  // ratio > 1 means better conditions than predicted
  // ratio < 1 means worse conditions than predicted
  const factor = ratio * kFactor;
  
  // Confidence based on how close actual is to expected
  let confidence;
  if (Math.abs(ratio - 1) < 0.15) {
    confidence = 'high';  // Within 15% - model is accurate
  } else if (Math.abs(ratio - 1) < 0.3) {
    confidence = 'medium'; // Within 30%
  } else {
    confidence = 'low';    // Model significantly off - rely more on ionosonde
  }
  
  console.log(`[Hybrid] Correction factor: ${factor.toFixed(2)} (expected foF2: ${expectedFoF2.toFixed(1)}, actual: ${actualFoF2.toFixed(1)}, K: ${kIndex})`);
  
  return { factor, confidence, ratio, kFactor };
}

/**
 * Apply ionospheric correction to ITURHFProp predictions
 */
function applyHybridCorrection(iturhfpropData, ionoData, kIndex, sfi) {
  if (!iturhfpropData?.bands) return null;
  
  // Estimate what foF2 ITURHFProp expected (based on SSN/SFI)
  const ssn = Math.max(0, Math.round((sfi - 67) / 0.97));
  const expectedFoF2 = 0.9 * Math.sqrt(ssn + 15) * 1.2; // Rough estimate at solar noon
  
  // Get actual foF2 from ionosonde
  const actualFoF2 = ionoData?.foF2;
  
  // Calculate correction
  const correction = calculateIonoCorrection(expectedFoF2, actualFoF2, kIndex);
  
  // Apply correction to each band
  const correctedBands = {};
  for (const [band, data] of Object.entries(iturhfpropData.bands)) {
    const baseReliability = data.reliability || 50;
    
    // Apply correction factor with bounds
    let correctedReliability = baseReliability * correction.factor;
    correctedReliability = Math.max(0, Math.min(100, correctedReliability));
    
    // For high bands, also check if we're above/below MUF
    const freq = data.freq;
    if (actualFoF2 && freq > actualFoF2 * 3.5) {
      // Frequency likely above MUF - reduce reliability
      correctedReliability *= 0.5;
    }
    
    correctedBands[band] = {
      ...data,
      reliability: Math.round(correctedReliability),
      baseReliability: Math.round(baseReliability),
      correctionApplied: correction.factor !== 1.0,
      status: correctedReliability >= 70 ? 'GOOD' : 
              correctedReliability >= 40 ? 'FAIR' : 'POOR'
    };
  }
  
  // Correct MUF based on actual ionosonde data
  let correctedMuf = iturhfpropData.muf;
  if (actualFoF2 && ionoData?.md) {
    // Use actual foF2 * M-factor for more accurate MUF
    const ionoMuf = actualFoF2 * (ionoData.md || 3.0);
    // Blend ITURHFProp MUF with ionosonde-derived MUF
    correctedMuf = (iturhfpropData.muf * 0.4) + (ionoMuf * 0.6);
  }
  
  return {
    bands: correctedBands,
    muf: Math.round(correctedMuf * 10) / 10,
    correction,
    model: 'Hybrid ITU-R P.533-14'
  };
}

/**
 * Estimate expected foF2 from P.533 model for a given hour
 */
function estimateExpectedFoF2(ssn, lat, hour) {
  // Simplified P.533 foF2 estimation
  // diurnal variation: peak around 14:00 local, minimum around 04:00
  const hourFactor = 0.6 + 0.4 * Math.cos((hour - 14) * Math.PI / 12);
  const latFactor = 1 - Math.abs(lat) / 150;
  const ssnFactor = Math.sqrt(ssn + 15);
  
  return 0.9 * ssnFactor * hourFactor * latFactor;
}

// ============================================
// ENHANCED PROPAGATION PREDICTION API (Hybrid ITU-R P.533)
// ============================================

app.get('/api/propagation', async (req, res) => {
  const { deLat, deLon, dxLat, dxLon } = req.query;
  
  const useHybrid = ITURHFPROP_URL !== null;
  console.log(`[Propagation] ${useHybrid ? 'Hybrid' : 'Standalone'} calculation for DE:`, deLat, deLon, 'to DX:', dxLat, dxLon);
  
  try {
    // Get current space weather data
    let sfi = 150, ssn = 100, kIndex = 2, aIndex = 10;
    
    try {
      const [fluxRes, kRes] = await Promise.allSettled([
        fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
        fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')
      ]);
      
      if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
        const data = await fluxRes.value.json();
        if (data?.length) sfi = Math.round(data[data.length - 1].flux || 150);
      }
      if (kRes.status === 'fulfilled' && kRes.value.ok) {
        const data = await kRes.value.json();
        if (data?.length > 1) kIndex = parseInt(data[data.length - 1][1]) || 2;
      }
      ssn = Math.max(0, Math.round((sfi - 67) / 0.97));
    } catch (e) {
      console.log('[Propagation] Using default solar values');
    }
    
    // Get real ionosonde data
    const ionosondeStations = await fetchIonosondeData();
    
    // Calculate path geometry
    const de = { lat: parseFloat(deLat) || 40, lon: parseFloat(deLon) || -75 };
    const dx = { lat: parseFloat(dxLat) || 35, lon: parseFloat(dxLon) || 139 };
    
    const distance = haversineDistance(de.lat, de.lon, dx.lat, dx.lon);
    const midLat = (de.lat + dx.lat) / 2;
    let midLon = (de.lon + dx.lon) / 2;
    
    // Handle antimeridian crossing
    if (Math.abs(de.lon - dx.lon) > 180) {
      midLon = (de.lon + dx.lon + 360) / 2;
      if (midLon > 180) midLon -= 360;
    }
    
    // Get ionospheric data at path midpoint
    const ionoData = interpolateFoF2(midLat, midLon, ionosondeStations);
    const hasValidIonoData = !!(ionoData && ionoData.method !== 'no-coverage' && ionoData.foF2);
    
    const currentHour = new Date().getUTCHours();
    const currentMonth = new Date().getMonth() + 1;
    
    console.log('[Propagation] Distance:', Math.round(distance), 'km');
    console.log('[Propagation] Solar: SFI', sfi, 'SSN', ssn, 'K', kIndex);
    if (hasValidIonoData) {
      console.log('[Propagation] Real foF2:', ionoData.foF2?.toFixed(2), 'MHz from', ionoData.nearestStation || ionoData.source);
    }
    
    // ===== HYBRID MODE: Try ITURHFProp first =====
    let hybridResult = null;
    if (useHybrid) {
      const iturhfpropData = await fetchITURHFPropPrediction(
        de.lat, de.lon, dx.lat, dx.lon, ssn, currentMonth, currentHour
      );
      
      if (iturhfpropData && hasValidIonoData) {
        // Full hybrid: ITURHFProp + ionosonde correction
        hybridResult = applyHybridCorrection(iturhfpropData, ionoData, kIndex, sfi);
        console.log('[Propagation] Using HYBRID mode (ITURHFProp + ionosonde correction)');
      } else if (iturhfpropData) {
        // ITURHFProp only (no ionosonde coverage)
        hybridResult = {
          bands: iturhfpropData.bands,
          muf: iturhfpropData.muf,
          model: 'ITU-R P.533-14 (ITURHFProp)'
        };
        console.log('[Propagation] Using ITURHFProp only (no ionosonde coverage)');
      }
    }
    
    // ===== FALLBACK: Built-in calculations =====
    const bands = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '11m', '10m', '6m'];
    const bandFreqs = [1.8, 3.5, 7, 10, 14, 18, 21, 24, 27, 28, 50];
    
    // Generate predictions (hybrid or fallback)
    const effectiveIonoData = hasValidIonoData ? ionoData : null;
    const predictions = {};
    let currentBands;
    
    if (hybridResult) {
      // Use hybrid results for current bands
      currentBands = bands.map((band, idx) => {
        const hybridBand = hybridResult.bands?.[band];
        if (hybridBand) {
          return {
            band,
            freq: bandFreqs[idx],
            reliability: hybridBand.reliability,
            baseReliability: hybridBand.baseReliability,
            snr: calculateSNR(hybridBand.reliability),
            status: hybridBand.status,
            corrected: hybridBand.correctionApplied
          };
        }
        // Fallback for bands not in hybrid result
        const reliability = calculateEnhancedReliability(
          bandFreqs[idx], distance, midLat, midLon, currentHour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
        );
        return {
          band,
          freq: bandFreqs[idx],
          reliability: Math.round(reliability),
          snr: calculateSNR(reliability),
          status: getStatus(reliability)
        };
      }).sort((a, b) => b.reliability - a.reliability);
      
      // Generate 24-hour predictions with correction ratios from hybrid data
      // This makes predictions more accurate by scaling them to match the hybrid model
      bands.forEach((band, idx) => {
        const freq = bandFreqs[idx];
        predictions[band] = [];
        
        // Calculate built-in reliability for current hour
        const builtInCurrentReliability = calculateEnhancedReliability(
          freq, distance, midLat, midLon, currentHour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
        );
        
        // Get hybrid reliability for this band (the accurate one)
        const hybridBand = hybridResult.bands?.[band];
        const hybridReliability = hybridBand?.reliability || builtInCurrentReliability;
        
        // Calculate correction ratio (how much to scale predictions)
        // Avoid division by zero, and cap the ratio to prevent extreme corrections
        let correctionRatio = 1.0;
        if (builtInCurrentReliability > 5) {
          correctionRatio = hybridReliability / builtInCurrentReliability;
          // Cap correction ratio to reasonable bounds (0.2x to 3x)
          correctionRatio = Math.max(0.2, Math.min(3.0, correctionRatio));
        } else if (hybridReliability > 20) {
          // Built-in thinks band is closed but hybrid says it's open
          correctionRatio = 2.0;
        }
        
        for (let hour = 0; hour < 24; hour++) {
          const baseReliability = calculateEnhancedReliability(
            freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
          );
          // Apply correction ratio and clamp to valid range
          const correctedReliability = Math.min(99, Math.max(0, Math.round(baseReliability * correctionRatio)));
          predictions[band].push({
            hour,
            reliability: correctedReliability,
            snr: calculateSNR(correctedReliability)
          });
        }
      });
      
    } else {
      // Full fallback - use built-in calculations
      console.log('[Propagation] Using FALLBACK mode (built-in calculations)');
      
      bands.forEach((band, idx) => {
        const freq = bandFreqs[idx];
        predictions[band] = [];
        for (let hour = 0; hour < 24; hour++) {
          const reliability = calculateEnhancedReliability(
            freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, effectiveIonoData, currentHour
          );
          predictions[band].push({
            hour,
            reliability: Math.round(reliability),
            snr: calculateSNR(reliability)
          });
        }
      });
      
      currentBands = bands.map((band, idx) => ({
        band,
        freq: bandFreqs[idx],
        reliability: predictions[band][currentHour].reliability,
        snr: predictions[band][currentHour].snr,
        status: getStatus(predictions[band][currentHour].reliability)
      })).sort((a, b) => b.reliability - a.reliability);
    }
    
    // Calculate MUF and LUF
    const currentMuf = hybridResult?.muf || calculateMUF(distance, midLat, midLon, currentHour, sfi, ssn, effectiveIonoData);
    const currentLuf = calculateLUF(distance, midLat, currentHour, sfi, kIndex);
    
    // Build ionospheric response
    let ionosphericResponse;
    if (hasValidIonoData) {
      ionosphericResponse = {
        foF2: ionoData.foF2?.toFixed(2),
        mufd: ionoData.mufd?.toFixed(1),
        hmF2: ionoData.hmF2?.toFixed(0),
        source: ionoData.nearestStation || ionoData.source,
        distance: ionoData.nearestDistance,
        method: ionoData.method,
        stationsUsed: ionoData.stationsUsed || 1
      };
    } else if (ionoData?.method === 'no-coverage') {
      ionosphericResponse = {
        source: 'No ionosonde coverage',
        reason: ionoData.reason,
        nearestStation: ionoData.nearestStation,
        nearestDistance: ionoData.nearestDistance,
        method: 'estimated'
      };
    } else {
      ionosphericResponse = { source: 'model', method: 'estimated' };
    }
    
    // Determine data source description
    let dataSource;
    if (hybridResult && hasValidIonoData) {
      dataSource = 'Hybrid: ITURHFProp (ITU-R P.533-14) + KC2G/GIRO ionosonde';
    } else if (hybridResult) {
      dataSource = 'ITURHFProp (ITU-R P.533-14)';
    } else if (hasValidIonoData) {
      dataSource = 'KC2G/GIRO Ionosonde Network';
    } else {
      dataSource = 'Estimated from solar indices';
    }
    
    res.json({
      model: hybridResult?.model || 'Built-in estimation',
      solarData: { sfi, ssn, kIndex },
      ionospheric: ionosphericResponse,
      muf: Math.round(currentMuf * 10) / 10,
      luf: Math.round(currentLuf * 10) / 10,
      distance: Math.round(distance),
      currentHour,
      currentBands,
      hourlyPredictions: predictions,
      hybrid: {
        enabled: useHybrid,
        iturhfpropAvailable: hybridResult !== null,
        ionosondeAvailable: hasValidIonoData,
        correctionFactor: hybridResult?.correction?.factor?.toFixed(2),
        confidence: hybridResult?.correction?.confidence
      },
      dataSource
    });
    
  } catch (error) {
    console.error('[Propagation] Error:', error.message);
    res.status(500).json({ error: 'Failed to calculate propagation' });
  }
});

// Legacy endpoint removed - merged into /api/propagation above

// Calculate MUF using real ionosonde data or model
function calculateMUF(distance, midLat, midLon, hour, sfi, ssn, ionoData) {
  // If we have real MUF(3000) data, scale it for actual distance
  if (ionoData?.mufd) {
    // MUF scales with distance: MUF(d) ≈ MUF(3000) * sqrt(3000/d) for d < 3000km
    // For d > 3000km, MUF(d) ≈ MUF(3000) * (1 + 0.1 * log(d/3000))
    if (distance < 3000) {
      return ionoData.mufd * Math.sqrt(distance / 3000);
    } else {
      return ionoData.mufd * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // If we have foF2, calculate MUF using M(3000)F2 factor
  if (ionoData?.foF2) {
    const M = ionoData.md || 3.0; // M(3000)F2 factor, typically 2.5-3.5
    const muf3000 = ionoData.foF2 * M;
    
    // Scale for actual distance
    if (distance < 3000) {
      return muf3000 * Math.sqrt(distance / 3000);
    } else {
      return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // Fallback: Estimate foF2 from solar indices
  // foF2 ≈ 0.9 * sqrt(SSN + 15) * diurnal_factor
  const hourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12); // Peak at 14:00 local
  const latFactor = 1 - Math.abs(midLat) / 150; // Higher latitudes = lower foF2
  const foF2_est = 0.9 * Math.sqrt(ssn + 15) * hourFactor * latFactor;
  
  // Standard M(3000)F2 factor
  const M = 3.0;
  const muf3000 = foF2_est * M;
  
  // Scale for distance
  if (distance < 3000) {
    return muf3000 * Math.sqrt(distance / 3000);
  } else {
    return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
  }
}

// Calculate LUF (Lowest Usable Frequency) based on D-layer absorption
function calculateLUF(distance, midLat, hour, sfi, kIndex) {
  // LUF increases with:
  // - Higher solar flux (more D-layer ionization)
  // - Daytime (D-layer forms during day)
  // - Shorter paths (higher elevation angles = more time in D-layer)
  // - Geomagnetic activity
  
  // Local solar time at midpoint (approximate)
  const localHour = hour; // Would need proper calculation with midLon
  
  // Day/night factor: D-layer absorption is much higher during daytime
  let dayFactor = 0.3; // Night
  if (localHour >= 6 && localHour <= 18) {
    // Daytime - peaks around noon
    dayFactor = 0.5 + 0.5 * Math.cos((localHour - 12) * Math.PI / 6);
  }
  
  // Solar flux factor: higher SFI = more absorption
  const sfiFactor = 1 + (sfi - 70) / 200;
  
  // Distance factor: shorter paths have higher LUF (higher angles)
  const distFactor = Math.max(0.5, 1 - distance / 10000);
  
  // Latitude factor: polar paths have more absorption
  const latFactor = 1 + Math.abs(midLat) / 90 * 0.5;
  
  // K-index: geomagnetic storms increase absorption
  const kFactor = 1 + kIndex * 0.1;
  
  // Base LUF is around 2 MHz for long night paths
  const baseLuf = 2.0;
  
  return baseLuf * dayFactor * sfiFactor * distFactor * latFactor * kFactor;
}

// Enhanced reliability calculation using real ionosonde data
function calculateEnhancedReliability(freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, ionoData, currentHour) {
  // Calculate MUF and LUF for this hour
  // For non-current hours, we need to estimate how foF2 changes
  let hourIonoData = ionoData;
  
  if (ionoData && hour !== currentHour) {
    // Estimate foF2 change based on diurnal variation
    // foF2 typically varies by factor of 2-3 between day and night
    const currentHourFactor = 1 + 0.4 * Math.cos((currentHour - 14) * Math.PI / 12);
    const targetHourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12);
    const scaleFactor = targetHourFactor / currentHourFactor;
    
    hourIonoData = {
      ...ionoData,
      foF2: ionoData.foF2 * scaleFactor,
      mufd: ionoData.mufd ? ionoData.mufd * scaleFactor : null
    };
  }
  
  const muf = calculateMUF(distance, midLat, midLon, hour, sfi, ssn, hourIonoData);
  const luf = calculateLUF(distance, midLat, hour, sfi, kIndex);
  
  // Calculate reliability based on frequency position relative to MUF/LUF
  let reliability = 0;
  
  if (freq > muf * 1.1) {
    // Well above MUF - very poor
    reliability = Math.max(0, 30 - (freq - muf) * 5);
  } else if (freq > muf) {
    // Slightly above MUF - marginal (sometimes works due to scatter)
    reliability = 30 + (muf * 1.1 - freq) / (muf * 0.1) * 20;
  } else if (freq < luf * 0.8) {
    // Well below LUF - absorbed
    reliability = Math.max(0, 20 - (luf - freq) * 10);
  } else if (freq < luf) {
    // Near LUF - marginal
    reliability = 20 + (freq - luf * 0.8) / (luf * 0.2) * 30;
  } else {
    // In usable range - calculate optimum
    // Optimum Working Frequency (OWF) is typically 80-85% of MUF
    const owf = muf * 0.85;
    const range = muf - luf;
    
    if (range <= 0) {
      reliability = 30; // Very narrow window
    } else {
      // Higher reliability near OWF, tapering toward MUF and LUF
      const position = (freq - luf) / range; // 0 at LUF, 1 at MUF
      const optimalPosition = 0.75; // 75% up from LUF = OWF
      
      if (position < optimalPosition) {
        // Below OWF - reliability increases as we approach OWF
        reliability = 50 + (position / optimalPosition) * 45;
      } else {
        // Above OWF - reliability decreases as we approach MUF
        reliability = 95 - ((position - optimalPosition) / (1 - optimalPosition)) * 45;
      }
    }
  }
  
  // K-index degradation (geomagnetic storms)
  if (kIndex >= 7) reliability *= 0.1;
  else if (kIndex >= 6) reliability *= 0.2;
  else if (kIndex >= 5) reliability *= 0.4;
  else if (kIndex >= 4) reliability *= 0.6;
  else if (kIndex >= 3) reliability *= 0.8;
  
  // Very long paths (multiple hops) are harder
  const hops = Math.ceil(distance / 3500);
  if (hops > 1) {
    reliability *= Math.pow(0.92, hops - 1); // ~8% loss per additional hop
  }
  
  // Polar path penalty (auroral absorption)
  if (Math.abs(midLat) > 60) {
    reliability *= 0.7;
    if (kIndex >= 3) reliability *= 0.7; // Additional penalty during storms
  }
  
  // High bands need sufficient solar activity
  if (freq >= 21 && sfi < 100) reliability *= Math.sqrt(sfi / 100);
  if (freq >= 28 && sfi < 120) reliability *= Math.sqrt(sfi / 120);
  if (freq >= 50 && sfi < 150) reliability *= Math.pow(sfi / 150, 1.5);
  
  // Low bands work better at night
  const localHour = (hour + midLon / 15 + 24) % 24;
  const isNight = localHour < 6 || localHour > 18;
  if (freq <= 7 && isNight) reliability *= 1.1;
  if (freq <= 3.5 && !isNight) reliability *= 0.7;
  
  return Math.min(99, Math.max(0, reliability));
}

// Convert reliability to estimated SNR
function calculateSNR(reliability) {
  if (reliability >= 80) return '+20dB';
  if (reliability >= 60) return '+10dB';
  if (reliability >= 40) return '0dB';
  if (reliability >= 20) return '-10dB';
  return '-20dB';
}

// Get status label from reliability
function getStatus(reliability) {
  if (reliability >= 70) return 'EXCELLENT';
  if (reliability >= 50) return 'GOOD';
  if (reliability >= 30) return 'FAIR';
  if (reliability >= 15) return 'POOR';
  return 'CLOSED';
}

// QRZ Callsign lookup (requires API key)
app.get('/api/qrz/lookup/:callsign', async (req, res) => {
  const { callsign } = req.params;
  // Note: QRZ requires an API key - this is a placeholder
  res.json({ 
    message: 'QRZ lookup requires API key configuration',
    callsign: callsign.toUpperCase()
  });
});

// ============================================
// CONTEST CALENDAR API
// ============================================

app.get('/api/contests', async (req, res) => {
  // Try WA7BNM Contest Calendar RSS feed
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://www.contestcalendar.com/calendar.rss', {
      headers: { 
        'User-Agent': 'OpenHamClock/3.3',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const contests = parseContestRSS(text);
      
      if (contests.length > 0) {
        console.log('[Contests] WA7BNM RSS:', contests.length, 'contests');
        return res.json(contests);
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('[Contests] RSS error:', error.message);
    }
  }

  // Fallback: Use calculated contests
  try {
    const contests = calculateUpcomingContests();
    console.log('[Contests] Using calculated:', contests.length, 'contests');
    return res.json(contests);
  } catch (error) {
    console.error('[Contests] Calculation error:', error.message);
  }

  res.json([]);
});

// Parse WA7BNM RSS feed
function parseContestRSS(xml) {
  const contests = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Simple regex-based XML parsing (no external dependencies)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>([^<]+)<\/title>/;
  const linkRegex = /<link>([^<]+)<\/link>/;
  const descRegex = /<description>([^<]+)<\/description>/;
  
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    
    const titleMatch = item.match(titleRegex);
    const linkMatch = item.match(linkRegex);
    const descMatch = item.match(descRegex);
    
    if (titleMatch && descMatch) {
      const name = titleMatch[1].trim();
      const desc = descMatch[1].trim();
      const url = linkMatch ? linkMatch[1].trim() : null;
      
      // Parse description like "1300Z, Jan 31 to 1300Z, Feb 1" or "0000Z-2359Z, Jan 31"
      const parsed = parseContestDateTime(desc, currentYear);
      
      if (parsed) {
        const status = (now >= parsed.start && now <= parsed.end) ? 'active' : 'upcoming';
        
        // Try to detect mode from contest name
        let mode = 'Mixed';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('cw') || nameLower.includes('morse')) mode = 'CW';
        else if (nameLower.includes('ssb') || nameLower.includes('phone') || nameLower.includes('sideband')) mode = 'SSB';
        else if (nameLower.includes('rtty')) mode = 'RTTY';
        else if (nameLower.includes('ft4') || nameLower.includes('ft8') || nameLower.includes('digi')) mode = 'Digital';
        else if (nameLower.includes('vhf') || nameLower.includes('uhf')) mode = 'VHF';
        
        contests.push({
          name,
          start: parsed.start.toISOString(),
          end: parsed.end.toISOString(),
          mode,
          status,
          url
        });
      }
    }
  }
  
  // Sort by start date, filter out past contests, and limit
  const currentAndFuture = contests.filter(c => new Date(c.end) >= now);
  currentAndFuture.sort((a, b) => new Date(a.start) - new Date(b.start));
  return currentAndFuture.slice(0, 20);
}

// Parse contest date/time strings
function parseContestDateTime(desc, year) {
  try {
    const months = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 
                     'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    
    // Pattern 1: "1300Z, Jan 31 to 1300Z, Feb 1"
    const rangeMatch = desc.match(/(\d{4})Z,\s*(\w+)\s+(\d+)\s+to\s+(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (rangeMatch) {
      const [, startTime, startMon, startDay, endTime, endMon, endDay] = rangeMatch;
      const startMonth = months[startMon.toLowerCase()];
      const endMonth = months[endMon.toLowerCase()];
      
      let startYear = year;
      let endYear = year;
      // Handle year rollover
      if (startMonth > 10 && endMonth < 2) endYear = year + 1;
      
      const start = new Date(Date.UTC(startYear, startMonth, parseInt(startDay), 
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(endYear, endMonth, parseInt(endDay),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      return { start, end };
    }
    
    // Pattern 2: "0000Z-2359Z, Jan 31" (same day)
    const sameDayMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (sameDayMatch) {
      const [, startTime, endTime, mon, day] = sameDayMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      // Handle overnight contests (end time < start time means next day)
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
    // Pattern 3: "0000Z-0100Z, Feb 5 and 0200Z-0300Z, Feb 6" (multiple sessions - use first)
    const multiMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (multiMatch) {
      const [, startTime, endTime, mon, day] = multiMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
  } catch (e) {
    // Parse error, skip this contest
  }
  
  return null;
}

// Helper function to calculate upcoming contests
function calculateUpcomingContests() {
  const now = new Date();
  const contests = [];
  
  // Major contest definitions with typical schedules
  const majorContests = [
    { name: 'CQ WW DX CW', month: 10, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend Nov
    { name: 'CQ WW DX SSB', month: 9, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Oct
    { name: 'ARRL DX CW', month: 1, weekend: 3, duration: 48, mode: 'CW' }, // 3rd full weekend Feb
    { name: 'ARRL DX SSB', month: 2, weekend: 1, duration: 48, mode: 'SSB' }, // 1st full weekend Mar
    { name: 'CQ WPX SSB', month: 2, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Mar
    { name: 'CQ WPX CW', month: 4, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend May
    { name: 'IARU HF Championship', month: 6, weekend: 2, duration: 24, mode: 'Mixed' }, // 2nd full weekend Jul
    { name: 'ARRL Field Day', month: 5, weekend: 4, duration: 27, mode: 'Mixed' }, // 4th full weekend Jun
    { name: 'ARRL Sweepstakes CW', month: 10, weekend: 1, duration: 24, mode: 'CW' }, // 1st full weekend Nov
    { name: 'ARRL Sweepstakes SSB', month: 10, weekend: 3, duration: 24, mode: 'SSB' }, // 3rd full weekend Nov
    { name: 'ARRL 10m Contest', month: 11, weekend: 2, duration: 48, mode: 'Mixed' }, // 2nd full weekend Dec
    { name: 'ARRL RTTY Roundup', month: 0, weekend: 1, duration: 24, mode: 'RTTY' }, // 1st full weekend Jan
    { name: 'NA QSO Party CW', month: 0, weekend: 2, duration: 12, mode: 'CW' },
    { name: 'NA QSO Party SSB', month: 0, weekend: 3, duration: 12, mode: 'SSB' },
    { name: 'CQ 160m CW', month: 0, weekend: -1, duration: 42, mode: 'CW' }, // Last full weekend Jan
    { name: 'CQ 160m SSB', month: 1, weekend: -1, duration: 42, mode: 'SSB' }, // Last full weekend Feb
    { name: 'CQ WW RTTY', month: 8, weekend: -1, duration: 48, mode: 'RTTY' },
    { name: 'JIDX CW', month: 3, weekend: 2, duration: 48, mode: 'CW' },
    { name: 'JIDX SSB', month: 10, weekend: 2, duration: 48, mode: 'SSB' },
    { name: 'ARRL VHF Contest', month: 0, weekend: 3, duration: 33, mode: 'Mixed' }, // 3rd weekend Jan
    { name: 'ARRL June VHF', month: 5, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Jun
    { name: 'ARRL Sept VHF', month: 8, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Sep
    { name: 'Winter Field Day', month: 0, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Jan
    { name: 'CQWW WPX RTTY', month: 1, weekend: 2, duration: 48, mode: 'RTTY' }, // 2nd weekend Feb
    { name: 'Stew Perry Topband', month: 11, weekend: 4, duration: 14, mode: 'CW' }, // 4th weekend Dec
    { name: 'RAC Canada Day', month: 6, weekend: 1, duration: 24, mode: 'Mixed' }, // 1st weekend Jul
    { name: 'RAC Winter Contest', month: 11, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Dec
    { name: 'NAQP RTTY', month: 1, weekend: 4, duration: 12, mode: 'RTTY' }, // 4th weekend Feb
    { name: 'NAQP RTTY', month: 6, weekend: 3, duration: 12, mode: 'RTTY' }, // 3rd weekend Jul
  ];

  // Weekly mini-contests (CWT, SST, etc.) - dayOfWeek: 0=Sun, 1=Mon, ... 6=Sat
  const weeklyContests = [
    { name: 'CWT 1300z', dayOfWeek: 3, hour: 13, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 1900z', dayOfWeek: 3, hour: 19, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 0300z', dayOfWeek: 4, hour: 3, duration: 1, mode: 'CW' }, // Thursday
    { name: 'CWT 0700z', dayOfWeek: 4, hour: 7, duration: 1, mode: 'CW' }, // Thursday
    { name: 'NCCC Sprint', dayOfWeek: 5, hour: 3, minute: 30, duration: 0.5, mode: 'CW' }, // Friday
    { name: 'K1USN SST', dayOfWeek: 0, hour: 0, duration: 1, mode: 'CW' }, // Sunday 0000z (Sat evening US)
    { name: 'K1USN SST', dayOfWeek: 1, hour: 20, duration: 1, mode: 'CW' }, // Monday 2000z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 13, duration: 1, mode: 'CW' }, // Monday 1300z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 19, duration: 1, mode: 'CW' }, // Monday 1900z
    { name: 'ICWC MST', dayOfWeek: 2, hour: 3, duration: 1, mode: 'CW' }, // Tuesday 0300z
    { name: 'SKCC Sprint', dayOfWeek: 3, hour: 0, duration: 2, mode: 'CW' }, // Wednesday 0000z
    { name: 'QRP Fox Hunt', dayOfWeek: 3, hour: 2, duration: 1.5, mode: 'CW' }, // Wednesday 0200z
    { name: 'RTTY Weekday Sprint', dayOfWeek: 2, hour: 23, duration: 1, mode: 'RTTY' }, // Tuesday 2300z
  ];

  // Calculate next occurrences of weekly contests
  weeklyContests.forEach(contest => {
    const next = new Date(now);
    const currentDay = now.getUTCDay();
    let daysUntil = contest.dayOfWeek - currentDay;
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0) {
      // Check if it's today but already passed
      const todayStart = new Date(now);
      todayStart.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
      if (now > todayStart) daysUntil = 7;
    }
    
    next.setUTCDate(now.getUTCDate() + daysUntil);
    next.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
    
    const endTime = new Date(next.getTime() + contest.duration * 3600000);
    
    contests.push({
      name: contest.name,
      start: next.toISOString(),
      end: endTime.toISOString(),
      mode: contest.mode,
      status: (now >= next && now <= endTime) ? 'active' : 'upcoming'
    });
  });

  // Calculate next occurrences of major contests
  const year = now.getFullYear();
  majorContests.forEach(contest => {
    for (let y = year; y <= year + 1; y++) {
      let startDate;
      
      if (contest.weekend === -1) {
        // Last weekend of month
        startDate = getLastWeekendOfMonth(y, contest.month);
      } else {
        // Nth weekend of month
        startDate = getNthWeekendOfMonth(y, contest.month, contest.weekend);
      }
      
      // Most contests start at 00:00 UTC Saturday
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + contest.duration * 3600000);
      
      if (endDate > now) {
        const status = (now >= startDate && now <= endDate) ? 'active' : 'upcoming';
        contests.push({
          name: contest.name,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          mode: contest.mode,
          status: status
        });
        break; // Only add next occurrence
      }
    }
  });

  // Sort by start date
  contests.sort((a, b) => new Date(a.start) - new Date(b.start));
  
  return contests.slice(0, 15);
}

function getNthWeekendOfMonth(year, month, n) {
  const date = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  let weekendCount = 0;
  
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === 6) { // Saturday
      weekendCount++;
      if (weekendCount === n) return new Date(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  
  return date;
}

function getLastWeekendOfMonth(year, month) {
  // Start from last day of month and work backwards
  const date = new Date(Date.UTC(year, month + 1, 0)); // Last day of month
  
  while (date.getUTCDay() !== 6) { // Find last Saturday
    date.setUTCDate(date.getUTCDate() - 1);
  }
  
  return date;
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.3.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ============================================
// CONFIGURATION ENDPOINT
// ============================================

app.get('/api/config', (req, res) => {
  res.json({
    version: '3.0.0',
    features: {
      spaceWeather: true,
      pota: true,
      sota: true,
      dxCluster: true,
      satellites: false, // Coming soon
      contests: false    // Coming soon
    },
    refreshIntervals: {
      spaceWeather: 300000,
      pota: 60000,
      sota: 60000,
      dxCluster: 30000
    }
  });
});

// ============================================
// CATCH-ALL FOR SPA
// ============================================

app.get('*', (req, res) => {
  const indexPath = process.env.NODE_ENV === 'production'
    ? path.join(__dirname, 'dist', 'index.html')
    : path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath);
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║                                                       ║');
  console.log('║   ██████╗ ██████╗ ███████╗███╗   ██╗                  ║');
  console.log('║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║                  ║');
  console.log('║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║                  ║');
  console.log('║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║                  ║');
  console.log('║  ╚██████╔╝██║     ███████╗██║ ╚████║                  ║');
  console.log('║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝                  ║');
  console.log('║                                                       ║');
  console.log('║  ██╗  ██╗ █████╗ ███╗   ███╗ ██████╗██╗      ██╗  ██╗ ║');
  console.log('║  ██║  ██║██╔══██╗████╗ ████║██╔════╝██║      ██║ ██╔╝ ║');
  console.log('║  ███████║███████║██╔████╔██║██║     ██║      █████╔╝  ║');
  console.log('║  ██╔══██║██╔══██║██║╚██╔╝██║██║     ██║      ██╔═██╗  ║');
  console.log('║  ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╗███████╗██║  ██╗ ║');
  console.log('║  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ║');
  console.log('║                                                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Server running at http://localhost:${PORT}`);
  console.log('  📡 API proxy enabled for NOAA, POTA, SOTA, DX Cluster');
  console.log('  🖥️  Open your browser to start using OpenHamClock');
  console.log('');
  console.log('  In memory of Elwood Downey, WB0OEW');
  console.log('  73 de OpenHamClock contributors');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
