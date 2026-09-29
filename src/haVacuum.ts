/**
 * Home Assistant side of one Roborock vacuum: finds the companion entities the
 * HA Roborock integration creates, reads them into a VacuumSnapshot and sends
 * commands through HA services.
 */
import { HaError, type HaClient, type HaLogger, type HaState } from './haClient.js';
import { type CleanCapabilities, type CleanTarget, planMotorMode } from './cleanModes.js';
import type { HaSegment } from './rooms.js';
import type { VacuumSnapshot } from './vacuumState.js';

export type EntityRole =
  | 'status' | 'vacuumError' | 'dockError' | 'battery' | 'charging' | 'inCleaning'
  | 'currentRoom' | 'cleaningMode' | 'waterMode' | 'mopRoute' | 'selectedMap';

interface RoleMatcher {
  domain: string;
  translationKeys: string[];
  uniquePrefixes: string[];
}

/** How the HA Roborock integration names its entities (translation_key / unique_id "<key>_<duid>"). */
const ROLE_MATCHERS: Record<EntityRole, RoleMatcher> = {
  status: { domain: 'sensor', translationKeys: ['status'], uniquePrefixes: ['status_'] },
  vacuumError: { domain: 'sensor', translationKeys: ['vacuum_error'], uniquePrefixes: ['vacuum_error_'] },
  dockError: { domain: 'sensor', translationKeys: ['dock_error'], uniquePrefixes: ['dock_error_'] },
  battery: { domain: 'sensor', translationKeys: [], uniquePrefixes: ['battery_'] },
  charging: { domain: 'binary_sensor', translationKeys: [], uniquePrefixes: ['battery_charging_', 'charging_'] },
  inCleaning: { domain: 'binary_sensor', translationKeys: ['in_cleaning'], uniquePrefixes: ['in_cleaning_'] },
  currentRoom: { domain: 'sensor', translationKeys: ['current_room'], uniquePrefixes: ['current_room_'] },
  cleaningMode: { domain: 'select', translationKeys: ['cleaning_mode'], uniquePrefixes: ['cleaning_mode_'] },
  waterMode: { domain: 'select', translationKeys: ['mop_intensity'], uniquePrefixes: ['water_box_mode_'] },
  mopRoute: { domain: 'select', translationKeys: ['mop_mode'], uniquePrefixes: ['mop_mode_'] },
  selectedMap: { domain: 'select', translationKeys: ['selected_map'], uniquePrefixes: ['selected_map_'] },
};

interface RegistryEntity {
  entity_id: string;
  device_id: string | null;
  translation_key?: string | null;
  unique_id?: string;
  options?: Record<string, Record<string, unknown>>;
}

/** config/entity_registry/list_for_display entry (enabled entities only) */
interface DisplayEntity {
  ei: string;
  di?: string;
}

interface RegistryDevice {
  id: string;
  name: string | null;
  name_by_user?: string | null;
  manufacturer: string | null;
  model: string | null;
  model_id?: string | null;
  sw_version: string | null;
  hw_version?: string | null;
  serial_number?: string | null;
  via_device_id?: string | null;
  identifiers: Array<[string, string]>;
}

export interface DeviceInfo {
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  firmwareRevision?: string;
  hardwareRevision?: string;
}

export interface RoomSource {
  segments: HaSegment[];
  areaMapping: Record<string, string[]> | null;
  areaNames: Record<string, string>;
  currentMap: string | null;
}

const UNAVAILABLE = new Set(['unavailable', 'unknown', '']);
/** registry lists can be large on big installs */
const REGISTRY_TIMEOUT_MS = 30_000;
/** Apple re-sends the clean mode before every start; don't repeat an identical command within this window */
const MOTOR_MODE_DEDUP_MS = 60_000;

function stateOrNull(s: HaState | undefined): string | null {
  return s && !UNAVAILABLE.has(s.state) ? s.state : null;
}

function optionsOf(s: HaState | undefined): string[] {
  const opts = s?.attributes.options;
  return Array.isArray(opts) ? opts.map(String) : [];
}

export class HaVacuum {
  readonly entities: Partial<Record<EntityRole, string>> = {};
  deviceInfo: DeviceInfo | null = null;
  private lastMotorMode: { key: string; at: number } | null = null;

  constructor(
    private readonly ha: HaClient,
    readonly vacuumEntityId: string,
    private readonly log: HaLogger,
    private readonly overrides: Partial<Record<EntityRole, string>> = {},
  ) {}

  /** Entity ids to stream from HA. */
  get watchedEntityIds(): string[] {
    return [this.vacuumEntityId, ...Object.values(this.entities)];
  }

