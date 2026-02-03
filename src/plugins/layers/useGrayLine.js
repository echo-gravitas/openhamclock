import { useState, useEffect, useRef } from 'react';

/**
 * Gray Line Propagation Overlay Plugin v1.0.1
 * 
 * Features:
 * - Real-time solar terminator (day/night boundary)
 * - Twilight zones (civil, nautical, astronomical)
 * - Animated update every minute
 * - Enhanced propagation zone highlighting
 * - Color-coded by propagation potential
 * - Minimizable control panel
 * - Corrected sine wave calculation (v1.0.1)
 * 
 * Use Case: Identify optimal times for long-distance DX contacts
 * The gray line provides enhanced HF propagation for several hours
 */

export const metadata = {
  id: 'grayline',
  name: 'Gray Line Propagation',
  description: 'Solar terminator with twilight zones for enhanced DX propagation',
  icon: '🌅',
  category: 'propagation',
  defaultEnabled: false,
  defaultOpacity: 0.5,
  version: '1.0.2'
};

// Solar calculations based on astronomical algorithms
function calculateSolarPosition(date) {
  const JD = dateToJulianDate(date);
  const T = (JD - 2451545.0) / 36525.0; // Julian centuries since J2000.0
  
  // Mean longitude of the sun
  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  
  // Mean anomaly
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360;
  const MRad = M * Math.PI / 180;
  
  // Equation of center
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(MRad)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * MRad)
          + 0.000289 * Math.sin(3 * MRad);
  
  // True longitude
  const trueLon = L0 + C;
  
  // Apparent longitude
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(omega * Math.PI / 180);
  
  // Obliquity of ecliptic
  const epsilon = 23.439291 - 0.0130042 * T;
  const epsilonRad = epsilon * Math.PI / 180;
  const lambdaRad = lambda * Math.PI / 180;
  
  // Solar declination
  const declination = Math.asin(Math.sin(epsilonRad) * Math.sin(lambdaRad)) * 180 / Math.PI;
  
  // Solar right ascension
  const RA = Math.atan2(Math.cos(epsilonRad) * Math.sin(lambdaRad), Math.cos(lambdaRad)) * 180 / Math.PI;
  
  return { declination, rightAscension: RA };
}

function dateToJulianDate(date) {
  return (date.getTime() / 86400000) + 2440587.5;
}

