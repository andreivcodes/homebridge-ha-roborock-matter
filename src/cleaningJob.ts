/**
 * The cleaning job as Apple Home sees it: room selection, per-room progress,
 * and when a job starts and ends.
 *
 * HA polls the robot every 15-30 s and its sensors don't all update together,
 * so the raw state is smoothed in two ways:
 * - after a command, the expected state is shown until HA reports something new;
 * - a job only ends after the robot has looked idle for JOB_END_GRACE_MS
 *   (in_cleaning briefly drops while the robot returns to wash its mop),
 *   unless Apple itself stopped the job.
 *
 * Time is passed in, so the whole state machine is unit-testable.
 */
import { AreaOperationalStatus } from './matterConstants.js';
import { NO_ERROR, type OperationalResult } from './vacuumState.js';

export interface AreaProgress {
  areaId: number;
  status: number;
}

export const OPTIMISTIC_MS = 20_000;
export const JOB_END_GRACE_MS = 30_000;

interface Expectation {
  until: number;
  /** HA status when the command was sent; the expectation ends as soon as HA reports something new */
  status: string | null;
  operationalState?: number;
  runCleaning?: boolean;
}

export interface JobInput {
  available: boolean;
  status: string | null;
  operational: OperationalResult;
  runCleaning: boolean;
  /** the room the robot is in, if known */
  currentArea: number | null;
}

export interface JobView {
  operational: OperationalResult;
  runCleaning: boolean;
  selectedAreas: number[];
  currentArea: number | null;
  progress: AreaProgress[];
  /** set on the update where the job ended */
  finished: boolean;
  /** call update() again after this many ms (an expectation or grace period is running out) */
  recheckInMs: number | null;
}

const pending = (areas: number[]): AreaProgress[] => areas.map(areaId => ({ areaId, status: AreaOperationalStatus.Pending }));

/**
 * Advances ServiceArea progress when the robot moves into a new room:
 * the previous Operating room becomes Completed, the new one Operating.
 */
export function advanceProgress(progress: AreaProgress[], currentArea: number | null): AreaProgress[] {
  return progress.map(p => {
    if (p.areaId === currentArea) {
      return { ...p, status: AreaOperationalStatus.Operating };
    }
    if (p.status === AreaOperationalStatus.Operating) {
      return { ...p, status: AreaOperationalStatus.Completed };
    }
    return p;
  });
}

export class CleaningJob {
  private selected: number[] = [];
  /** rooms of the job we started, null for a whole-home or externally started job */
  private jobAreas: number[] | null = null;
  private progress: AreaProgress[] = [];
  private active = false;
  private idleSince: number | null = null;
  /** Apple stopped the job or sent the robot home: end it without the grace period */
  private endRequested = false;
  private expectation: Expectation | null = null;

  get isActive(): boolean {
    return this.active;
  }

  get selectedAreas(): number[] {
    return this.selected;
  }

  /** Apple's room selection (empty = whole home). Resets progress to Pending. */
  select(areas: number[]): void {
    this.selected = areas;
    this.progress = pending(areas);
  }

  /** A clean was started for these rooms (null = whole home). */
  started(areas: number[] | null): void {
    this.jobAreas = areas;
  }

  /** Rooms changed: every stored area id may be invalid. */
  clearAreas(): void {
    this.selected = [];
    this.progress = [];
    this.jobAreas = null;
  }

  /** Show the state a command should produce until HA reports a new status. */
  expect(now: number, status: string | null, operationalState: number | undefined, runCleaning?: boolean): void {
    if (runCleaning === false) {
      this.endRequested = true;
    }
    this.expectation = { until: now + OPTIMISTIC_MS, status, operationalState, runCleaning };
  }

  update(now: number, input: JobInput): JobView {
    let { operational, runCleaning } = input;
    let recheckInMs: number | null = null;
    const recheck = (ms: number) => {
      recheckInMs = Math.min(recheckInMs ?? Infinity, ms + 100);
    };

    const exp = this.expectation;
    if (exp) {
      if (input.available && now < exp.until && input.status === exp.status) {
        if (exp.operationalState !== undefined) {
          operational = { operationalState: exp.operationalState, operationalError: NO_ERROR };
        }
        runCleaning = exp.runCleaning ?? runCleaning;
        recheck(exp.until - now);
      } else {
        this.expectation = null;
      }
    }

    if (runCleaning) {
      this.idleSince = null;
    } else if (this.active && !this.endRequested) {
      this.idleSince ??= now;
      const remaining = JOB_END_GRACE_MS - (now - this.idleSince);
      if (remaining > 0) {
        runCleaning = true;
        recheck(remaining);
      }
    }

    let finished = false;
    if (runCleaning && !this.active) {
      this.endRequested = false;
      this.progress = pending(this.jobAreas ?? []);
    } else if (!runCleaning && this.active) {
      finished = true;
      this.idleSince = null;
      this.endRequested = false;
      // The next "Start" without a room selection must mean the whole home.
      this.clearAreas();
    }
    this.active = runCleaning;

    const currentArea = runCleaning ? input.currentArea : null;
    if (runCleaning && this.progress.length > 0) {
      this.progress = advanceProgress(this.progress, currentArea);
    }
    return { operational, runCleaning, selectedAreas: this.selected, currentArea, progress: this.progress, finished, recheckInMs };
  }
}
