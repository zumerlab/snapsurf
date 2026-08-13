// Compatibility bridge for the historical @zumer/snapdom-receipt package.
// New integrations should import the canonical sensor-only package instead.
export {
  SENSOR_PLUGIN_NAME,
  SENSOR_REPORT_CONTRACT,
  sensor,
} from '../packages/sensor/src/sensor.js'
