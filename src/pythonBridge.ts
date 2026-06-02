import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { API, Logging } from 'homebridge';
import type { HonWineCoolerConfig } from './settings.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export class PythonBridgeManager {
  private process?: ChildProcessWithoutNullStreams;
  private readonly bridgeScript: string;
  private readonly dataDir: string;

  public constructor(
    private readonly log: Logging,
    private readonly api: API,
    private readonly config: Required<Pick<HonWineCoolerConfig, 'bridgeHost' | 'bridgePort' | 'pollIntervalSeconds' | 'pythonPath'>> & HonWineCoolerConfig,
  ) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    this.bridgeScript = resolve(currentDir, '../bridge/hon_bridge.py');
    this.dataDir = config.dataDir || resolve(this.api.user.storagePath(), 'hon-wine-cooler');
  }

  public start(): void {
    if (this.process) {
      return;
    }

    if (!this.config.email || !this.config.password) {
      throw new Error('hOn email and password are required when autoStartBridge is enabled.');
    }

    mkdirSync(this.dataDir, { recursive: true });

    const args = [
      this.bridgeScript,
      '--host', this.config.bridgeHost,
      '--port', String(this.config.bridgePort),
      '--poll-interval', String(this.config.pollIntervalSeconds),
      '--data-dir', this.dataDir,
    ];

    this.log.info('Starting Python hOn bridge:', this.config.pythonPath, args.join(' '));

    this.process = spawn(this.config.pythonPath, args, {
      env: {
        ...process.env,
        HON_USER: this.config.email,
        HON_PASSWORD: this.config.password,
        HON_DATA_DIR: this.dataDir,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.process.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          this.log.info(`[hon-bridge] ${line}`);
        }
      }
    });

    this.process.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          this.log.warn(`[hon-bridge] ${line}`);
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      this.log.warn(`Python hOn bridge exited: code=${code} signal=${signal}`);
      this.process = undefined;
    });

    this.api.on('shutdown', () => this.stop());
  }

  public stop(): void {
    if (!this.process) {
      return;
    }

    this.log.info('Stopping Python hOn bridge');
    this.process.kill('SIGTERM');
    this.process = undefined;
  }

  public async waitUntilReady(baseUrl: string, timeoutMs = 90000): Promise<void> {
    const started = Date.now();
    let lastError = '';

    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          return;
        }
        lastError = `${response.status} ${response.statusText}`;
      } catch (error) {
        lastError = String(error);
      }

      await sleep(1500);
    }

    throw new Error(`hOn bridge did not become ready within ${timeoutMs}ms. Last error: ${lastError}`);
  }
}