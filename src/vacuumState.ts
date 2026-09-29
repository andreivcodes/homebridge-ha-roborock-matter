/**
 * The robot's state as Matter sees it: operational state, errors (robot and
 * dock) and battery, derived from the HA Roborock integration's entities.
 * Pure functions, so every rule is unit-testable.
 */
import { BatChargeLevel, BatChargeState, ErrorState, OperationalState } from './matterConstants.js';

/** Normalised view of every HA entity the plugin reads for one vacuum. */
export interface VacuumSnapshot {
  /** false when HA is unreachable or the vacuum entity is unavailable */
  available: boolean;
  /** vacuum entity state: cleaning | docked | idle | paused | returning | error */
  activity: string | null;
  /** sensor.*_status: raw Roborock state name, e.g. segment_cleaning, emptying_the_bin */
  status: string | null;
  /** binary_sensor.*_cleaning (Roborock in_cleaning != 0): a clean job is in progress */
  inCleaning: boolean | null;
  /** binary_sensor.*_charging */
  charging: boolean | null;
  battery: number | null;
  /** sensor.*_vacuum_error, "none" when ok */
  vacuumError: string | null;
  /** sensor.*_dock_error, "ok" when ok */
  dockError: string | null;
  fanSpeed: string | null;
  fanSpeedList: string[];
  /** select.*_cleaning_mode: vacuum | vac_and_mop | mop | custom | smart_mode */
  cleaningMode: string | null;
  cleaningModeOptions: string[];
  /** select.*_mop_intensity */
  waterMode: string | null;
  waterModeOptions: string[];
  /** select.*_mop_mode (mop route) */
  mopRoute: string | null;
  mopRouteOptions: string[];
  /** sensor.*_current_room: Roborock room name */
  currentRoom: string | null;
}

export interface MatterOperationalError {
  errorStateId: number;
  errorStateDetails?: string;
}

export interface OperationalResult {
  operationalState: number;
  operationalError: MatterOperationalError;
}

// ---------------------------------------------------------------------------
// Operational state
// ---------------------------------------------------------------------------

const RUNNING_STATUSES = new Set([
  'cleaning', 'spot_cleaning', 'zoned_cleaning', 'segment_cleaning', 'going_to_target',
  'remote_control_active', 'manual_mode', 'mapping', 'patrol', 'egg_attack',
  'robot_status_mopping', 'clean_mop_cleaning', 'clean_mop_mopping', 'segment_mopping',
  'segment_clean_mop_cleaning', 'segment_clean_mop_mopping', 'zoned_mopping',
  'zoned_clean_mop_cleaning', 'zoned_clean_mop_mopping',
]);
const SEEKING_STATUSES = new Set([
  'returning_home', 'docking', 'going_to_wash_the_mop', 'back_to_dock_washing_duster',
]);
const DOCKED_STATUSES = new Set([
  'charging_complete', 'attaching_the_mop', 'detaching_the_mop', 'air_drying_stopping', 'updating', 'in_call',
]);
const ERROR_STATUSES = new Set(['error', 'charging_problem', 'device_offline', 'locked']);
const STOPPED_STATUSES = new Set(['idle', 'starting', 'charger_disconnected', 'shutting_down', 'unknown', 'sleeping']);

const ACTIVITY_FALLBACK: Record<string, number> = {
  cleaning: OperationalState.Running,
  paused: OperationalState.Paused,
  returning: OperationalState.SeekingCharger,
  docked: OperationalState.Docked,
  idle: OperationalState.Stopped,
  error: OperationalState.Error,
};

