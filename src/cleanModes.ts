/**
 * Clean modes: the Matter RvcCleanMode list built from what the robot supports,
 * mapping the robot's current settings back to a mode, and turning a mode into
 * a single set_clean_motor_mode command. Pure functions.
 */
import { CleanModeTag } from './matterConstants.js';
import type { VacuumSnapshot } from './vacuumState.js';

export type CleanFamily = 'vacuum' | 'vac_and_mop' | 'mop' | 'deep';
export type CleanLevel = 'quiet' | 'auto' | 'max';

export interface CleanTarget {
  cleaningMode?: string;
  fan?: string;
  water?: string;
  route?: string;
}

export interface CleanModeDef {
  mode: number;
  label: string;
  tags: number[];
  family: CleanFamily;
  level: CleanLevel;
  target: CleanTarget;
}

export interface CleanCapabilities {
  fanSpeeds: string[];
  waterModes: string[];
  routes: string[];
  cleaningModes: string[];
}

export interface CleanPreferences {
  /** Roborock fan speed used for Apple's "Max" intensity (default "max"; "turbo" is the other sensible choice) */
  maxFanSpeed?: string;
}

const FAN_BY_LEVEL: Record<CleanLevel, string[]> = {
  quiet: ['quiet', 'silent'],
  auto: ['balanced', 'standard', 'auto'],
  max: ['max', 'turbo', 'max_plus'],
};
const WATER_BY_LEVEL: Record<CleanLevel, string[]> = {
  quiet: ['mild', 'low', 'slight'],
  auto: ['standard', 'medium', 'moderate'],
  max: ['intense', 'high', 'extreme'],
};
const LEVEL_TAG: Record<CleanLevel, number> = {
  quiet: CleanModeTag.Quiet,
  auto: CleanModeTag.Auto,
  max: CleanModeTag.Max,
};
const LEVEL_LABEL: Record<CleanLevel, string> = { quiet: 'Quiet', auto: 'Auto', max: 'Max' };
const LEVELS: CleanLevel[] = ['quiet', 'auto', 'max'];
const FAMILY_BASE: Record<CleanFamily, number> = { vacuum: 1, vac_and_mop: 11, mop: 21, deep: 31 };

function pick(available: string[], candidates: string[]): string | undefined {
  return candidates.find(c => available.includes(c));
}

const DEEP_ROUTES = ['deep_plus', 'deep'];
const STANDARD_ROUTE = 'standard';

/**
 * Builds the Matter clean-mode list from what the robot supports.
 *
 * Apple Home ignores mode labels and renders tags: the cleaning type comes from
 * Vacuum/Mop/DeepClean and the intensity picker from exactly one of
 * Quiet/Auto/Max per type, so each mode carries one type set + one intensity tag.
 */
