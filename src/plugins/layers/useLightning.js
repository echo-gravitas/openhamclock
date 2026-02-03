import { useState, useEffect, useRef } from 'react';

// Lightning Detection Plugin - Real-time lightning strike visualization
// Data source: Simulated lightning strikes (can be replaced with Blitzortung.org API)
// Update: Real-time (every 30 seconds)

export const metadata = {
  id: 'lightning',
  name: 'Lightning Detection(Testing-Simulated)',
  description: 'Real-time lightning strike detection and visualization',
  icon: '⚡',
  category: 'weather',
  defaultEnabled: false,
  defaultOpacity: 0.9,
  version: '1.0.0'
};

// Strike age colors (fading over time)
function getStrikeColor(ageMinutes) {
  if (ageMinutes < 1) return '#FFD700'; // Gold (fresh, <1 min)
  if (ageMinutes < 5) return '#FFA500'; // Orange (recent, <5 min)
  if (ageMinutes < 15) return '#FF6B6B'; // Red (aging, <15 min)
  if (ageMinutes < 30) return '#CD5C5C'; // Dark red (old, <30 min)
  return '#8B4513'; // Brown (very old, >30 min)
}

// Generate simulated lightning strikes (demo data)
// In production, this would fetch from a real API
function generateSimulatedStrikes(count = 50) {
  const strikes = [];
  const now = Date.now();
  
  // Generate strikes across the globe with realistic clustering
  const stormCenters = [
    { lat: 28.5, lon: -81.5, name: 'Florida' }, // Florida
    { lat: 40.7, lon: -74.0, name: 'New York' }, // New York
    { lat: 51.5, lon: -0.1, name: 'London' }, // London
    { lat: -23.5, lon: -46.6, name: 'São Paulo' }, // São Paulo
    { lat: 1.3, lon: 103.8, name: 'Singapore' }, // Singapore
    { lat: -33.9, lon: 151.2, name: 'Sydney' }, // Sydney
    { lat: 19.4, lon: -99.1, name: 'Mexico City' }, // Mexico City
    { lat: 13.7, lon: 100.5, name: 'Bangkok' }, // Bangkok
  ];
  
  // Use strike INDEX as seed for completely stable positions
  // Each strike always appears at the same location
  for (let i = 0; i < count; i++) {
    const seed = i * 12345; // Each strike has fixed seed based on index
    const seededRandom = seed * 9301 + 49297; // Simple LCG
    const r1 = (seededRandom % 233280) / 233280.0;
    const r2 = ((seededRandom * 7) % 233280) / 233280.0;
    const r3 = ((seededRandom * 13) % 233280) / 233280.0;
    
    // Pick a storm center (always same center for this index)
    const center = stormCenters[Math.floor(r1 * stormCenters.length)];
    
    // Create strike near the center (always same offset for this index)
    const latOffset = (r2 - 0.5) * 2.0; // ~220 km spread
    const lonOffset = (r3 - 0.5) * 2.0;
    
    // Calculate fixed position for this strike
    const lat = Math.round((center.lat + latOffset) * 10) / 10;
    const lon = Math.round((center.lon + lonOffset) * 10) / 10;
    
    // Age cycles over time (strikes "age out" and "reappear" as fresh)
    const cycleMs = 30 * 60 * 1000; // 30 minute cycle
    const ageMs = ((now + (i * 10000)) % cycleMs); // Stagger ages
    const timestamp = now - ageMs;
    const roundedTime = Math.floor(timestamp / 10000) * 10000; // Round to 10s for ID changes
    
    // Intensity fixed for this strike
    const intensity = (r2 * 200) - 50; // -50 to +150 kA
    const polarity = intensity >= 0 ? 'positive' : 'negative';
    
    strikes.push({
      id: `strike_${i}_${lat}_${lon}_${roundedTime}`, // Include time for ID changes
      lat,  // Fixed position
      lon,  // Fixed position
      timestamp,
      age: ageMs / 1000,
      intensity: Math.abs(intensity),
      polarity,
      region: center.name
    });
  }
  
  return strikes.sort((a, b) => b.timestamp - a.timestamp); // Newest first
}