/** Robot's own state, ignoring errors. */
export function baseOperationalState(s: VacuumSnapshot): number {
  const status = s.status;
  if (status) {
    if (RUNNING_STATUSES.has(status)) {
      return OperationalState.Running;
    }
    if (status === 'paused') {
      return OperationalState.Paused;
    }
    if (SEEKING_STATUSES.has(status)) {
      return OperationalState.SeekingCharger;
    }
    if (status === 'charging') {
      return OperationalState.Charging;
    }
    if (status === 'emptying_the_bin') {
      return OperationalState.EmptyingDustBin;
    }
    if (status === 'washing_the_mop') {
      return OperationalState.CleaningMop;
    }
    if (DOCKED_STATUSES.has(status)) {
      return OperationalState.Docked;
    }
    if (ERROR_STATUSES.has(status)) {
      return OperationalState.Error;
    }
    if (STOPPED_STATUSES.has(status)) {
      // Roborock reports "idle"/"sleeping" while sitting on the dock too.
      if (s.charging) {
        return OperationalState.Charging;
      }
      if (s.activity === 'docked') {
        return OperationalState.Docked;
      }
      return OperationalState.Stopped;
    }
  }
  const fallback = s.activity ? ACTIVITY_FALLBACK[s.activity] : undefined;
  if (fallback === OperationalState.Docked && s.charging) {
    return OperationalState.Charging;
  }
  return fallback ?? OperationalState.Stopped;
}

const VACUUM_ERROR_STANDARD: Record<string, number> = {
  lidar_blocked: ErrorState.NavigationSensorObscured,
  bumper_stuck: ErrorState.Stuck,
  wheels_suspended: ErrorState.Stuck,
  cliff_sensor_error: ErrorState.NavigationSensorObscured,
  main_brush_jammed: ErrorState.BrushJammed,
  side_brush_jammed: ErrorState.BrushJammed,
  side_brush_error: ErrorState.BrushJammed,
  wheels_jammed: ErrorState.WheelsJammed,
  robot_trapped: ErrorState.Stuck,
  robot_tilted: ErrorState.Stuck,
  vertical_bumper_pressed: ErrorState.Stuck,
  no_dustbin: ErrorState.DustBinMissing,
  low_battery: ErrorState.LowBattery,
  dock_locator_error: ErrorState.FailedToFindChargingDock,
  return_to_dock_fail: ErrorState.FailedToFindChargingDock,
  wall_sensor_dirty: ErrorState.NavigationSensorObscured,
  optical_flow_sensor_dirt: ErrorState.NavigationSensorObscured,
  visual_sensor: ErrorState.NavigationSensorObscured,
  light_touch: ErrorState.NavigationSensorObscured,
  nogo_zone_detected: ErrorState.CannotReachTargetArea,
  invisible_wall_detected: ErrorState.CannotReachTargetArea,
  cannot_cross_carpet: ErrorState.CannotReachTargetArea,
  collect_dust_error_3: ErrorState.DustBinFull,
  clear_water_box_hoare: ErrorState.WaterTankEmpty,
  clear_water_box_exception: ErrorState.WaterTankEmpty,
  dirty_water_box_hoare: ErrorState.DirtyWaterTankFull,
  vibrarise_jammed: ErrorState.Stuck,
};

const VACUUM_ERROR_TEXT: Record<string, string> = {
  strainer_error: 'Filter is wet or blocked',
  compass_error: 'Strong magnetic field detected',
  charging_error: 'Charging error',
  battery_error: 'Battery error',
  fan_error: 'Fan error',
  dock: 'Dock not connected to power',
  vibrarise_jammed: 'VibraRise mop module jammed',
  robot_on_carpet: 'Robot is on carpet',
  filter_blocked: 'Filter blocked',
  internal_error: 'Internal error',
  collect_dust_error_4: 'Auto-empty dock voltage error',
  mopping_roller_1: 'Wash roller may be jammed',
  mopping_roller_error_2: 'Wash roller not lowered properly',
  sink_strainer_hoare: 'Reinstall the water filter',
  clear_brush_exception: 'Check the water filter is installed',
  clear_brush_exception_2: 'Positioning button error',
  filter_screen_exception: 'Clean the dock water filter',
  up_water_exception: 'Water supply error',
  drain_water_exception: 'Drainage error',
  temperature_protection: 'Temperature protection',
  clean_carousel_exception: 'Cleaning tray error',
  clean_carousel_water_full: 'Cleaning tray water full',
  water_carriage_drop: 'Water tank dropped',
  check_clean_carouse: 'Check the cleaning tray',
  audio_error: 'Audio error',
};

