import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { HaClient, type HaState } from './haClient.js';
import { MatterVacuum, type VacuumConfig } from './matterVacuum.js';

interface HaRoborockMatterConfig extends PlatformConfig {
  haUrl?: string;
  haToken?: string;
  vacuums?: VacuumConfig[];
}

const STARTUP_WAIT_MS = 20_000;

export class HaRoborockMatterPlatform implements DynamicPlatformPlugin {
  private readonly vacuums: MatterVacuum[] = [];
  private ha: HaClient | null = null;
  private resyncRunning = false;
  private resyncAgain = false;

  constructor(
    private readonly log: Logging,
    private readonly config: HaRoborockMatterConfig,
    private readonly api: API,
  ) {
    if (!config.haUrl || !config.haToken || !config.vacuums?.length) {
      log.error('haUrl, haToken and at least one vacuum entity are required');
      return;
    }
    if (!api.isMatterEnabled()) {
      log.error('Matter is not enabled on this bridge. Enable Matter in the Homebridge settings (bridge.matter).');
      return;
    }
    api.on('didFinishLaunching', () => {
      this.start().catch(err => log.error(`Startup failed: ${(err as Error).stack}`));
    });
    api.on('shutdown', () => {
      this.vacuums.forEach(v => v.shutdown());
      this.ha?.stop();
    });
  }

  configureAccessory(_accessory: PlatformAccessory): void {
    // Matter-only plugin: no HAP accessories.
  }

  private async start(): Promise<void> {
    const ha = new HaClient(this.config.haUrl!, this.config.haToken!, this.log);
    this.ha = ha;
    for (const vc of this.config.vacuums ?? []) {
      if (!vc.entityId?.startsWith('vacuum.')) {
        this.log.error(`Invalid vacuum entity id: ${String(vc.entityId)}`);
        continue;
      }
      this.vacuums.push(new MatterVacuum(this.api, this.log, ha, vc));
    }

    ha.on('state', (s: HaState) => this.vacuums.forEach(v => v.onHaState(s.entity_id)));
    ha.on('disconnected', () => this.vacuums.forEach(v => v.onHaDisconnected()));
    ha.on('connected', () => {
      this.resync().catch(err => this.log.error(`Sync with Home Assistant failed: ${(err as Error).message}`));
    });
    ha.start();

    // If HA isn't up yet, publish from the cached structure so the vacuum stays in Apple Home.
    setTimeout(() => {
      if (!ha.connected) {
        this.log.warn('Home Assistant not reachable yet; publishing cached vacuum definitions');
        for (const v of this.vacuums) {
          v.startFromCache().then(ok => {
            if (!ok) {
              this.log.warn(`${v.entityId}: no cache yet, will publish once Home Assistant is reachable`);
            }
          }).catch(err => this.log.error(`${v.entityId}: ${(err as Error).message}`));
        }
      }
    }, STARTUP_WAIT_MS);
  }

  /**
   * On every (re)connect: rediscover entities, rooms and modes. A reconnect that
   * happens while a sync is running queues exactly one more sync.
   */
  private async resync(): Promise<void> {
    if (this.resyncRunning) {
      this.resyncAgain = true;
      return;
    }
    this.resyncRunning = true;
    try {
      do {
        this.resyncAgain = false;
        for (const v of this.vacuums) {
          try {
            await v.syncStructure();
          } catch (err) {
            this.log.error(`${v.entityId}: ${(err as Error).message}`);
          }
        }
      } while (this.resyncAgain && this.ha?.connected);
    } finally {
      this.resyncRunning = false;
    }
  }
}
