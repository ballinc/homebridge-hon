import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { HonWineCoolerAccessory } from './platformAccessory.js';
import { HonApiClient } from './honApiClient.js';
import { PythonBridgeManager } from './pythonBridge.js';
import {
  MIN_POLL_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type HonWineCoolerConfig,
  type WineCoolerState,
} from './settings.js';

function normaliseConfig(
  config: PlatformConfig,
): Required<Pick<HonWineCoolerConfig, 'name' | 'accessoryName' | 'pollIntervalSeconds' | 'autoStartBridge' | 'pythonPath' | 'bridgeHost' | 'bridgePort'>> & HonWineCoolerConfig {
  const rawPollInterval = Number(config.pollIntervalSeconds ?? MIN_POLL_INTERVAL_SECONDS);

  return {
    ...config,
    name: String(config.name ?? 'hOn Wine Cooler'),
    email: typeof config.email === 'string' ? config.email : undefined,
    password: typeof config.password === 'string' ? config.password : undefined,
    accessoryName: String(config.accessoryName ?? 'Wine Cooler'),
    pollIntervalSeconds: Math.max(
      MIN_POLL_INTERVAL_SECONDS,
      Number.isFinite(rawPollInterval) ? rawPollInterval : MIN_POLL_INTERVAL_SECONDS,
    ),
    autoStartBridge: config.autoStartBridge !== false,
    pythonPath: String(config.pythonPath ?? 'python3.12'),
    bridgeHost: String(config.bridgeHost ?? '127.0.0.1'),
    bridgePort: Number(config.bridgePort ?? 8765),
    dataDir: typeof config.dataDir === 'string' ? config.dataDir : undefined,
  };
}

export class HonWineCoolerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories = new Map<string, PlatformAccessory>();
  public readonly discoveredCacheUUIDs: string[] = [];
  public readonly client: HonApiClient;
  public readonly pollIntervalSeconds: number;

  private readonly normalisedConfig: ReturnType<typeof normaliseConfig>;
  private readonly baseUrl: string;
  private readonly bridgeManager?: PythonBridgeManager;
  private pollTimer?: NodeJS.Timeout;

  public constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.normalisedConfig = normaliseConfig(config);
    this.pollIntervalSeconds = this.normalisedConfig.pollIntervalSeconds;
    this.baseUrl = `http://${this.normalisedConfig.bridgeHost}:${this.normalisedConfig.bridgePort}`;

    this.client = new HonApiClient(
      this.log,
      this.baseUrl,
      this.pollIntervalSeconds * 1000,
    );

    if (this.normalisedConfig.autoStartBridge) {
      this.bridgeManager = new PythonBridgeManager(this.log, this.api, this.normalisedConfig);
    }

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    try {
      if (this.bridgeManager) {
        this.bridgeManager.start();
        await this.bridgeManager.waitUntilReady(this.baseUrl);
      }

      const appliances = await this.client.getAppliances();

      if (appliances.length === 0) {
        this.log.warn('No hOn wine cooler appliances returned by bridge.');
        return;
      }

      for (const appliance of appliances) {
        this.registerOrRestoreAccessory(appliance);
      }

      this.removeMissingAccessories();
      this.startPolling();
    } catch (error) {
      this.log.error('Failed to discover hOn wine cooler:', error instanceof Error ? error.message : String(error));
    }
  }

  private registerOrRestoreAccessory(appliance: WineCoolerState): void {
    const uuid = this.api.hap.uuid.generate(appliance.id);
    const existingAccessory = this.accessories.get(uuid);
    const displayName = this.normalisedConfig.accessoryName || appliance.name;

    if (existingAccessory) {
      this.log.info('Restoring accessory:', existingAccessory.displayName);
      existingAccessory.context.device = appliance;
      existingAccessory.displayName = displayName;
      this.api.updatePlatformAccessories([existingAccessory]);
      new HonWineCoolerAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding wine cooler accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = appliance;
      new HonWineCoolerAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    this.discoveredCacheUUIDs.push(uuid);
  }

  private removeMissingAccessories(): void {
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }

    const intervalMs = this.pollIntervalSeconds * 1000;
    this.log.info(`Starting status refresh loop at ${this.pollIntervalSeconds}s interval`);

    this.pollTimer = setInterval(() => {
      void this.refreshAccessories();
    }, intervalMs);
  }

  public async refreshAccessories(): Promise<void> {
    try {
      const state = await this.client.getState(true);
      const uuid = this.api.hap.uuid.generate(state.id);
      const accessory = this.accessories.get(uuid);

      if (!accessory) {
        return;
      }

      accessory.context.device = state;
      this.api.updatePlatformAccessories([accessory]);
      HonWineCoolerAccessory.updateCharacteristicValues(this, accessory, state);
    } catch (error) {
      this.log.warn('Failed to refresh hOn wine cooler state:', error instanceof Error ? error.message : String(error));
    }
  }
}