export function buildCleanModes(caps: CleanCapabilities, prefs: CleanPreferences = {}): CleanModeDef[] {
  const modes: CleanModeDef[] = [];
  const fanFor = (level: CleanLevel): string | undefined => {
    if (level === 'max' && prefs.maxFanSpeed && caps.fanSpeeds.includes(prefs.maxFanSpeed)) {
      return prefs.maxFanSpeed;
    }
    return pick(caps.fanSpeeds, FAN_BY_LEVEL[level]);
  };
  const waterFor = (level: CleanLevel): string | undefined => pick(caps.waterModes, WATER_BY_LEVEL[level]);
  const hasCleaningMode = (m: string): boolean => caps.cleaningModes.includes(m);
  const canMop = LEVELS.some(l => waterFor(l) !== undefined);
  const standardRoute = caps.routes.includes(STANDARD_ROUTE) ? STANDARD_ROUTE : undefined;

  // Vacuum only: needs a way to turn water off (or a robot without a mop).
  if (!canMop || caps.waterModes.includes('off') || hasCleaningMode('vacuum')) {
    for (const level of LEVELS) {
      const fan = fanFor(level);
      if (!fan) {
        continue;
      }
      modes.push({
        mode: FAMILY_BASE.vacuum + LEVELS.indexOf(level),
        label: `Vacuum ${LEVEL_LABEL[level]}`,
        tags: [CleanModeTag.Vacuum, LEVEL_TAG[level]],
        family: 'vacuum',
        level,
        target: {
          cleaningMode: hasCleaningMode('vacuum') ? 'vacuum' : undefined,
          fan,
          water: canMop ? 'off' : undefined,
        },
      });
    }
  }

  if (canMop) {
    for (const level of LEVELS) {
      const fan = fanFor(level);
      const water = waterFor(level);
      if (!fan || !water) {
        continue;
      }
      modes.push({
        mode: FAMILY_BASE.vac_and_mop + LEVELS.indexOf(level),
        label: `Vacuum & Mop ${LEVEL_LABEL[level]}`,
        tags: [CleanModeTag.Vacuum, CleanModeTag.Mop, LEVEL_TAG[level]],
        family: 'vac_and_mop',
        level,
        target: {
          cleaningMode: hasCleaningMode('vac_and_mop') ? 'vac_and_mop' : undefined,
          fan,
          water,
          route: standardRoute,
        },
      });
    }

    // Mop only: either the robot has a dedicated mop mode or can switch suction off.
    const mopViaCleaningMode = hasCleaningMode('mop');
    const mopViaFanOff = caps.fanSpeeds.includes('off');
    if (mopViaCleaningMode || mopViaFanOff) {
      for (const level of LEVELS) {
        const water = waterFor(level);
        if (!water) {
          continue;
        }
        modes.push({
          mode: FAMILY_BASE.mop + LEVELS.indexOf(level),
          label: `Mop ${LEVEL_LABEL[level]}`,
          tags: [CleanModeTag.Mop, LEVEL_TAG[level]],
          family: 'mop',
          level,
          target: {
            cleaningMode: mopViaCleaningMode ? 'mop' : undefined,
            fan: mopViaCleaningMode ? undefined : 'off',
            water,
            route: standardRoute,
          },
        });
      }
    }

    // Deep clean: vacuum & mop with the slow, overlapping deep mop route.
    const deepRoute = pick(caps.routes, DEEP_ROUTES);
    const fan = fanFor('auto');
    const water = waterFor('auto');
    if (deepRoute && fan && water) {
      modes.push({
        mode: FAMILY_BASE.deep,
        label: 'Deep Clean',
        tags: [CleanModeTag.DeepClean, CleanModeTag.Vacuum, CleanModeTag.Mop],
        family: 'deep',
        level: 'auto',
        target: {
          cleaningMode: hasCleaningMode('vac_and_mop') ? 'vac_and_mop' : undefined,
          fan,
          water,
          route: deepRoute,
        },
      });
    }
  }
  return modes;
}

function levelFromFan(fan: string | null): CleanLevel | null {
  if (!fan) {
    return null;
  }
  if (['quiet', 'silent', 'gentle'].includes(fan)) {
    return 'quiet';
  }
  if (['turbo', 'max', 'max_plus'].includes(fan)) {
    return 'max';
  }
  return 'auto';
}

function levelFromWater(water: string | null): CleanLevel | null {
  for (const level of LEVELS) {
    if (water && WATER_BY_LEVEL[level].includes(water)) {
      return level;
    }
  }
  return water ? 'auto' : null;
}

function targetMatches(target: CleanTarget, s: VacuumSnapshot): boolean {
  return (target.fan === undefined || target.fan === s.fanSpeed)
    && (target.water === undefined || target.water === s.waterMode)
    && (target.route === undefined || target.route === s.mopRoute)
    && (target.cleaningMode === undefined || s.cleaningMode === null || target.cleaningMode === s.cleaningMode);
}

/**
 * Picks the Matter clean mode that best describes the robot's current settings.
 * `preferred` (the last mode Apple selected) wins whenever the robot still matches it,
 * so modes that share settings don't flip-flop in the Home app.
 */
