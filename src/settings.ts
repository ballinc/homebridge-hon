/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'HomebridgeHON';

/**
 * This must match the name of your plugin as defined the package.json `name` property
 */
export const PLUGIN_NAME = 'homebridge-hon';

export const MIN_POLL_INTERVAL_SECONDS = 60;

export interface HonWineCoolerConfig {
  name?: string;
  email?: string;
  password?: string;
  accessoryName?: string;
  pollIntervalSeconds?: number;
  autoStartBridge?: boolean;
  pythonPath?: string;
  bridgeHost?: string;
  bridgePort?: number;
  dataDir?: string;
}

export interface ZoneState {
  currentTemperature: number | null;
  targetTemperature: number | null;
  humidity: number | null;
  minTemperature?: number | null;
  maxTemperature?: number | null;
  temperatureStep?: number | null;
}

export interface WineCoolerState {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  macAddress: string;
  online: boolean;
  lightOn: boolean | null;
  sabbathMode: boolean | null;
  programName: string | null;
  zone1: ZoneState;
  zone2: ZoneState;
  lastUpdated: number;
  source: string;
}

export interface AppliancesResponse {
  appliances: WineCoolerState[];
}