// Calculate solar hour angle for a given longitude at a specific time
function calculateHourAngle(date, longitude) {
  const JD = dateToJulianDate(date);
  const T = (JD - 2451545.0) / 36525.0;
  
  // Greenwich Mean Sidereal Time
  const GMST = (280.46061837 + 360.98564736629 * (JD - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000) % 360;
  
  const { rightAscension } = calculateSolarPosition(date);
  
  // Local hour angle
  const hourAngle = (GMST + longitude - rightAscension + 360) % 360;
  
  return hourAngle;
}

// Calculate solar altitude for a given position and time
function calculateSolarAltitude(date, latitude, longitude) {
  const { declination } = calculateSolarPosition(date);
  const hourAngle = calculateHourAngle(date, longitude);
  
  const latRad = latitude * Math.PI / 180;
  const decRad = declination * Math.PI / 180;
  const haRad = hourAngle * Math.PI / 180;
  
  const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const altitude = Math.asin(sinAlt) * 180 / Math.PI;
  
  return altitude;
}

// Generate terminator line for a specific solar altitude
function generateTerminatorLine(date, solarAltitude = 0, numPoints = 360) {
  const points = [];
  const { declination } = calculateSolarPosition(date);
  const decRad = declination * Math.PI / 180;
  const altRad = solarAltitude * Math.PI / 180;
  
  // For each longitude, calculate the latitude where the sun is at the specified altitude
  for (let i = 0; i <= numPoints; i++) {
    const lon = (i / numPoints) * 360 - 180;
    const hourAngle = calculateHourAngle(date, lon);
    const haRad = hourAngle * Math.PI / 180;
    
    // Use the solar altitude equation to solve for latitude
    // sin(altitude) = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(HA)
    // Rearranging: sin(altitude) - sin(lat) * sin(dec) = cos(lat) * cos(dec) * cos(HA)
    
    // For terminator (altitude = 0), the equation simplifies
    // We need to solve: tan(lat) = -tan(dec) / cos(HA)
    
    const cosHA = Math.cos(haRad);
    const sinDec = Math.sin(decRad);
    const cosDec = Math.cos(decRad);
    const sinAlt = Math.sin(altRad);
    
    // Solve using the quadratic formula or direct calculation
    // sin(lat) = (sin(alt) - cos(lat) * cos(dec) * cos(HA)) / sin(dec)
    
    // Better approach: use atan2 for proper terminator calculation
    // The terminator latitude for a given longitude is:
    // lat = atan(-cos(HA) / tan(dec)) when dec != 0
    
    let lat;
    
    if (Math.abs(declination) < 0.01) {
      // Near equinox: terminator is nearly straight along equator
      lat = 0;
    } else {
      // Standard case: calculate terminator latitude
      // Formula: cos(lat) * cos(dec) * cos(HA) = -sin(lat) * sin(dec) (for altitude = 0)
      // This gives: tan(lat) = -cos(HA) / tan(dec)
      
      const tanDec = Math.tan(decRad);
      if (Math.abs(tanDec) < 0.0001) {
        lat = 0;
      } else {
        lat = Math.atan(-cosHA / tanDec) * 180 / Math.PI;
      }
      
      // For twilight (altitude < 0), we need to adjust
      if (solarAltitude !== 0) {
        // Use iterative solution for twilight calculations
        // cos(lat) * cos(dec) * cos(HA) + sin(lat) * sin(dec) = sin(alt)
        
        // Newton-Raphson iteration to solve for latitude
        let testLat = lat * Math.PI / 180;
        for (let iter = 0; iter < 5; iter++) {
          const f = Math.sin(testLat) * sinDec + Math.cos(testLat) * cosDec * cosHA - sinAlt;
          const fPrime = Math.cos(testLat) * sinDec - Math.sin(testLat) * cosDec * cosHA;
          if (Math.abs(fPrime) > 0.0001) {
            testLat = testLat - f / fPrime;
          }
        }
        lat = testLat * 180 / Math.PI;
      }
    }
    
    // Clamp latitude to valid range
    lat = Math.max(-90, Math.min(90, lat));
    
    if (isFinite(lat) && isFinite(lon)) {
      points.push([lat, lon]);
    }
  }
  
  return points;
}

// Make control panel draggable and minimizable
function makeDraggable(element, storageKey) {
  if (!element) return;
  
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const { top, left } = JSON.parse(saved);
      element.style.position = 'fixed';
      element.style.top = top + 'px';
      element.style.left = left + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    } catch (e) {}
  } else {
    const rect = element.getBoundingClientRect();
    element.style.position = 'fixed';
    element.style.top = rect.top + 'px';
    element.style.left = rect.left + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }
  
  element.title = 'Hold CTRL and drag to reposition';
  
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  
  const updateCursor = (e) => {
    if (e.ctrlKey) {
      element.style.cursor = 'grab';
    } else {
      element.style.cursor = 'default';
    }
  };
  
  element.addEventListener('mouseenter', updateCursor);
  element.addEventListener('mousemove', updateCursor);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') updateCursor(e);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') updateCursor(e);
  });
  
  element.addEventListener('mousedown', function(e) {
    if (!e.ctrlKey) return;
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') {
      return;
    }
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = element.offsetLeft;
    startTop = element.offsetTop;
    
    element.style.cursor = 'grabbing';
    element.style.opacity = '0.8';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    element.style.left = (startLeft + dx) + 'px';
    element.style.top = (startTop + dy) + 'px';
  });
  
  document.addEventListener('mouseup', function(e) {
    if (isDragging) {
      isDragging = false;
      element.style.opacity = '1';
      updateCursor(e);
      
      localStorage.setItem(storageKey, JSON.stringify({
        top: element.offsetTop,
        left: element.offsetLeft
      }));
    }
  });
}

function addMinimizeToggle(element, storageKey) {
  if (!element) return;
  
  const minimizeKey = storageKey + '-minimized';
  const header = element.querySelector('div:first-child');
  if (!header) return;
  
  const content = Array.from(element.children).slice(1);
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'grayline-panel-content';
  content.forEach(child => contentWrapper.appendChild(child));
  element.appendChild(contentWrapper);
  
  const minimizeBtn = document.createElement('span');
  minimizeBtn.className = 'grayline-minimize-btn';
  minimizeBtn.innerHTML = '▼';
  minimizeBtn.style.cssText = `
    float: right;
    cursor: pointer;
    user-select: none;
    padding: 0 4px;
    margin: -2px -4px 0 0;
    font-size: 10px;
    opacity: 0.7;
    transition: opacity 0.2s;
  `;
  minimizeBtn.title = 'Minimize/Maximize';
  
  minimizeBtn.addEventListener('mouseenter', () => {
    minimizeBtn.style.opacity = '1';
  });
  minimizeBtn.addEventListener('mouseleave', () => {
    minimizeBtn.style.opacity = '0.7';
  });
  
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.appendChild(minimizeBtn);
  
  const isMinimized = localStorage.getItem(minimizeKey) === 'true';
  if (isMinimized) {
    contentWrapper.style.display = 'none';
    minimizeBtn.innerHTML = '▶';
    element.style.cursor = 'pointer';
  }
  
  const toggle = (e) => {
    if (e && e.ctrlKey) return;
    
    const isCurrentlyMinimized = contentWrapper.style.display === 'none';
    
    if (isCurrentlyMinimized) {
      contentWrapper.style.display = 'block';
      minimizeBtn.innerHTML = '▼';
      element.style.cursor = 'default';
      localStorage.setItem(minimizeKey, 'false');
    } else {
      contentWrapper.style.display = 'none';
      minimizeBtn.innerHTML = '▶';
      element.style.cursor = 'pointer';
      localStorage.setItem(minimizeKey, 'true');
    }
  };
  
  header.addEventListener('click', (e) => {
    if (e.target === header || e.target.tagName === 'DIV') {
      toggle(e);
    }
  });
  
  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(e);
  });
}