  /**
   * Resolves companion entities and device metadata from the HA registries.
   * Uses the compact list_for_display (enabled entities only) to find the vacuum's
   * entities and get_entries for just those, instead of the full entity registry.
   */
  async discover(): Promise<void> {
    const [display, devices] = await Promise.all([
      this.ha.request({ type: 'config/entity_registry/list_for_display' }, { timeoutMs: REGISTRY_TIMEOUT_MS }) as
        Promise<{ entities: DisplayEntity[] }>,
      this.ha.request({ type: 'config/device_registry/list' }, { timeoutMs: REGISTRY_TIMEOUT_MS }) as Promise<RegistryDevice[]>,
    ]);
    const vacuum = display.entities.find(e => e.ei === this.vacuumEntityId);
    if (!vacuum) {
      throw new HaError(`Entity ${this.vacuumEntityId} was not found in Home Assistant (or is disabled)`);
    }
    const device = devices.find(d => d.id === vacuum.di);
    const duid = device?.identifiers.find(([domain]) => domain === 'roborock')?.[1];
    // Dock entities live on a separate "<name> Dock" device, identified as "<duid>_dock"
    // (it is not always linked through via_device_id).
    const isCompanion = (d: RegistryDevice) => d.via_device_id === vacuum.di
      || (duid !== undefined && d.identifiers.some(([domain, id]) => domain === 'roborock' && id.startsWith(`${duid}_`)));
    const deviceIds = new Set([vacuum.di, ...devices.filter(isCompanion).map(d => d.id)]);
    const ids = display.entities.filter(e => e.di && deviceIds.has(e.di)).map(e => e.ei);
    const entries = await this.ha.request({ type: 'config/entity_registry/get_entries', entity_ids: ids }) as
      Record<string, RegistryEntity | null>;
    const candidates = Object.values(entries).filter((e): e is RegistryEntity => e !== null);

    for (const [role, matcher] of Object.entries(ROLE_MATCHERS) as Array<[EntityRole, RoleMatcher]>) {
      const override = this.overrides[role];
      if (override) {
        this.entities[role] = override;
        continue;
      }
      const inDomain = candidates.filter(e => e.entity_id.startsWith(`${matcher.domain}.`));
      const match = inDomain.find(e => e.translation_key && matcher.translationKeys.includes(e.translation_key))
        ?? inDomain.find(e => matcher.uniquePrefixes.some(p => e.unique_id?.startsWith(p)
          // "battery_" must not swallow "battery_charging_"
          && !(role === 'battery' && e.unique_id?.startsWith('battery_charging'))));
      if (match) {
        this.entities[role] = match.entity_id;
      } else {
        delete this.entities[role];
      }
    }
    this.log.info(`Using entities for ${this.vacuumEntityId}: ${JSON.stringify(this.entities)}`);

    this.deviceInfo = {
      name: device?.name_by_user ?? device?.name ?? this.vacuumEntityId,
      manufacturer: device?.manufacturer ?? 'Roborock',
      model: device?.model ?? 'Robot Vacuum',
      serialNumber: (device?.serial_number ?? duid ?? this.vacuumEntityId).slice(0, 32),
      firmwareRevision: device?.sw_version ?? undefined,
      hardwareRevision: device?.hw_version ?? undefined,
    };
  }

  snapshot(): VacuumSnapshot {
    const get = (role: EntityRole): HaState | undefined => {
      const id = this.entities[role];
      return id ? this.ha.getState(id) : undefined;
    };
    const vac = this.ha.getState(this.vacuumEntityId);
    const vacState = stateOrNull(vac);
    const battery = Number.parseFloat(stateOrNull(get('battery')) ?? '');
    const bool = (role: EntityRole): boolean | null => {
      const v = stateOrNull(get(role));
      return v === null ? null : v === 'on';
    };
    const fanList = vac?.attributes.fan_speed_list;
    return {
      available: this.ha.connected && vacState !== null,
      activity: vacState,
      status: stateOrNull(get('status')),
      inCleaning: bool('inCleaning'),
      charging: bool('charging'),
      battery: Number.isFinite(battery) ? battery : null,
      vacuumError: stateOrNull(get('vacuumError')),
      dockError: stateOrNull(get('dockError')),
      fanSpeed: typeof vac?.attributes.fan_speed === 'string' ? vac.attributes.fan_speed : null,
      fanSpeedList: Array.isArray(fanList) ? fanList.map(String) : [],
      cleaningMode: stateOrNull(get('cleaningMode')),
      cleaningModeOptions: optionsOf(get('cleaningMode')),
      waterMode: stateOrNull(get('waterMode')),
      waterModeOptions: optionsOf(get('waterMode')),
      mopRoute: stateOrNull(get('mopRoute')),
      mopRouteOptions: optionsOf(get('mopRoute')),
      currentRoom: stateOrNull(get('currentRoom')),
    };
  }

  capabilities(): CleanCapabilities {
    const s = this.snapshot();
    return {
      fanSpeeds: s.fanSpeedList,
      waterModes: s.waterModeOptions,
      routes: s.mopRouteOptions,
      cleaningModes: s.cleaningModeOptions,
    };
  }