const DOCK_ERROR_STANDARD: Record<string, number> = {
  no_dustbin_or_filter: ErrorState.DustBinMissing,
  no_dustbin: ErrorState.DustBinMissing,
  water_empty: ErrorState.WaterTankEmpty,
  waste_water_tank_full: ErrorState.DirtyWaterTankFull,
  dirty_tank_latch_open: ErrorState.DirtyWaterTankMissing,
  // the auto-empty dock cannot evacuate the bin, so it stays full
  duct_blockage: ErrorState.DustBinFull,
};

const DOCK_ERROR_TEXT: Record<string, string> = {
  no_dustbin_or_filter: 'Dust bag or filter missing',
  duct_blockage: 'Dust duct blocked',
  auto_empty_dock_fan_error: 'Auto-empty fan error',
  auto_empty_dock_voltage_error: 'Auto-empty voltage error',
  water_empty: 'Clean water tank empty',
  waste_water_tank_full: 'Dirty water tank full',
  maintenance_brush_jammed: 'Maintenance brush jammed',
  dirty_tank_latch_open: 'Dirty water tank latch open',
  no_dustbin: 'Dust bag missing',
  cleaning_tank_full_or_blocked: 'Cleaning tray full or blocked',
};

/**
 * Every error has to use a standard ErrorState id: matter.js 0.17.9 rejects
 * manufacturer ids (0x80-0xBF) as unknown enum values, so faults without a
 * Matter equivalent become UnableToCompleteOperation with the text in details.
 */
function makeError(id: number, text: string): MatterOperationalError {
  return { errorStateId: id, errorStateDetails: text.slice(0, 64) };
}

/**
 * Homebridge applies struct updates as patches, so the old details text would
 * survive a switch back to NoError unless the key is sent explicitly.
 */
export const NO_ERROR: MatterOperationalError = { errorStateId: ErrorState.NoError, errorStateDetails: undefined };