export function deriveCleanMode(modes: CleanModeDef[], s: VacuumSnapshot, preferred?: number): number | null {
  if (modes.length === 0) {
    return null;
  }
  const pref = modes.find(m => m.mode === preferred);
  if (pref && targetMatches(pref.target, s)) {
    return pref.mode;
  }
  const exact = modes.find(m => targetMatches(m.target, s));
  if (exact) {
    return exact.mode;
  }

  let family: CleanFamily;
  if (s.cleaningMode === 'vacuum' || s.waterMode === 'off') {
    family = 'vacuum';
  } else if (s.cleaningMode === 'mop' || s.fanSpeed === 'off') {
    family = 'mop';
  } else {
    family = 'vac_and_mop';
  }
  if (family === 'vac_and_mop' && s.mopRoute && DEEP_ROUTES.includes(s.mopRoute) && modes.some(m => m.family === 'deep')) {
    family = 'deep';
  }
  const level = family === 'mop' ? levelFromWater(s.waterMode) : levelFromFan(s.fanSpeed);
  const inFamily = modes.filter(m => m.family === family);
  return (inFamily.find(m => m.level === level) ?? inFamily.find(m => m.level === 'auto') ?? inFamily[0] ?? modes[0]).mode;
}

// ---------------------------------------------------------------------------
// Applying a mode: one command, one beep
// ---------------------------------------------------------------------------

/** Roborock V1 codes (python-roborock VacuumModes / WaterModes / CleanRoutes). */
const FAN_CODES: Record<string, number> = {
  quiet: 101, balanced: 102, turbo: 103, max: 104, off: 105, gentle: 105, custom: 106, max_plus: 108, smart_mode: 110,
};
const WATER_CODES: Record<string, number> = {
  off: 200, low: 201, mild: 201, medium: 202, standard: 202, high: 203, intense: 203,
  custom: 204, min: 205, max: 206, custom_water_flow: 207, extreme: 208, smart_mode: 209,
};
const ROUTE_CODES: Record<string, number> = {
  standard: 300, deep: 301, custom: 302, deep_plus: 303, fast: 304, smart_mode: 306,
};
/** Robots with a water slider use a different code table for the same names. */
const WATER_SLIDE_NAMES = ['slight', 'moderate'];

export interface MotorModePlan {
  /** params for set_clean_motor_mode, or null when the robot already matches */
  params: Array<Record<string, number>> | null;
  /** human readable fan/water/route that will be in effect */
  summary: string;
}

/**
 * Resolves a clean-mode target into a single set_clean_motor_mode payload, so a
 * mode change costs one command (one beep) instead of one per setting.
 * Returns undefined when the robot's codes are unknown and per-setting calls are needed.
 */
export function planMotorMode(target: CleanTarget, s: VacuumSnapshot): MotorModePlan | undefined {
  if (s.waterModeOptions.some(w => WATER_SLIDE_NAMES.includes(w))) {
    return undefined;
  }
  const fan = target.fan ?? (target.cleaningMode === 'mop' ? 'off' : s.fanSpeed);
  const water = target.water ?? (target.cleaningMode === 'vacuum' ? 'off' : s.waterMode);
  const route = target.route ?? s.mopRoute;
  if (!fan || !water || FAN_CODES[fan] === undefined || WATER_CODES[water] === undefined) {
    return undefined;
  }
  const summary = `suction ${fan}, water ${water}${route ? `, route ${route}` : ''}`;
  if (fan === s.fanSpeed && water === s.waterMode && (route === null || route === s.mopRoute)) {
    return { params: null, summary };
  }
  const params: Record<string, number> = { fan_power: FAN_CODES[fan], water_box_mode: WATER_CODES[water] };
  if (route && ROUTE_CODES[route] !== undefined && s.mopRouteOptions.length > 0) {
    params.mop_mode = ROUTE_CODES[route];
  }
  return { params: [params], summary };
}
