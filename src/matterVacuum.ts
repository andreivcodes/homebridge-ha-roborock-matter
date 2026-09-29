/**
 * The Matter Robotic Vacuum Cleaner published to Apple Home for one HA vacuum.
 *
 * Homebridge 2.4 publishes RoboticVacuumCleaner accessories as standalone
 * (non-bridged) Matter nodes with their own pairing code, which Apple Home
 * requires for rooms and Siri to work.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { API, Logging, MatterAccessory, MatterClusterName } from 'homebridge';

import { CleaningJob } from './cleaningJob.js';
import { buildCleanModes, type CleanModeDef, deriveCleanMode } from './cleanModes.js';
import type { HaClient } from './haClient.js';
import { type DeviceInfo, type EntityRole, HaVacuum } from './haVacuum.js';
import { CleanModeTag, ErrorState, OperationalState, PowerSourceStatus, RunModeTag } from './matterConstants.js';
import { buildRooms, type Room, roomForRoborockName, toSupportedAreas, toSupportedMaps } from './rooms.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  baseOperationalState,
  deriveBattery,
  deriveOperational,
  describeOperational,
  type DockAlerts,
  isCleaningJob,
} from './vacuumState.js';

export interface VacuumConfig {
  entityId: string;
  name?: string;
  dockAlerts?: DockAlerts;
  maxFanSpeed?: string;
  roomTypes?: Record<string, string>;
  entities?: Partial<Record<EntityRole, string>>;
}

interface CachedStructure {
  deviceInfo: DeviceInfo;
  cleanModes: CleanModeDef[];
  rooms: Room[];
  mapName: string | null;
}

const RUN_IDLE = 0;
const RUN_CLEANING = 1;
const OPERATIONAL_STATES = [
  OperationalState.Stopped, OperationalState.Running, OperationalState.Paused, OperationalState.Error,
  OperationalState.SeekingCharger, OperationalState.Charging, OperationalState.Docked,
  OperationalState.EmptyingDustBin, OperationalState.CleaningMop,
];
/** ride out HA restarts / short blips before showing the vacuum as unreachable */
const OFFLINE_GRACE_MS = 60_000;
/** answer Apple within its timeout even if HA or the robot is slow */
const COMMAND_WAIT_MS = 8_000;
const HEARTBEAT_MS = 120_000;
const ROOM_REFRESH_MS = 15 * 60_000;
const FALLBACK_CLEAN_MODE: CleanModeDef = {
  mode: 2, label: 'Vacuum', tags: [CleanModeTag.Vacuum, CleanModeTag.Auto], family: 'vacuum', level: 'auto', target: {},
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** JSON with keys sorted and null/undefined dropped, to compare our intent with matter.js state. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

export class MatterVacuum {
  private readonly backend: HaVacuum;
  private readonly uuid: string;
  private readonly cachePath: string;
  private registered = false;
  private registering: Promise<void> | null = null;

  private deviceInfo: DeviceInfo | null = null;
  private cleanModes: CleanModeDef[] = [];
  private rooms: Room[] = [];
  private mapName: string | null = null;

  private readonly job = new CleaningJob();
  /** the clean mode Apple last selected; wins while the robot's settings still match it */
  private preferredCleanMode: number | undefined;
  private unavailableSince: number | null = null;
  private lastRoomOptions = '';
  private lastStateLog = '';

  /** last attribute values we asked Homebridge to set, per cluster (and slot) */
  private readonly desired = new Map<string, { cluster: MatterClusterName; slot?: string; attrs: Record<string, unknown> }>();
  private readonly pushed = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private syncTimer: NodeJS.Timeout | null = null;
  private refreshTimers: NodeJS.Timeout[] = [];
  private readonly intervals: NodeJS.Timeout[] = [];

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly ha: HaClient,
    private readonly config: VacuumConfig,
  ) {
    this.backend = new HaVacuum(ha, config.entityId, log, config.entities);
    this.uuid = api.matter!.uuid.generate(`${PLUGIN_NAME}:${config.entityId}`);
    this.cachePath = path.join(api.user.storagePath(), PLUGIN_NAME, `${config.entityId.replace(/[^a-z0-9_.-]/gi, '_')}.json`);
  }

  get entityId(): string {
    return this.config.entityId;
  }

  get watchedEntityIds(): string[] {
    return this.backend.watchedEntityIds;
  }

  /** Publishes from the on-disk structure cache so Apple Home works even if HA is down at boot. */
  async startFromCache(): Promise<boolean> {
    try {
      const cached = JSON.parse(await readFile(this.cachePath, 'utf8')) as CachedStructure;
      this.deviceInfo = cached.deviceInfo;
      this.cleanModes = cached.cleanModes;
      this.rooms = cached.rooms;
      this.mapName = cached.mapName ?? null;
    } catch {
      return false;
    }
    await this.register();
    return true;
  }

  /** Discovers everything from HA (every (re)connect) and publishes/updates the accessory. */
  async syncStructure(): Promise<void> {
    await this.backend.discover();
    this.deviceInfo = this.backend.deviceInfo;
    await this.ha.watchEntities(this.backend.watchedEntityIds);
    await this.waitForState();

    const caps = this.backend.capabilities();
    const modes = caps.fanSpeeds.length > 0 ? buildCleanModes(caps, { maxFanSpeed: this.config.maxFanSpeed }) : [];
    if (modes.length > 0) {
      if (this.registered && stable(modes.map(m => [m.mode, m.tags])) !== stable(this.cleanModes.map(m => [m.mode, m.tags]))) {
        this.log.warn(`${this.name}: the robot's clean modes changed; restart Homebridge (and possibly re-pair) to publish them`);
      } else {
        this.cleanModes = modes;
      }
    } else if (this.cleanModes.length === 0) {
      this.log.warn(`${this.name}: no fan speeds reported by HA yet; publishing a single Vacuum mode`);
    }
    this.log.info(`${this.name}: clean modes ${this.cleanModes.map(m => `${m.mode}=${m.label}`).join(', ')}`);

    await this.reloadRooms();
    await this.saveCache();
    if (!this.registered) {
      await this.register();
    }
    this.scheduleSync(0);
  }

  onHaState(entityId: string): void {
    if (!this.registered || !this.watchedEntityIds.includes(entityId)) {
      return;
    }
    const currentRoomId = this.backend.entities.currentRoom;
    if (entityId === this.backend.entities.selectedMap || entityId === currentRoomId) {
      // current_room's options list the rooms of the active map: it changes when rooms are edited or the map switches
      const options = stable(currentRoomId ? this.ha.getState(currentRoomId)?.attributes.options : null)
        + (this.backend.entities.selectedMap ? this.ha.getState(this.backend.entities.selectedMap)?.state : '');
      if (this.lastRoomOptions && options !== this.lastRoomOptions) {
        this.reloadRooms().catch(err => this.log.warn(`${this.name}: room reload failed: ${(err as Error).message}`));
      }
      this.lastRoomOptions = options;
    }
    this.scheduleSync(250);
  }

  onHaDisconnected(): void {
    this.scheduleSync(0);
  }

  shutdown(): void {
    this.intervals.forEach(clearInterval);
    this.refreshTimers.forEach(clearTimeout);
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
  }

  private get name(): string {
    return this.config.name ?? this.deviceInfo?.name ?? this.config.entityId;
  }

  private async waitForState(): Promise<void> {
    for (let i = 0; i < 50 && !this.ha.getState(this.config.entityId); i++) {
      await sleep(100);
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.deviceInfo) {
      return;
    }
    const data: CachedStructure = { deviceInfo: this.deviceInfo, cleanModes: this.cleanModes, rooms: this.rooms, mapName: this.mapName };
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(data, null, 2));
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  private async reloadRooms(): Promise<void> {
    const source = await this.backend.loadRooms();
    const rooms = buildRooms({ ...source, roomTypes: this.config.roomTypes });
    if (source.segments.length === 0 && this.rooms.length > 0) {
      this.log.debug(`${this.name}: HA returned no segments, keeping ${this.rooms.length} known rooms`);
      return;
    }
    const changed = stable(rooms) !== stable(this.rooms) || (source.currentMap ?? null) !== this.mapName;
    this.rooms = rooms;
    this.mapName = source.currentMap ?? this.mapName;
    this.log.info(`${this.name}: rooms ${rooms.map(r => `${r.areaId}=${r.name}`).join(', ') || '(none)'}`
      + (source.areaMapping ? ' (using HA area mapping)' : ''));
    if (changed && this.registered) {
      // Clear everything that references areas first: one transaction with an unknown areaId rolls back entirely.
      this.job.clearAreas();
      const { ServiceArea } = this.api.matter!.clusterNames;
      this.push(ServiceArea, { selectedAreas: [], currentArea: null, progress: [] }, { force: true });
      this.push(ServiceArea, {
        supportedMaps: toSupportedMaps(this.mapName),
        supportedAreas: toSupportedAreas(rooms),
      }, { slot: 'rooms', force: true });
      await this.saveCache();
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  private buildAccessory(): MatterAccessory {
    const matter = this.api.matter!;
    const info = this.deviceInfo!;
    const modes = this.cleanModes.length > 0 ? this.cleanModes : [FALLBACK_CLEAN_MODE];
    const snapshot = this.backend.snapshot();
    const battery = deriveBattery(snapshot);

    return {
      UUID: this.uuid,
      displayName: this.name,
      deviceType: matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: info.serialNumber,
      manufacturer: info.manufacturer,
      model: info.model,
      firmwareRevision: info.firmwareRevision,
      hardwareRevision: info.hardwareRevision,
      context: { entityId: this.config.entityId },
      clusters: {
        powerSource: {
          status: PowerSourceStatus.Active,
          order: 0,
          description: 'Battery',
          batPercentRemaining: battery.batPercentRemaining,
          batChargeLevel: battery.batChargeLevel,
          batReplaceability: 1, // NotReplaceable
          batChargeState: battery.batChargeState,
          batFunctionalWhileCharging: true,
        },
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RUN_IDLE, modeTags: [{ value: RunModeTag.Idle }] },
            { label: 'Cleaning', mode: RUN_CLEANING, modeTags: [{ value: RunModeTag.Cleaning }] },
          ],
          currentMode: RUN_IDLE,
        },
        rvcCleanMode: {
          supportedModes: modes.map(m => ({ label: m.label, mode: m.mode, modeTags: m.tags.map(value => ({ value })) })),
          currentMode: deriveCleanMode(modes, snapshot) ?? modes[0].mode,
        },
        rvcOperationalState: {
          operationalStateList: OPERATIONAL_STATES.map(operationalStateId => ({ operationalStateId })),
          operationalState: OperationalState.Docked,
          operationalError: { errorStateId: ErrorState.NoError },
        },
        // supportedMaps => Maps feature; progress => ProgressReporting feature.
        serviceArea: {
          supportedMaps: toSupportedMaps(this.mapName),
          supportedAreas: toSupportedAreas(this.rooms),
          selectedAreas: [],
          currentArea: null,
          progress: [],
        },
      },
      handlers: {
        identify: {
          identify: async (req: { identifyTime?: number }) => {
            if ((req?.identifyTime ?? 1) > 0) {
              await this.command('locate', () => this.backend.locate(), 3000);
            }
          },
        },
        rvcRunMode: {
          changeToMode: async (req: { newMode: number }) => this.onRunModeChange(req.newMode),
        },
        rvcCleanMode: {
          changeToMode: async (req: { newMode: number }) => this.onCleanModeChange(req.newMode),
        },
        rvcOperationalState: {
          pause: async () => this.onPause(),
          resume: async () => this.onResume(),
          goHome: async () => this.onGoHome(),
        },
        serviceArea: {
          selectAreas: async (req: { newAreas: number[] }) => this.onSelectAreas(req.newAreas ?? []),
          skipArea: async () => {
            throw new matter.status.InvalidAction('Roborock cannot skip a room mid-clean');
          },
        },
      },
    };
  }

  /** Cache start-up and the first HA connect can race; only one may register. */
  private register(): Promise<void> {
    this.registering ??= this.doRegister().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async doRegister(): Promise<void> {
    if (this.registered || !this.deviceInfo) {
      return;
    }
    await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.buildAccessory()]);
    // Homebridge logs (but does not throw) when matter.js rejects the endpoint.
    if (!await this.api.matter!.getAccessoryState(this.uuid, this.api.matter!.clusterNames.RvcOperationalState)) {
      this.log.error(`${this.name}: Homebridge failed to publish the Matter vacuum, see the Matter errors above`);
      return;
    }
    this.registered = true;
    this.log.info(`${this.name}: published as a standalone Matter robot vacuum (pair it from the Homebridge UI)`);
    this.intervals.push(setInterval(() => this.verifyState().catch(() => undefined), HEARTBEAT_MS));
    this.intervals.push(setInterval(() => {
      if (this.ha.connected) {
        this.reloadRooms().catch(err => this.log.debug(`${this.name}: room refresh failed: ${(err as Error).message}`));
      }
    }, ROOM_REFRESH_MS));
    this.scheduleSync(0);
  }

  // ---------------------------------------------------------------------------
  // State: HA -> Matter
  // ---------------------------------------------------------------------------

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      try {
        this.sync();
      } catch (err) {
        this.log.error(`${this.name}: state sync failed: ${(err as Error).stack}`);
      }
    }, delayMs);
  }

  private sync(): void {
    if (!this.registered) {
      return;
    }
    const s = this.backend.snapshot();
    const now = Date.now();
    if (!s.available) {
      this.unavailableSince ??= now;
      const remaining = OFFLINE_GRACE_MS - (now - this.unavailableSince);
      if (remaining > 0) {
        this.scheduleSync(remaining + 100);
        return;
      }
    } else {
      this.unavailableSince = null;
    }

    const view = this.job.update(now, {
      available: s.available,
      status: s.status,
      operational: deriveOperational(s, { dockAlerts: this.config.dockAlerts ?? 'mop' }),
      runCleaning: isCleaningJob(s),
      currentArea: roomForRoborockName(this.rooms, s.currentRoom)?.areaId ?? null,
    });
    if (view.recheckInMs !== null) {
      this.scheduleSync(view.recheckInMs);
    }
    if (view.finished) {
      this.log.info(`${this.name}: cleaning job finished`);
    }

    const { PowerSource, RvcRunMode, RvcCleanMode, RvcOperationalState, ServiceArea } = this.api.matter!.clusterNames;
    const battery = deriveBattery(s);
    this.push(PowerSource, {
      status: s.available ? PowerSourceStatus.Active : PowerSourceStatus.Unavailable,
      batPercentRemaining: battery.batPercentRemaining,
      batChargeLevel: battery.batChargeLevel,
      batChargeState: battery.batChargeState,
    });
    this.push(RvcRunMode, { currentMode: view.runCleaning ? RUN_CLEANING : RUN_IDLE });
    const cleanMode = deriveCleanMode(this.cleanModes, s, this.preferredCleanMode);
    if (cleanMode !== null && s.available) {
      this.push(RvcCleanMode, { currentMode: cleanMode });
    }
    // State and error always travel together: matter.js forces state=Error for any error.
    this.push(RvcOperationalState, {
      operationalState: view.operational.operationalState,
      operationalError: view.operational.operationalError,
    });
    this.push(ServiceArea, { selectedAreas: view.selectedAreas, currentArea: view.currentArea, progress: view.progress });

    const stateLog = `${describeOperational(view.operational)}, ${view.runCleaning ? 'cleaning job' : 'idle'}, battery ${s.battery ?? '?'}%`;
    if (stateLog !== this.lastStateLog) {
      this.lastStateLog = stateLog;
      this.log.info(`${this.name}: ${stateLog}`);
    }
  }

  /**
   * Sends one cluster update if it differs from what we last sent. Independent
   * attribute groups of a cluster use separate slots: one invalid attribute rolls
   * back the whole transaction.
   */
  private push(cluster: MatterClusterName, attrs: Record<string, unknown>, opts: { slot?: string; force?: boolean } = {}): void {
    const key = opts.slot ? `${cluster}.${opts.slot}` : cluster;
    const json = stable(attrs);
    if (!opts.force && this.pushed.get(key) === json) {
      return;
    }
    this.pushed.set(key, json);
    this.desired.set(key, { cluster, slot: opts.slot, attrs });
    this.log.debug(`${this.name}: ${key} <- ${json}`);
    this.api.matter!.updateAccessoryState(this.uuid, cluster, attrs)
      .catch(err => this.log.warn(`${this.name}: failed to update ${cluster}: ${(err as Error).message}`));
  }

  /**
   * updateAccessoryState() resolves before matter.js validates, so a rejected
   * update is only visible in the log. Periodically compare what Matter holds
   * with what we intended and re-send on drift.
   */
  private async verifyState(): Promise<void> {
    for (const [key, { cluster, slot, attrs }] of this.desired) {
      const actual = await this.api.matter!.getAccessoryState(this.uuid, cluster);
      if (!actual) {
        continue;
      }
      const drift = Object.keys(attrs).filter(k => stable(actual[k]) !== stable(attrs[k]));
      if (drift.length > 0) {
        this.log.debug(`${this.name}: ${key} ${drift.join(',')} drifted, re-sending`);
        this.push(cluster, attrs, { slot, force: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Commands: Matter -> HA
  // ---------------------------------------------------------------------------

  /** Commands run strictly in order (Apple sends SelectAreas -> CleanMode -> RunMode back to back). */
  private enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run.catch(err => {
      this.log.error(`${this.name}: ${label} failed: ${(err as Error).message}`);
      throw err;
    });
  }

  private async command(label: string, fn: () => Promise<unknown>, waitMs = COMMAND_WAIT_MS): Promise<void> {
    const status = this.api.matter!.status;
    if (!this.ha.connected) {
      throw new status.Busy('Home Assistant is not connected');
    }
    this.log.info(`${this.name}: ${label}`);
    const run = this.enqueue(label, fn);
    try {
      // Answer Apple within its timeout even if HA/the robot is slow; failures after that are logged.
      await Promise.race([run, sleep(waitMs)]);
    } catch (err) {
      throw new status.Failure(`${label}: ${(err as Error).message}`);
    }
    this.scheduleRefresh();
  }

  /** HA polls Roborock every 15-30 s; ask for fresh data so the Home app follows commands quickly. */
  private scheduleRefresh(): void {
    this.refreshTimers.forEach(clearTimeout);
    this.refreshTimers = [2000, 8000].map(ms => setTimeout(() => {
      this.backend.refresh().catch(err => this.log.debug(`${this.name}: refresh failed: ${(err as Error).message}`));
    }, ms));
  }

  /** Show the state a command should lead to until HA catches up. */
  private expect(operationalState: number | undefined, runCleaning?: boolean): void {
    this.job.expect(Date.now(), this.backend.snapshot().status, operationalState, runCleaning);
    // Don't await: pushing into the cluster that is executing the command would deadlock.
    this.scheduleSync(0);
  }

  private currentState(): number {
    return baseOperationalState(this.backend.snapshot());
  }

  private async onRunModeChange(newMode: number): Promise<void> {
    if (newMode === RUN_CLEANING) {
      await this.startOrResume();
    } else if (newMode === RUN_IDLE) {
      // Apple's "Send to Dock" is RunMode Idle followed by GoHome; a docked/returning robot needs nothing.
      const state = this.currentState();
      if (state === OperationalState.Running || state === OperationalState.Paused
        || (this.job.isActive && state === OperationalState.SeekingCharger)) {
        await this.command('stop', () => this.backend.stop());
        this.expect(OperationalState.Stopped, false);
      }
    } else {
      throw new this.api.matter!.status.ConstraintError(`Unsupported run mode ${newMode}`);
    }
  }

  private async startOrResume(): Promise<void> {
    const state = this.currentState();
    if (state === OperationalState.Running) {
      return;
    }
    if (state === OperationalState.Paused) {
      await this.command('resume', () => this.backend.start());
      this.expect(OperationalState.Running, true);
      return;
    }
    const order = new Map(this.rooms.map((r, i) => [r.areaId, i]));
    const areas = [...this.job.selectedAreas].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const segments = areas.flatMap(areaId => this.rooms.find(r => r.areaId === areaId)?.segments ?? []);
    this.job.started(segments.length > 0 ? areas : null);
    if (segments.length > 0) {
      const names = areas.map(a => this.rooms.find(r => r.areaId === a)?.name).join(', ');
      await this.command(`clean ${names}`, () => this.backend.cleanSegments(segments));
    } else {
      // app_start directly: vacuum.start while returning would just keep returning (it maps to app_charge).
      await this.command('start full clean', () => this.backend.cleanAll());
    }
    this.expect(OperationalState.Running, true);
  }

  private async onCleanModeChange(newMode: number): Promise<void> {
    const def = this.cleanModes.find(m => m.mode === newMode);
    if (!def) {
      throw new this.api.matter!.status.ConstraintError(`Unsupported clean mode ${newMode}`);
    }
    this.preferredCleanMode = newMode;
    await this.command(`set clean mode ${def.label}`, () => this.backend.applyCleanTarget(def.target));
  }

  private async onPause(): Promise<void> {
    const state = this.currentState();
    if (state === OperationalState.Paused) {
      return;
    }
    if (state !== OperationalState.Running && state !== OperationalState.SeekingCharger) {
      throw new this.api.matter!.status.InvalidInState('The vacuum is not running');
    }
    await this.command('pause', () => this.backend.pause());
    this.expect(OperationalState.Paused);
  }

  private async onResume(): Promise<void> {
    // Apple Home also uses Resume as "Start" from the dock.
    await this.startOrResume();
  }

  private async onGoHome(): Promise<void> {
    const state = this.currentState();
    if (state === OperationalState.Charging || state === OperationalState.Docked || state === OperationalState.SeekingCharger) {
      return;
    }
    await this.command('return to dock', () => this.backend.returnToBase());
    this.expect(OperationalState.SeekingCharger, false);
  }

  private async onSelectAreas(newAreas: number[]): Promise<void> {
    const unique = [...new Set(newAreas)];
    if (unique.some(id => !this.rooms.some(r => r.areaId === id))) {
      // Let matter.js answer with SelectAreasStatus.UnsupportedArea.
      return;
    }
    this.job.select(unique);
    this.log.info(`${this.name}: rooms selected: ${unique.map(a => this.rooms.find(r => r.areaId === a)?.name).join(', ') || '(whole home)'}`);
    this.scheduleSync(50);
  }
}