export function useLayer({ enabled = false, opacity = 0.5, map = null }) {
  const [layers, setLayers] = useState([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showTwilight, setShowTwilight] = useState(true);
  const [showEnhancedZone, setShowEnhancedZone] = useState(true);
  const [twilightOpacity, setTwilightOpacity] = useState(0.5);
  
  const controlRef = useRef(null);
  const updateIntervalRef = useRef(null);

  // Update time every minute
  useEffect(() => {
    if (!enabled) return;
    
    const updateTime = () => {
      setCurrentTime(new Date());
    };
    
    updateTime(); // Initial update
    updateIntervalRef.current = setInterval(updateTime, 60000); // Every minute
    
    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
      }
    };
  }, [enabled]);

  // Create control panel
  useEffect(() => {
    if (!enabled || !map || controlRef.current) return;

    const GrayLineControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function() {
        const container = L.DomUtil.create('div', 'grayline-control');
        container.style.cssText = `
          background: rgba(0, 0, 0, 0.9);
          padding: 12px;
          border-radius: 5px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          min-width: 200px;
        `;
        
        const now = new Date();
        const timeStr = now.toUTCString();
        
        container.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 8px; font-size: 12px;">🌅 Gray Line</div>
          
          <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 3px;">
            <div style="font-size: 9px; opacity: 0.7; margin-bottom: 2px;">UTC TIME</div>
            <div id="grayline-time" style="font-size: 10px; font-weight: bold;">${timeStr}</div>
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="grayline-twilight" checked style="margin-right: 5px;" />
              <span>Show Twilight Zones</span>
            </label>
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="grayline-enhanced" checked style="margin-right: 5px;" />
              <span>Enhanced DX Zone</span>
            </label>
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px;">Twilight Opacity: <span id="twilight-opacity-value">50</span>%</label>
            <input type="range" id="grayline-twilight-opacity" min="20" max="100" value="50" step="5" style="width: 100%;" />
          </div>
          
          <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #555; font-size: 9px; opacity: 0.7;">
            <div>🌅 Gray line = enhanced HF propagation</div>
            <div style="margin-top: 4px;">Updates every minute</div>
          </div>
        `;
        
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        
        return container;
      }
    });
    
    const control = new GrayLineControl();
    map.addControl(control);
    controlRef.current = control;
    
    setTimeout(() => {
      const container = document.querySelector('.grayline-control');
      if (container) {
        makeDraggable(container, 'grayline-position');
        addMinimizeToggle(container, 'grayline-position');
      }
      
      // Add event listeners
      const twilightCheck = document.getElementById('grayline-twilight');
      const enhancedCheck = document.getElementById('grayline-enhanced');
      const twilightOpacitySlider = document.getElementById('grayline-twilight-opacity');
      const twilightOpacityValue = document.getElementById('twilight-opacity-value');
      
      if (twilightCheck) {
        twilightCheck.addEventListener('change', (e) => setShowTwilight(e.target.checked));
      }
      if (enhancedCheck) {
        enhancedCheck.addEventListener('change', (e) => setShowEnhancedZone(e.target.checked));
      }
      if (twilightOpacitySlider) {
        twilightOpacitySlider.addEventListener('input', (e) => {
          const value = parseInt(e.target.value) / 100;
          setTwilightOpacity(value);
          if (twilightOpacityValue) twilightOpacityValue.textContent = e.target.value;
        });
      }
    }, 150);
    
  }, [enabled, map]);

  // Update time display
  useEffect(() => {
    const timeElement = document.getElementById('grayline-time');
    if (timeElement && enabled) {
      timeElement.textContent = currentTime.toUTCString();
    }
  }, [currentTime, enabled]);

  // Render gray line and twilight zones
  useEffect(() => {
    if (!map || !enabled) return;

    // Clear old layers
    layers.forEach(layer => {
      try {
        map.removeLayer(layer);
      } catch (e) {}
    });
    
    const newLayers = [];
    
    // Main terminator (solar altitude = 0°)
    const terminator = generateTerminatorLine(currentTime, 0, 360);
    const terminatorLine = L.polyline(terminator, {
      color: '#ff6600',
      weight: 3,
      opacity: opacity * 0.8,
      dashArray: '10, 5'
    });
    terminatorLine.bindPopup(`
      <div style="font-family: 'JetBrains Mono', monospace;">
        <b>🌅 Solar Terminator</b><br>
        Sun altitude: 0°<br>
        Enhanced HF propagation zone<br>
        UTC: ${currentTime.toUTCString()}
      </div>
    `);
    terminatorLine.addTo(map);
    newLayers.push(terminatorLine);
    
    // Enhanced DX zone (±5° from terminator)
    if (showEnhancedZone) {
      const enhancedUpper = generateTerminatorLine(currentTime, 5, 360);
      const enhancedLower = generateTerminatorLine(currentTime, -5, 360);
      
      // Create polygon for enhanced zone
      const enhancedZone = [...enhancedUpper, ...enhancedLower.reverse()];
      const enhancedPoly = L.polygon(enhancedZone, {
        color: '#ffaa00',
        fillColor: '#ffaa00',
        fillOpacity: opacity * 0.15,
        weight: 1,
        opacity: opacity * 0.3
      });
      enhancedPoly.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace;">
          <b>⭐ Enhanced DX Zone</b><br>
          Best HF propagation window<br>
          ±5° from terminator<br>
          Ideal for long-distance contacts
        </div>
      `);
      enhancedPoly.addTo(map);
      newLayers.push(enhancedPoly);
    }
    
    // Twilight zones
    if (showTwilight) {
      // Civil twilight (sun altitude -6°)
      const civilTwilight = generateTerminatorLine(currentTime, -6, 360);
      const civilLine = L.polyline(civilTwilight, {
        color: '#4488ff',
        weight: 2,
        opacity: twilightOpacity * 0.6,
        dashArray: '5, 5'
      });
      civilLine.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace;">
          <b>🌆 Civil Twilight</b><br>
          Sun altitude: -6°<br>
          Good propagation conditions
        </div>
      `);
      civilLine.addTo(map);
      newLayers.push(civilLine);
      
      // Nautical twilight (sun altitude -12°)
      const nauticalTwilight = generateTerminatorLine(currentTime, -12, 360);
      const nauticalLine = L.polyline(nauticalTwilight, {
        color: '#6666ff',
        weight: 1.5,
        opacity: twilightOpacity * 0.4,
        dashArray: '3, 3'
      });
      nauticalLine.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace;">
          <b>🌃 Nautical Twilight</b><br>
          Sun altitude: -12°<br>
          Moderate propagation
        </div>
      `);
      nauticalLine.addTo(map);
      newLayers.push(nauticalLine);
      
      // Astronomical twilight (sun altitude -18°)
      const astroTwilight = generateTerminatorLine(currentTime, -18, 360);
      const astroLine = L.polyline(astroTwilight, {
        color: '#8888ff',
        weight: 1,
        opacity: twilightOpacity * 0.3,
        dashArray: '2, 2'
      });
      astroLine.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace;">
          <b>🌌 Astronomical Twilight</b><br>
          Sun altitude: -18°<br>
          Transition to night propagation
        </div>
      `);
      astroLine.addTo(map);
      newLayers.push(astroLine);
    }
    
    setLayers(newLayers);
    
    console.log(`[Gray Line] Rendered terminator and ${showTwilight ? '3 twilight zones' : 'no twilight'} at ${currentTime.toUTCString()}`);
    
    return () => {
      newLayers.forEach(layer => {
        try {
          map.removeLayer(layer);
        } catch (e) {}
      });
    };
  }, [map, enabled, currentTime, opacity, showTwilight, showEnhancedZone, twilightOpacity]);

  // Cleanup on disable
  useEffect(() => {
    if (!enabled && map && controlRef.current) {
      try {
        map.removeControl(controlRef.current);
        console.log('[Gray Line] Removed control');
      } catch (e) {
        console.error('[Gray Line] Error removing control:', e);
      }
      controlRef.current = null;
      
      layers.forEach(layer => {
        try {
          map.removeLayer(layer);
        } catch (e) {}
      });
      setLayers([]);
    }
  }, [enabled, map, layers]);

  return {
    layers,
    currentTime,
    showTwilight,
    showEnhancedZone
  };
}
