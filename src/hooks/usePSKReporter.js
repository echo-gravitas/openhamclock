/**
 * usePSKReporter Hook
 * Fetches PSKReporter data via MQTT WebSocket + HTTP fallback
 * 
 * Primary: Real-time MQTT feed from mqtt.pskreporter.info
 * Fallback: HTTP API via server proxy if MQTT fails to connect
 * 
 * MQTT message format (from mqtt.pskreporter.info):
 *   sc = sender call, rc = receiver call
 *   sl = sender locator, rl = receiver locator
 *   sa = sender ADIF country code, ra = receiver ADIF country code
 *   f = frequency, md = mode, rp = report (SNR), t = timestamp
 *   b = band, sq = sequence number
 * 
 * Topic format: pskr/filter/v2/{band}/{mode}/{sendercall}/{receivercall}/{senderlocator}/{receiverlocator}/{sendercountry}/{receivercountry}
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import mqtt from 'mqtt';

// Convert grid square to lat/lon
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  
  const g = grid.toUpperCase();
  const lon = (g.charCodeAt(0) - 65) * 20 - 180;
  const lat = (g.charCodeAt(1) - 65) * 10 - 90;
  const lonMin = parseInt(g[2]) * 2;
  const latMin = parseInt(g[3]) * 1;
  
  let finalLon = lon + lonMin + 1;
  let finalLat = lat + latMin + 0.5;
  
  if (grid.length >= 6) {
    const lonSec = (g.charCodeAt(4) - 65) * (2/24);
    const latSec = (g.charCodeAt(5) - 65) * (1/24);
    finalLon = lon + lonMin + lonSec + (1/24);
    finalLat = lat + latMin + latSec + (0.5/24);
  }
  
  return { lat: finalLat, lon: finalLon };
}

// Get band name from frequency in Hz
function getBandFromHz(freqHz) {
  const freqMHz = freqHz / 1000000;
  if (freqMHz >= 1.8 && freqMHz <= 2) return '160m';
  if (freqMHz >= 3.5 && freqMHz <= 4) return '80m';
  if (freqMHz >= 5.3 && freqMHz <= 5.4) return '60m';
  if (freqMHz >= 7 && freqMHz <= 7.3) return '40m';
  if (freqMHz >= 10.1 && freqMHz <= 10.15) return '30m';
  if (freqMHz >= 14 && freqMHz <= 14.35) return '20m';
  if (freqMHz >= 18.068 && freqMHz <= 18.168) return '17m';
  if (freqMHz >= 21 && freqMHz <= 21.45) return '15m';
  if (freqMHz >= 24.89 && freqMHz <= 24.99) return '12m';
  if (freqMHz >= 28 && freqMHz <= 29.7) return '10m';
  if (freqMHz >= 50 && freqMHz <= 54) return '6m';
  if (freqMHz >= 144 && freqMHz <= 148) return '2m';
  if (freqMHz >= 420 && freqMHz <= 450) return '70cm';
  return 'Unknown';
}

// MQTT connection timeout before falling back to HTTP (seconds)
const MQTT_TIMEOUT_MS = 12000;
// HTTP poll interval when using fallback (ms)
const HTTP_POLL_INTERVAL = 120000; // 2 minutes

export const usePSKReporter = (callsign, options = {}) => {
  const {
    minutes = 15,           // Time window to keep spots
    enabled = true,         // Enable/disable fetching
    maxSpots = 100          // Max spots to keep
  } = options;

  const [txReports, setTxReports] = useState([]);
  const [rxReports, setRxReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [source, setSource] = useState('connecting');
  
  const clientRef = useRef(null);
  const txReportsRef = useRef([]);
  const rxReportsRef = useRef([]);
  const mountedRef = useRef(true);
  const httpFallbackRef = useRef(null);
  const mqttTimerRef = useRef(null);

  // Clean old spots (older than specified minutes)
  const cleanOldSpots = useCallback((spots, maxAgeMinutes) => {
    const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
    return spots.filter(s => s.timestamp > cutoff).slice(0, maxSpots);
  }, [maxSpots]);

  // HTTP fallback fetch
  const fetchHTTP = useCallback(async (cs) => {
    if (!mountedRef.current || !cs) return;
    
    try {
      const res = await fetch(`/api/pskreporter/${encodeURIComponent(cs)}?minutes=${minutes}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const data = await res.json();
      if (!mountedRef.current) return;
      
      // Merge TX reports
      if (data.tx?.reports?.length) {
        txReportsRef.current = data.tx.reports.slice(0, maxSpots);
        setTxReports([...txReportsRef.current]);
      }
      
      // Merge RX reports
      if (data.rx?.reports?.length) {
        rxReportsRef.current = data.rx.reports.slice(0, maxSpots);
        setRxReports([...rxReportsRef.current]);
      }
      
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
      setSource('http');
      setConnected(true);
      
      console.log(`[PSKReporter HTTP] Loaded ${data.tx?.count || 0} TX, ${data.rx?.count || 0} RX for ${cs}`);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('[PSKReporter HTTP] Fallback error:', err.message);
      setError('HTTP fallback failed');
      setLoading(false);
      setSource('error');
    }
  }, [minutes, maxSpots]);

  // Process incoming MQTT message
  const processMessage = useCallback((topic, message) => {
    if (!mountedRef.current) return;
    
    try {
      const data = JSON.parse(message.toString());
      
      // PSKReporter MQTT message fields:
      // sc = sender call, rc = receiver call (NOT sa/ra which are ADIF country codes)
      // sl = sender locator, rl = receiver locator
      // f = frequency, md = mode, rp = report (SNR), t = timestamp, b = band
      const {
        sc: senderCallsign,
        sl: senderLocator,
        rc: receiverCallsign,
        rl: receiverLocator,
        f: frequency,
        md: mode,
        rp: snr,
        t: timestamp,
        b: band
      } = data;

      if (!senderCallsign || !receiverCallsign) return;

      const senderLoc = gridToLatLon(senderLocator);
      const receiverLoc = gridToLatLon(receiverLocator);
      const freq = parseInt(frequency) || 0;
      const now = Date.now();
      
      const report = {
        sender: senderCallsign,
        senderGrid: senderLocator,
        receiver: receiverCallsign,
        receiverGrid: receiverLocator,
        freq,
        freqMHz: freq ? (freq / 1000000).toFixed(3) : '?',
        band: band || getBandFromHz(freq),
        mode: mode || 'Unknown',
        snr: snr !== undefined ? parseInt(snr) : null,
        timestamp: timestamp ? timestamp * 1000 : now,
        age: 0,
        lat: null,
        lon: null
      };

      const upperCallsign = callsign?.toUpperCase();
      if (!upperCallsign) return;
      
      // If I'm the sender, this is a TX report (someone heard me)
      if (senderCallsign.toUpperCase() === upperCallsign) {
        report.lat = receiverLoc?.lat;
        report.lon = receiverLoc?.lon;
        
        // Add to front, dedupe by receiver+freq, limit size
        txReportsRef.current = [report, ...txReportsRef.current]
          .filter((r, i, arr) => 
            i === arr.findIndex(x => x.receiver === r.receiver && Math.abs(x.freq - r.freq) < 1000)
          )
          .slice(0, maxSpots);
        
        setTxReports(cleanOldSpots([...txReportsRef.current], minutes));
        setLastUpdate(new Date());
      }
      
      // If I'm the receiver, this is an RX report (I heard someone)
      if (receiverCallsign.toUpperCase() === upperCallsign) {
        report.lat = senderLoc?.lat;
        report.lon = senderLoc?.lon;
        
        rxReportsRef.current = [report, ...rxReportsRef.current]
          .filter((r, i, arr) => 
            i === arr.findIndex(x => x.sender === r.sender && Math.abs(x.freq - r.freq) < 1000)
          )
          .slice(0, maxSpots);
        
        setRxReports(cleanOldSpots([...rxReportsRef.current], minutes));
        setLastUpdate(new Date());
      }
      
    } catch (err) {
      // Silently ignore parse errors - malformed messages happen
    }
  }, [callsign, minutes, maxSpots, cleanOldSpots]);

  // Connect to MQTT with HTTP fallback
  useEffect(() => {
    mountedRef.current = true;
    
    if (!callsign || callsign === 'N0CALL' || !enabled) {
      setTxReports([]);
      setRxReports([]);
      setLoading(false);
      setSource('disabled');
      setConnected(false);
      return;
    }

    const upperCallsign = callsign.toUpperCase();
    
    // Clear old data
    txReportsRef.current = [];
    rxReportsRef.current = [];
    setTxReports([]);
    setRxReports([]);
    setLoading(true);
    setError(null);
    setSource('connecting');

    let mqttFailed = false;

    console.log(`[PSKReporter MQTT] Connecting for ${upperCallsign}...`);

    // Connect to PSKReporter MQTT via WebSocket (TLS on port 1886)
    const client = mqtt.connect('wss://mqtt.pskreporter.info:1886/mqtt', {
      clientId: `ohc_${upperCallsign}_${Math.random().toString(16).substr(2, 6)}`,
      clean: true,
      connectTimeout: 15000,
      reconnectPeriod: 60000,
      keepalive: 60
    });

    clientRef.current = client;

    // Set timeout — if MQTT doesn't connect within N seconds, fall back to HTTP
    mqttTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || connected) return;
      
      mqttFailed = true;
      console.log('[PSKReporter] MQTT timeout, falling back to HTTP...');
      setSource('http-fallback');
      
      // Initial HTTP fetch
      fetchHTTP(upperCallsign);
      
      // Poll periodically
      httpFallbackRef.current = setInterval(() => {
        if (mountedRef.current) fetchHTTP(upperCallsign);
      }, HTTP_POLL_INTERVAL);
    }, MQTT_TIMEOUT_MS);

    client.on('connect', () => {
      if (!mountedRef.current) return;
      
      // Cancel HTTP fallback timer
      if (mqttTimerRef.current) {
        clearTimeout(mqttTimerRef.current);
        mqttTimerRef.current = null;
      }
      // Stop any HTTP polling
      if (httpFallbackRef.current) {
        clearInterval(httpFallbackRef.current);
        httpFallbackRef.current = null;
      }
      
      mqttFailed = false;
      console.log('[PSKReporter MQTT] Connected!');
      setConnected(true);
      setLoading(false);
      setSource('mqtt');
      setError(null);

      // Topic format: pskr/filter/v2/{band}/{mode}/{senderCall}/{receiverCall}/...
      
      // TX: Subscribe where we are the sender (being heard by others)
      // Sender call is at position 3 after v2 (index 5 in full topic)
      const txTopic = `pskr/filter/v2/+/+/${upperCallsign}/#`;
      client.subscribe(txTopic, { qos: 0 }, (err) => {
        if (err) {
          console.error('[PSKReporter MQTT] TX subscribe error:', err);
        } else {
          console.log(`[PSKReporter MQTT] Subscribed TX: ${txTopic}`);
        }
      });

      // RX: Subscribe where we are the receiver (hearing others)
      // Receiver call is at position 4 after v2 (index 6 in full topic)
      const rxTopic = `pskr/filter/v2/+/+/+/${upperCallsign}/#`;
      client.subscribe(rxTopic, { qos: 0 }, (err) => {
        if (err) {
          console.error('[PSKReporter MQTT] RX subscribe error:', err);
        } else {
          console.log(`[PSKReporter MQTT] Subscribed RX: ${rxTopic}`);
        }
      });
    });

    client.on('message', processMessage);

    client.on('error', (err) => {
      if (!mountedRef.current) return;
      console.error('[PSKReporter MQTT] Error:', err.message);
      setError('MQTT connection error');
      // Don't set loading false here - let the timeout trigger HTTP fallback
    });

    client.on('close', () => {
      if (!mountedRef.current) return;
      console.log('[PSKReporter MQTT] Disconnected');
      setConnected(false);
    });

    client.on('offline', () => {
      if (!mountedRef.current) return;
      console.log('[PSKReporter MQTT] Offline');
      setConnected(false);
      if (!mqttFailed) setSource('offline');
    });

    client.on('reconnect', () => {
      if (!mountedRef.current) return;
      console.log('[PSKReporter MQTT] Reconnecting...');
      if (!mqttFailed) setSource('reconnecting');
    });

    // Cleanup on unmount or callsign change
    return () => {
      mountedRef.current = false;
      if (mqttTimerRef.current) {
        clearTimeout(mqttTimerRef.current);
        mqttTimerRef.current = null;
      }
      if (httpFallbackRef.current) {
        clearInterval(httpFallbackRef.current);
        httpFallbackRef.current = null;
      }
      if (client) {
        console.log('[PSKReporter MQTT] Cleaning up...');
        client.end(true);
      }
    };
  }, [callsign, enabled, processMessage, fetchHTTP]);

  // Periodically clean old spots and update ages
  useEffect(() => {
    if (!enabled) return;
    
    const interval = setInterval(() => {
      // Update ages and clean old spots
      const now = Date.now();
      
      setTxReports(prev => prev.map(r => ({
        ...r,
        age: Math.floor((now - r.timestamp) / 60000)
      })).filter(r => r.age <= minutes));
      
      setRxReports(prev => prev.map(r => ({
        ...r,
        age: Math.floor((now - r.timestamp) / 60000)
      })).filter(r => r.age <= minutes));
      
    }, 30000); // Every 30 seconds
    
    return () => clearInterval(interval);
  }, [enabled, minutes]);

  // Manual refresh - force reconnect
  const refresh = useCallback(() => {
    // Stop HTTP polling
    if (httpFallbackRef.current) {
      clearInterval(httpFallbackRef.current);
      httpFallbackRef.current = null;
    }
    if (mqttTimerRef.current) {
      clearTimeout(mqttTimerRef.current);
      mqttTimerRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.end(true);
      clientRef.current = null;
    }
    setConnected(false);
    setLoading(true);
    setSource('reconnecting');
    // useEffect will reconnect due to state change
  }, []);

  return {
    txReports,
    txCount: txReports.length,
    rxReports,
    rxCount: rxReports.length,
    loading,
    error,
    connected,
    source,
    lastUpdate,
    refresh
  };
};

export default usePSKReporter;