export function useLayer({ enabled = false, opacity = 0.9, map = null }) {
  const [strikeMarkers, setStrikeMarkers] = useState([]);
  const [lightningData, setLightningData] = useState([]);
  const [statsControl, setStatsControl] = useState(null);
  const previousStrikeIds = useRef(new Set());
  const updateIntervalRef = useRef(null);
  const isFirstLoad = useRef(true);

  // Fetch lightning data (simulated for now)
  useEffect(() => {
    if (!enabled) return;

    const fetchLightning = () => {
      try {
        // In production, this would be:
        // const response = await fetch('/api/lightning/strikes?minutes=30');
        // const data = await response.json();
        
        // For now, generate simulated data
        const strikes = generateSimulatedStrikes(50);
        console.log('[Lightning] Generated', strikes.length, 'strikes at', new Date().toLocaleTimeString());
        setLightningData(strikes);
      } catch (err) {
        console.error('Lightning data fetch error:', err);
      }
    };

    fetchLightning();
    // Refresh every 30 seconds
    updateIntervalRef.current = setInterval(fetchLightning, 30000);

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
      }
    };
  }, [enabled]);

  // Render strike markers with animation
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    // Clear old markers
    strikeMarkers.forEach(marker => {
      try {
        map.removeLayer(marker);
      } catch (e) {
        // Already removed
      }
    });
    setStrikeMarkers([]);

    if (!enabled || lightningData.length === 0) return;

    const newMarkers = [];
    const currentStrikeIds = new Set();

    lightningData.forEach(strike => {
      const { id, lat, lon, timestamp, age, intensity, polarity, region } = strike;
      
      currentStrikeIds.add(id);
      
      // Check if this is a new strike (but not on first load)
      const isNew = !isFirstLoad.current && !previousStrikeIds.current.has(id);
      
      // Calculate age in minutes
      const ageMinutes = age / 60;
      const color = getStrikeColor(ageMinutes);
      
      // Size based on intensity (12-32px)
      const size = Math.min(Math.max(intensity / 8, 12), 32);
      
      // Create lightning bolt icon marker with high visibility
      const icon = L.divIcon({
        className: 'lightning-strike-icon',
        html: `<div style="
          background-color: ${color}; 
          color: white; 
          width: ${size}px; 
          height: ${size}px; 
          border-radius: 50%; 
          display: flex; 
          align-items: center; 
          justify-content: center;
          font-size: ${size * 0.7}px;
          font-weight: bold;
          border: 2px solid white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        ">⚡</div>`,
        iconSize: [size, size],
        iconAnchor: [size/2, size/2]
      });
      
      const marker = L.marker([lat, lon], { 
        icon, 
        opacity,
        zIndexOffset: 10000 // Ensure markers appear on top
      });
      
      // Add to map first
      marker.addTo(map);
      
      // Add pulsing animation for new strikes ONLY
      if (isNew) {
        // Wait for DOM element to be created, then add animation class
        setTimeout(() => {
          try {
            const iconElement = marker.getElement();
            if (iconElement) {
              const iconDiv = iconElement.querySelector('div');
              if (iconDiv) {
                iconDiv.classList.add('lightning-strike-new');
                
                // Remove animation class after it completes (0.8s)
                setTimeout(() => {
                  try {
                    iconDiv.classList.remove('lightning-strike-new');
                  } catch (e) {}
                }, 800);
              }
            }
          } catch (e) {
            console.warn('Could not animate lightning marker:', e);
          }
        }, 10);
        
        // Create pulsing ring effect
        const pulseRing = L.circle([lat, lon], {
          radius: 30000, // 30km radius in meters
          fillColor: color,
          fillOpacity: 0,
          color: color,
          weight: 2,
          opacity: 0.9,
          className: 'lightning-pulse-ring'
        });
        
        pulseRing.addTo(map);
        
        // Remove pulse ring after animation completes
        setTimeout(() => {
          try {
            map.removeLayer(pulseRing);
          } catch (e) {}
        }, 2000);
      }
      
      // Format time
      const strikeTime = new Date(timestamp);
      const timeStr = strikeTime.toLocaleString();
      const ageStr = ageMinutes < 1 
        ? `${Math.floor(age)} sec ago` 
        : `${Math.floor(ageMinutes)} min ago`;
      
      // Add popup with details
      marker.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace; min-width: 200px;">
          <div style="font-size: 16px; font-weight: bold; color: ${color}; margin-bottom: 8px;">
            ${isNew ? '🆕 ' : ''}⚡ Lightning Strike
          </div>
          <table style="font-size: 12px; width: 100%;">
            <tr><td><b>Region:</b></td><td>${region || 'Unknown'}</td></tr>
            <tr><td><b>Time:</b></td><td>${timeStr}</td></tr>
            <tr><td><b>Age:</b></td><td>${ageStr}</td></tr>
            <tr><td><b>Intensity:</b></td><td>${intensity.toFixed(1)} kA</td></tr>
            <tr><td><b>Polarity:</b></td><td>${polarity}</td></tr>
            <tr><td><b>Coordinates:</b></td><td>${lat.toFixed(3)}°, ${lon.toFixed(3)}°</td></tr>
          </table>
        </div>
      `);
      
      // Already added to map above (before animation)
      newMarkers.push(marker);
    });

    // Update previous strike IDs for next comparison
    previousStrikeIds.current = currentStrikeIds;
    
    // After first load, allow animations for new strikes
    if (isFirstLoad.current) {
      isFirstLoad.current = false;
    }
    
    setStrikeMarkers(newMarkers);

    return () => {
      newMarkers.forEach(marker => {
        try {
          map.removeLayer(marker);
        } catch (e) {
          // Already removed
        }
      });
    };
  }, [enabled, lightningData, map, opacity]);

  // Add statistics control
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    // Remove existing control
    if (statsControl) {
      try {
        map.removeControl(statsControl);
      } catch (e) {}
      setStatsControl(null);
    }

    if (!enabled || lightningData.length === 0) return;

    // Create stats control
    const StatsControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'lightning-stats');
        
        // Calculate statistics
        const fresh = lightningData.filter(s => s.age < 60).length; // <1 min
        const recent = lightningData.filter(s => s.age < 300).length; // <5 min
        const total = lightningData.length;
        const avgIntensity = lightningData.reduce((sum, s) => sum + s.intensity, 0) / total;
        const positiveStrikes = lightningData.filter(s => s.polarity === 'positive').length;
        const negativeStrikes = total - positiveStrikes;
        
        console.log('[Lightning] Stats panel updated:', { fresh, recent, total });
        
        div.innerHTML = `
          <div style="background: rgba(0, 0, 0, 0.8); color: white; padding: 10px; border-radius: 8px; font-family: 'JetBrains Mono', monospace; font-size: 11px; min-width: 180px;">
            <div style="font-weight: bold; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; cursor: pointer;" class="lightning-stats-header">
              <span>⚡ Lightning Activity</span>
              <span class="lightning-stats-toggle" style="font-size: 12px; cursor: pointer; user-select: none;">▼</span>
            </div>
            <div class="lightning-stats-content">
              <table style="width: 100%; font-size: 11px;">
                <tr><td>Fresh (&lt;1 min):</td><td style="text-align: right; color: #FFD700;">${fresh}</td></tr>
                <tr><td>Recent (&lt;5 min):</td><td style="text-align: right; color: #FFA500;">${recent}</td></tr>
                <tr><td>Total (30 min):</td><td style="text-align: right; color: #FF6B6B;">${total}</td></tr>
                <tr><td colspan="2" style="padding-top: 8px; border-top: 1px solid #444;"></td></tr>
                <tr><td>Avg Intensity:</td><td style="text-align: right;">${avgIntensity.toFixed(1)} kA</td></tr>
                <tr><td>Positive:</td><td style="text-align: right; color: #FFD700;">+${positiveStrikes}</td></tr>
                <tr><td>Negative:</td><td style="text-align: right; color: #87CEEB;">-${negativeStrikes}</td></tr>
              </table>
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #444; font-size: 9px; color: #aaa; text-align: center;">
                Updates every 30s
              </div>
            </div>
          </div>
        `;

        // Add minimize/maximize functionality
        const header = div.querySelector('.lightning-stats-header');
        const content = div.querySelector('.lightning-stats-content');
        const toggle = div.querySelector('.lightning-stats-toggle');
        
        const minimized = localStorage.getItem('lightning-stats-minimized') === 'true';
        if (minimized) {
          content.style.display = 'none';
          toggle.textContent = '▶';
        }
        
        header.addEventListener('click', () => {
          const isMinimized = content.style.display === 'none';
          content.style.display = isMinimized ? 'block' : 'none';
          toggle.textContent = isMinimized ? '▼' : '▶';
          localStorage.setItem('lightning-stats-minimized', !isMinimized);
        });

        // Prevent map interaction on control
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        return div;
      }
    });

    const control = new StatsControl();
    control.addTo(map);
    setStatsControl(control);

    return () => {
      if (control && map) {
        try {
          map.removeControl(control);
        } catch (e) {}
      }
    };
  }, [enabled, lightningData, map]);

  // Cleanup on disable
  useEffect(() => {
    if (!enabled && map) {
      // Remove stats control
      if (statsControl) {
        try {
          map.removeControl(statsControl);
        } catch (e) {}
        setStatsControl(null);
      }
      
      // Clear all markers
      strikeMarkers.forEach(marker => {
        try {
          map.removeLayer(marker);
        } catch (e) {}
      });
      setStrikeMarkers([]);
      
      // Clear data
      setLightningData([]);
      previousStrikeIds.current.clear();
    }
  }, [enabled, map]);

  return {
    markers: strikeMarkers,
    strikeCount: lightningData.length,
    freshCount: lightningData.filter(s => s.age < 60).length
  };
}
