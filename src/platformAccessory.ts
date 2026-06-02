import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { HonWineCoolerPlatform } from './platform.js';
import type { WineCoolerState, ZoneState } from './settings.js';

function numberOrDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOrDefault(value: boolean | null | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export class HonWineCoolerAccessory {
  private readonly informationService: Service;
  private readonly lightService: Service;
  private readonly zone1ThermostatService: Service;
  private readonly zone2ThermostatService: Service;
  private readonly zone1HumidityService: Service;
  private readonly zone2HumidityService: Service;
  private readonly sabbathService: Service;

  public constructor(
    private readonly platform: HonWineCoolerPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const state = this.accessory.context.device as WineCoolerState;

    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;

    this.lightService = this.accessory.getService(this.platform.Service.Lightbulb)
      ?? this.accessory.addService(this.platform.Service.Lightbulb, 'Wine Cooler Light', 'light');

    this.zone1ThermostatService = this.accessory.getService('Wine Cooler Zone 1')
      ?? this.accessory.addService(this.platform.Service.Thermostat, 'Wine Cooler Zone 1', 'zone1');

    this.zone2ThermostatService = this.accessory.getService('Wine Cooler Zone 2')
      ?? this.accessory.addService(this.platform.Service.Thermostat, 'Wine Cooler Zone 2', 'zone2');

    this.zone1HumidityService = this.accessory.getService('Wine Cooler Zone 1 Humidity')
      ?? this.accessory.addService(this.platform.Service.HumiditySensor, 'Wine Cooler Zone 1 Humidity', 'zone1Humidity');

    this.zone2HumidityService = this.accessory.getService('Wine Cooler Zone 2 Humidity')
      ?? this.accessory.addService(this.platform.Service.HumiditySensor, 'Wine Cooler Zone 2 Humidity', 'zone2Humidity');

    this.sabbathService = this.accessory.getService('Wine Cooler Sabbath Mode')
      ?? this.accessory.addService(this.platform.Service.Switch, 'Wine Cooler Sabbath Mode', 'sabbath');

    this.configureInformation(state);
    this.configureLight();
    this.configureThermostat(this.zone1ThermostatService, 1);
    this.configureThermostat(this.zone2ThermostatService, 2);
    this.configureHumidity(this.zone1HumidityService, 1);
    this.configureHumidity(this.zone2HumidityService, 2);
    this.configureSabbath();

    HonWineCoolerAccessory.updateCharacteristicValues(this.platform, this.accessory, state);
  }

  public static updateCharacteristicValues(
    platform: HonWineCoolerPlatform,
    accessory: PlatformAccessory,
    state: WineCoolerState,
  ): void {
    const information = accessory.getService(platform.Service.AccessoryInformation);
    information?.setCharacteristic(platform.Characteristic.Manufacturer, state.manufacturer || 'Haier')
      .setCharacteristic(platform.Characteristic.Model, state.model || 'Wine Cooler')
      .setCharacteristic(platform.Characteristic.SerialNumber, state.serialNumber || state.macAddress);

    const light = accessory.getService(platform.Service.Lightbulb);
    light?.updateCharacteristic(platform.Characteristic.On, booleanOrDefault(state.lightOn, false));
    light?.updateCharacteristic(platform.Characteristic.StatusActive, state.online);

    const z1 = accessory.getService('Wine Cooler Zone 1');
    const z2 = accessory.getService('Wine Cooler Zone 2');
    HonWineCoolerAccessory.updateThermostat(platform, z1, state.zone1, state.online);
    HonWineCoolerAccessory.updateThermostat(platform, z2, state.zone2, state.online);

    const h1 = accessory.getService('Wine Cooler Zone 1 Humidity');
    const h2 = accessory.getService('Wine Cooler Zone 2 Humidity');

    h1?.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, numberOrDefault(state.zone1.humidity, 0));
    h1?.updateCharacteristic(platform.Characteristic.StatusActive, state.online);

    h2?.updateCharacteristic(platform.Characteristic.CurrentRelativeHumidity, numberOrDefault(state.zone2.humidity, 0));
    h2?.updateCharacteristic(platform.Characteristic.StatusActive, state.online);

    const sabbath = accessory.getService('Wine Cooler Sabbath Mode');
    sabbath?.updateCharacteristic(platform.Characteristic.On, booleanOrDefault(state.sabbathMode, false));
    sabbath?.updateCharacteristic(platform.Characteristic.StatusActive, state.online);
  }

  private static updateThermostat(
    platform: HonWineCoolerPlatform,
    service: Service | undefined,
    zone: ZoneState,
    online: boolean,
  ): void {
    if (!service) {
      return;
    }

    service.updateCharacteristic(
      platform.Characteristic.CurrentHeatingCoolingState,
      platform.Characteristic.CurrentHeatingCoolingState.COOL,
    );

    service.updateCharacteristic(
      platform.Characteristic.TargetHeatingCoolingState,
      platform.Characteristic.TargetHeatingCoolingState.COOL,
    );

    service.updateCharacteristic(
      platform.Characteristic.CurrentTemperature,
      numberOrDefault(zone.currentTemperature, 0),
    );

    service.updateCharacteristic(
      platform.Characteristic.TargetTemperature,
      numberOrDefault(zone.targetTemperature, 8),
    );

    service.updateCharacteristic(
      platform.Characteristic.TemperatureDisplayUnits,
      platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    service.updateCharacteristic(platform.Characteristic.StatusActive, online);
  }

  private configureInformation(state: WineCoolerState): void {
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, state.manufacturer || 'Haier')
      .setCharacteristic(this.platform.Characteristic.Model, state.model || 'Wine Cooler')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, state.serialNumber || state.macAddress)
      .setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
  }

  private configureLight(): void {
    this.lightService.setCharacteristic(this.platform.Characteristic.Name, 'Wine Cooler Light');

    this.lightService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(async () => {
        const state = await this.platform.client.getState();
        return booleanOrDefault(state.lightOn, false);
      })
      .onSet(async (value: CharacteristicValue) => {
        const state = await this.platform.client.setLight(Boolean(value));
        this.accessory.context.device = state;
        HonWineCoolerAccessory.updateCharacteristicValues(this.platform, this.accessory, state);
      });
  }

  private configureThermostat(service: Service, zone: 1 | 2): void {
    const zoneName = zone === 1 ? 'Zone 1' : 'Zone 2';
    const state = this.accessory.context.device as WineCoolerState;
    const zoneState = zone === 1 ? state.zone1 : state.zone2;

    const minValue = numberOrDefault(zoneState.minTemperature, 5);
    const maxValue = numberOrDefault(zoneState.maxTemperature, 20);
    const minStep = numberOrDefault(zoneState.temperatureStep, 1);

    service.setCharacteristic(this.platform.Characteristic.Name, `Wine Cooler ${zoneName}`);

    service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.platform.Characteristic.CurrentHeatingCoolingState.COOL);

    service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [this.platform.Characteristic.TargetHeatingCoolingState.COOL],
      })
      .onGet(() => this.platform.Characteristic.TargetHeatingCoolingState.COOL)
      .onSet(async () => {
        return;
      });

    service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({
        minValue: -10,
        maxValue: 40,
        minStep: 0.1,
      })
      .onGet(async () => {
        const fresh = await this.platform.client.getState();
        const freshZone = zone === 1 ? fresh.zone1 : fresh.zone2;
        return numberOrDefault(freshZone.currentTemperature, 0);
      });

    service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue,
        maxValue,
        minStep,
      })
      .onGet(async () => {
        const fresh = await this.platform.client.getState();
        const freshZone = zone === 1 ? fresh.zone1 : fresh.zone2;
        return numberOrDefault(freshZone.targetTemperature, 8);
      })
      .onSet(async (value: CharacteristicValue) => {
        const stateAfterWrite = await this.platform.client.setTargetTemperature(zone, Number(value));
        this.accessory.context.device = stateAfterWrite;
        HonWineCoolerAccessory.updateCharacteristicValues(this.platform, this.accessory, stateAfterWrite);
      });

    service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  private configureHumidity(service: Service, zone: 1 | 2): void {
    const zoneName = zone === 1 ? 'Zone 1' : 'Zone 2';

    service.setCharacteristic(this.platform.Characteristic.Name, `Wine Cooler ${zoneName} Humidity`);

    service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      })
      .onGet(async () => {
        const state = await this.platform.client.getState();
        const zoneState = zone === 1 ? state.zone1 : state.zone2;
        return numberOrDefault(zoneState.humidity, 0);
      });
  }

  private configureSabbath(): void {
    this.sabbathService.setCharacteristic(this.platform.Characteristic.Name, 'Wine Cooler Sabbath Mode');

    this.sabbathService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(async () => {
        const state = await this.platform.client.getState();
        return booleanOrDefault(state.sabbathMode, false);
      })
      .onSet(async (value: CharacteristicValue) => {
        const state = await this.platform.client.setSabbath(Boolean(value));
        this.accessory.context.device = state;
        HonWineCoolerAccessory.updateCharacteristicValues(this.platform, this.accessory, state);
      });
  }
}