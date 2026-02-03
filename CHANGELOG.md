# Changelog

All notable changes to OpenHamClock will be documented in this file.

## [3.12.0] - 2025-02-03

### Fixed
- **PSKReporter MQTT** - Fixed critical bug: field mapping used `sa`/`ra` (ADIF country codes) instead of `sc`/`rc` (callsigns), so no MQTT spots ever matched
- **PSKReporter RX topic** - Fixed subscription pattern that had one extra wildcard, subscribing to sender locator position instead of receiver callsign
- **PSKReporter HTTP fallback** - If MQTT fails to connect within 12 seconds, automatically falls back to HTTP API so users always get data
- **Map layer persistence** - Map style/zoom save was overwriting plugin layer settings (aurora, earthquakes, weather radar). Now merges correctly
- **Version consistency** - All version numbers now read from package.json as single source of truth. Previously health endpoint said 3.3.0, config said 3.10.0, UI said 3.7.0
- **PSKReporter 403 spam** - Server now backs off for 30 minutes on 403/429 responses instead of retrying every request

### Added
- **State persistence** - All user preferences now survive page refresh: PSK/WSJT-X panel mode, TX/RX tab, solar image wavelength, weather panel expanded state, temperature unit
- **Collapsible weather** - DE location weather section collapses to one-line summary, expands for full details
- **Lunar phase display** - 4th cycling mode in Solar panel shows current moon phase with SVG rendering, illumination %, and next full/new moon dates
- **F°/C° toggle** - Switch temperature units with localStorage persistence; header always shows both

## [3.11.0] - 2025-02-02

### Added
- **PSKReporter Integration** - See where your digital mode signals are being received
  - New PSKReporter panel shows stations hearing you and stations you're hearing
  - Supports FT8, FT4, JS8, and other digital modes
  - Configurable time window (5, 15, 30 min, 1 hour)
  - Shows band, mode, SNR, and age of each report
  - Click on a report to center map on that location

### Changed
- **Bandwidth Optimization** - Reduced network egress by ~85%
  - Added GZIP compression (70-90% smaller responses)
  - Server-side caching for all external API calls
  - Reduced client polling intervals (DX Cluster: 5s→30s, POTA: 60s→120s)
  - Added HTTP Cache-Control headers
  - POTA now uses server proxy instead of direct API calls

### Fixed
- Empty ITURHFPROP_URL causing "Only absolute URLs supported" error
- Satellite TLE fetch timeout errors now handled silently
- Reduced console log spam for network errors

## [3.10.0] - 2025-02-02

### Added
- **Environment-based configuration** - Station settings now stored in `.env` file
  - `.env` is auto-created from `.env.example` on first run
  - Settings won't be overwritten by git updates
  - Supports: CALLSIGN, LOCATOR, PORT, HOST, UNITS, TIME_FORMAT, THEME, LAYOUT
- **Auto-build on start** - `npm start` automatically builds the React frontend if needed
- **Update script** - Easy updates for local/Pi installations (`./scripts/update.sh`)
  - Backs up config, pulls latest, rebuilds, preserves settings
- **Network access configuration** - Set `HOST=0.0.0.0` to access from other devices
- **Grid locator auto-conversion** - Automatically calculates lat/lon from LOCATOR
- **Setup wizard** - Settings panel auto-opens if CALLSIGN or LOCATOR is missing
- **Retro theme** - 90s Windows style with teal background and silver panels
- **Classic layout** - Original HamClock-style with black background, large colored numbers, rainbow frequency bar

### Changed
- Configuration priority: localStorage > .env > defaults
- Server startup now shows station callsign and network access info
- Settings panel updated with .env setup instructions
- DX Spider connection uses dxspider.co.uk as primary (thanks Keith G6NHU)
- SSID -56 for OpenHamClock connections (HamClock uses -55)

### Fixed
- Header clock "shaking" when digits change - now uses monospace font
- Header layout wrapping on smaller screens - added `whiteSpace: nowrap`
- Reduced log spam with rate-limited error logging (1 per minute per type)
- DX Spider connection errors silenced for common issues (ECONNRESET, ETIMEDOUT)

## [3.9.0] - 2025-01-31

### Added
- DX Filter modal with tabs for Zones, Bands, Modes, Watchlist, Exclude
- Spot retention time configurable (5-30 minutes) in Settings
- Satellite tracking with 40+ amateur radio satellites
- Satellite footprints and orbit path visualization
- Map legend showing all 10 HF bands plus DE/DX/Sun/Moon markers

### Changed
- Enlarged Header, DE, and DX panels with bigger fonts
- Improved callsign label positioning on map

### Fixed
- DX Filter modal crash when opening
- K-Index display showing correct values
- Contest calendar attribution

## [3.8.0] - 2025-01-28

### Added
- Multiple DX cluster source fallbacks
- ITURHFProp hybrid propagation predictions
- Ionosonde real-time corrections

### Changed
- DX cluster cache extended to 90 seconds
- Improved error handling for external APIs

## [3.7.0] - 2025-01-25

### Added
- Modular React architecture with Vite
- 13 extracted components
- 12 custom data-fetching hooks
- 3 utility modules
- Railway deployment support
- Docker support

### Changed
- Complete rewrite from monolithic HTML to modular React
- CSS variables for theming
- Separated concerns for easier contribution

## [3.0.0] - 2025-01-15

### Added
- Initial modular extraction from monolithic codebase
- React + Vite build system
- Express backend for API proxying
- Three themes: Dark, Light, Legacy

---

## Version History

- **3.10.x** - Environment configuration, themes, layouts
- **3.9.x** - DX filtering, satellites, map improvements
- **3.8.x** - Propagation predictions, reliability improvements
- **3.7.x** - Modular React architecture
- **3.0.x** - Initial modular version
- **2.x** - Monolithic HTML version (archived)
- **1.x** - Original HamClock fork
