/**
 * PluginLayer Component
 * Renders a single plugin layer using its hook
 */
import React from 'react';

export const PluginLayer = ({ plugin, enabled, opacity, map, callsign }) => {
  // Call the plugin's hook (this is allowed because it's in a component)
  const result = plugin.hook({ enabled, opacity, map, callsign });
  
  // Plugin hook handles its own rendering to the map
  // This component doesn't render anything to the DOM
  return null;
};

export default PluginLayer;