  /** Segments + HA area mapping. Falls back to roborock.get_maps when the token is not admin. */
  async loadRooms(): Promise<RoomSource> {
    const currentMap = stateOrNull(this.entities.selectedMap ? this.ha.getState(this.entities.selectedMap) : undefined);
    let segments: HaSegment[] = [];
    try {
      const res = await this.ha.request({ type: 'vacuum/get_segments', entity_id: this.vacuumEntityId }) as { segments: HaSegment[] };
      segments = res.segments ?? [];
    } catch (err) {
      this.log.debug(`vacuum/get_segments failed (${(err as Error).message}), falling back to roborock.get_maps`);
      const res = await this.ha.callService('roborock', 'get_maps', {}, { entity_id: this.vacuumEntityId }, true) as
        Record<string, { maps?: Array<{ flag: number; name: string; rooms: Record<string, string> }> }> | undefined;
      const maps = res?.[this.vacuumEntityId]?.maps ?? [];
      segments = maps.flatMap(m => Object.entries(m.rooms ?? {}).map(([seg, name]) => ({ id: `${m.flag}_${seg}`, name, group: m.name })));
    }

    let areaMapping: Record<string, string[]> | null = null;
    const areaNames: Record<string, string> = {};
    try {
      const entry = await this.ha.request({ type: 'config/entity_registry/get', entity_id: this.vacuumEntityId }) as RegistryEntity;
      const mapping = entry.options?.vacuum?.area_mapping;
      if (mapping && typeof mapping === 'object') {
        areaMapping = mapping as Record<string, string[]>;
        const areas = await this.ha.request({ type: 'config/area_registry/list' }) as Array<{ area_id: string; name: string }>;
        for (const a of areas) {
          areaNames[a.area_id] = a.name;
        }
      }
    } catch (err) {
      this.log.debug(`Could not read HA area mapping: ${(err as Error).message}`);
    }
    return { segments, areaMapping, areaNames, currentMap };
  }

  // ---- commands ------------------------------------------------------------

  private vacuumService(service: string, data: Record<string, unknown> = {}): Promise<unknown> {
    return this.ha.callService('vacuum', service, data, { entity_id: this.vacuumEntityId });
  }

  /** Resume/start via HA, which picks resume_segment_clean / resume_zoned_clean for paused jobs. */
  start(): Promise<unknown> {
    return this.vacuumService('start');
  }

  /** Whole-home clean. Not vacuum.start: HA maps that to app_charge while the robot is returning. */
  cleanAll(): Promise<unknown> {
    return this.vacuumService('send_command', { command: 'app_start' });
  }

  cleanSegments(segments: number[]): Promise<unknown> {
    return this.vacuumService('send_command', { command: 'app_segment_clean', params: [{ segments }] });
  }

  pause(): Promise<unknown> {
    return this.vacuumService('pause');
  }

  stop(): Promise<unknown> {
    return this.vacuumService('stop');
  }

  returnToBase(): Promise<unknown> {
    return this.vacuumService('return_to_base');
  }

  locate(): Promise<unknown> {
    return this.vacuumService('locate');
  }

  /** Ask the Roborock coordinator for a fresh poll so state follows commands quickly. */
  refresh(): Promise<unknown> {
    return this.ha.callService('homeassistant', 'update_entity', {}, { entity_id: this.vacuumEntityId });
  }

  /**
   * Applies a clean mode. Apple Home re-sends the mode before every start, and the
   * robot beeps for every settings command, so: nothing when already set (or just
   * sent), otherwise one set_clean_motor_mode with suction, water and route together.
   */
  async applyCleanTarget(target: CleanTarget): Promise<void> {
    const s = this.snapshot();
    const plan = planMotorMode(target, s);
    if (plan) {
      const key = JSON.stringify(plan.params);
      if (!plan.params || (this.lastMotorMode?.key === key && Date.now() - this.lastMotorMode.at < MOTOR_MODE_DEDUP_MS)) {
        this.log.debug(`${this.vacuumEntityId}: clean mode already set (${plan.summary})`);
        return;
      }
      await this.vacuumService('send_command', { command: 'set_clean_motor_mode', params: plan.params });
      this.lastMotorMode = { key, at: Date.now() };
      this.log.debug(`${this.vacuumEntityId}: set ${plan.summary}`);
      return;
    }

    // Unknown code table: fall back to one call per setting.
    let force = false;
    const select = async (role: EntityRole, option: string | undefined, current: string | null, options: string[]) => {
      const entityId = this.entities[role];
      if (!entityId || option === undefined || (option === current && !force) || !options.includes(option)) {
        return false;
      }
      await this.ha.callService('select', 'select_option', { option }, { entity_id: entityId });
      return true;
    };
    // Changing the cleaning mode resets fan/water/route, so everything after it must be sent.
    force = await select('cleaningMode', target.cleaningMode, s.cleaningMode, s.cleaningModeOptions);
    if (target.fan !== undefined && (force || target.fan !== s.fanSpeed) && s.fanSpeedList.includes(target.fan)) {
      await this.vacuumService('set_fan_speed', { fan_speed: target.fan });
    }
    await select('waterMode', target.water, s.waterMode, s.waterModeOptions);
    await select('mopRoute', target.route, s.mopRoute, s.mopRouteOptions);
  }
}
