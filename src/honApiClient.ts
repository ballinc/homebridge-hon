import type { Logging } from 'homebridge';
import type { AppliancesResponse, WineCoolerState } from './settings.js';

export class HonApiClient {
  private cachedState?: WineCoolerState;
  private lastFetchMs = 0;

  public constructor(
    private readonly log: Logging,
    private readonly baseUrl: string,
    private readonly pollIntervalMs: number,
  ) {}

  public clearCache(): void {
    this.cachedState = undefined;
    this.lastFetchMs = 0;
  }

  public setCachedState(state: WineCoolerState): void {
    this.cachedState = state;
    this.lastFetchMs = Date.now();
  }

  public async getAppliances(): Promise<WineCoolerState[]> {
    const response = await this.request<AppliancesResponse>('/appliances');
    if (response.appliances.length > 0) {
      this.setCachedState(response.appliances[0]);
    }
    return response.appliances;
  }

  public async getState(force = false): Promise<WineCoolerState> {
    const now = Date.now();

    if (!force && this.cachedState && now - this.lastFetchMs < this.pollIntervalMs) {
      return this.cachedState;
    }

    const state = await this.request<WineCoolerState>('/state');
    this.setCachedState(state);
    return state;
  }

  public async setLight(on: boolean): Promise<WineCoolerState> {
    const state = await this.request<WineCoolerState>('/light', {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
    this.setCachedState(state);
    return state;
  }

  public async setSabbath(on: boolean): Promise<WineCoolerState> {
    const state = await this.request<WineCoolerState>('/sabbath', {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
    this.setCachedState(state);
    return state;
  }

  public async setTargetTemperature(zone: 1 | 2, temperature: number): Promise<WineCoolerState> {
    const state = await this.request<WineCoolerState>(`/zone/${zone}/target-temperature`, {
      method: 'POST',
      body: JSON.stringify({ temperature }),
    });
    this.setCachedState(state);
    return state;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();

    if (!response.ok) {
      this.log.debug('Bridge HTTP error response:', text);
      throw new Error(`hOn bridge ${response.status} ${response.statusText}: ${text}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`hOn bridge returned invalid JSON from ${url}: ${String(error)}`);
    }
  }
}