function humanize(name: string): string {
  const s = name.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function vacuumErrorToMatter(name: string): MatterOperationalError | null {
  if (!name || name === 'none' || name === 'unknown' || name === 'unavailable') {
    return null;
  }
  const text = VACUUM_ERROR_TEXT[name] ?? humanize(name);
  return makeError(VACUUM_ERROR_STANDARD[name] ?? ErrorState.UnableToCompleteOperation, `Roborock: ${text}`);
}

export function dockErrorToMatter(name: string): MatterOperationalError | null {
  if (!name || name === 'ok' || name === 'unknown' || name === 'unavailable') {
    return null;
  }
  const text = DOCK_ERROR_TEXT[name] ?? humanize(name);
  return makeError(DOCK_ERROR_STANDARD[name] ?? ErrorState.UnableToCompleteOperation, `Dock: ${text}`);
}

const OFFLINE_ERROR = makeError(ErrorState.UnableToCompleteOperation, 'Vacuum unreachable');

const MOVING_STATES = new Set<number>([OperationalState.Running, OperationalState.SeekingCharger]);

/**
 * When dock problems become vacuum alerts. Matter forces state=Error for any error
 * and Apple Home then blocks Start and room selection, so by default only water
 * problems are raised, and only while the robot is set to mop, where they matter.
 */
export type DockAlerts = 'mop' | 'always' | 'off';

export interface OperationalOptions {
  dockAlerts: DockAlerts;
}

/** Dock problems that only stop mopping; dust problems don't stop cleaning at all. */
const DOCK_WATER_ERRORS = new Set([
  'water_empty', 'waste_water_tank_full', 'dirty_tank_latch_open', 'cleaning_tank_full_or_blocked',
]);

/** True when the robot's current settings use the mop (so the dock's water tanks are needed). */
function usesMop(s: VacuumSnapshot): boolean {
  if (s.cleaningMode === 'vacuum') {
    return false;
  }
  if (s.cleaningMode === 'mop' || s.cleaningMode === 'vac_and_mop') {
    return true;
  }
  return s.waterMode !== null && s.waterMode !== 'off';
}

function dockAlertApplies(s: VacuumSnapshot, mode: DockAlerts): boolean {
  if (!s.dockError || mode === 'off') {
    return false;
  }
  return mode === 'always' || (DOCK_WATER_ERRORS.has(s.dockError) && usesMop(s));
}

/**
 * Combines state + errors. Matter couples them: a non-NoError error forces
 * OperationalState=Error, so they must always be computed (and pushed) together.
 */
export function deriveOperational(s: VacuumSnapshot, opts: OperationalOptions): OperationalResult {
  if (!s.available) {
    return { operationalState: OperationalState.Error, operationalError: OFFLINE_ERROR };
  }
  const base = baseOperationalState(s);

  if (base === OperationalState.Error) {
    // Only trust error_code while the robot itself says it is in error: Roborock
    // keeps the last error_code around after the user clears the fault.
    const err = (s.vacuumError ? vacuumErrorToMatter(s.vacuumError) : null)
      ?? (s.status === 'device_offline' ? OFFLINE_ERROR : null)
      ?? (s.status === 'charging_problem' ? makeError(ErrorState.UnableToCompleteOperation, 'Charging problem') : null)
      ?? makeError(ErrorState.UnableToCompleteOperation, humanize(s.status ?? 'error'));
    return { operationalState: OperationalState.Error, operationalError: err };
  }

  // A dock problem must not hide Running/Paused mid-job; Roborock reports it again once the job ends.
  if (dockAlertApplies(s, opts.dockAlerts) && !MOVING_STATES.has(base) && !isCleaningJob(s)) {
    const dockErr = dockErrorToMatter(s.dockError!);
    if (dockErr) {
      return { operationalState: OperationalState.Error, operationalError: dockErr };
    }
  }
  return { operationalState: base, operationalError: NO_ERROR };
}

/** RvcRunMode: Cleaning for the whole job (incl. pauses and mid-job mop washes). */
export function isCleaningJob(s: VacuumSnapshot): boolean {
  if (!s.available) {
    return false;
  }
  // The status sensor updates before in_cleaning after a start, so an actively
  // running/paused robot is always in a job; in_cleaning covers mop washes and
  // returning to wash mid-job.
  const base = baseOperationalState(s);
  return base === OperationalState.Running || base === OperationalState.Paused || s.inCleaning === true;
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

export interface BatteryResult {
  batPercentRemaining: number | null;
  batChargeLevel: number;
  batChargeState: number;
}

export function deriveBattery(s: VacuumSnapshot): BatteryResult {
  const pct = s.battery;
  const base = s.available ? baseOperationalState(s) : OperationalState.Stopped;
  let batChargeState: number = BatChargeState.IsNotCharging;
  if (!s.available || pct === null) {
    batChargeState = BatChargeState.Unknown;
  } else if (s.status === 'charging' || (s.charging && pct < 100)) {
    batChargeState = BatChargeState.IsCharging;
  } else if (pct >= 100 && (s.status === 'charging_complete' || base === OperationalState.Docked
    || base === OperationalState.Charging || s.charging)) {
    batChargeState = BatChargeState.IsAtFullCharge;
  }
  let batChargeLevel: number = BatChargeLevel.Ok;
  if (pct !== null && pct <= 10) {
    batChargeLevel = BatChargeLevel.Critical;
  } else if (pct !== null && pct <= 20) {
    batChargeLevel = BatChargeLevel.Warning;
  }
  return {
    batPercentRemaining: pct === null ? null : Math.max(0, Math.min(200, Math.round(pct * 2))),
    batChargeLevel,
    batChargeState,
  };
}

const STATE_NAMES = Object.fromEntries(Object.entries(OperationalState).map(([k, v]) => [v, k]));
const ERROR_NAMES = Object.fromEntries(Object.entries(ErrorState).map(([k, v]) => [v, k]));

/** "Charging", "Error (WaterTankEmpty: Dock: Clean water tank empty)" for the log. */
export function describeOperational(op: OperationalResult): string {
  const state = STATE_NAMES[op.operationalState] ?? String(op.operationalState);
  const { errorStateId, errorStateDetails } = op.operationalError;
  return errorStateId ? `${state} (${ERROR_NAMES[errorStateId] ?? errorStateId}: ${errorStateDetails ?? ''})` : state;
}
