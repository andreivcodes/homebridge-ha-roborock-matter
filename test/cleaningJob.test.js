import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advanceProgress, CleaningJob, JOB_END_GRACE_MS, OPTIMISTIC_MS } from '../dist/cleaningJob.js';
import { AreaOperationalStatus, OperationalState } from '../dist/matterConstants.js';

const { Pending, Operating, Completed } = AreaOperationalStatus;
const ok = state => ({ operationalState: state, operationalError: { errorStateId: 0 } });
const docked = { available: true, status: 'charging', operational: ok(OperationalState.Charging), runCleaning: false, currentArea: null };
const cleaning = (currentArea = null) =>
  ({ available: true, status: 'segment_cleaning', operational: ok(OperationalState.Running), runCleaning: true, currentArea });
const returning = { available: true, status: 'returning_home', operational: ok(OperationalState.SeekingCharger), runCleaning: false, currentArea: null };

describe('CleaningJob', () => {
  it('shows the expected state after a command until HA reports a new status', () => {
    const job = new CleaningJob();
    job.expect(0, 'charging', OperationalState.Running, true);
    const held = job.update(1000, docked);
    assert.equal(held.operational.operationalState, OperationalState.Running);
    assert.equal(held.runCleaning, true);
    assert.equal(held.recheckInMs, OPTIMISTIC_MS - 1000 + 100);

    const real = job.update(3000, cleaning());
    assert.equal(real.operational.operationalState, OperationalState.Running);
    assert.equal(real.recheckInMs, null);
  });

  it('drops the expectation when it times out', () => {
    const job = new CleaningJob();
    job.expect(0, 'charging', OperationalState.Running, true);
    const view = job.update(OPTIMISTIC_MS + 1, docked);
    assert.equal(view.operational.operationalState, OperationalState.Charging);
  });

  it('keeps the job running through a short idle blip (mop wash return)', () => {
    const job = new CleaningJob();
    job.update(0, cleaning());
    const blip = job.update(1000, returning);
    assert.equal(blip.runCleaning, true);
    assert.equal(blip.finished, false);
    assert.equal(blip.recheckInMs, JOB_END_GRACE_MS + 100);
    assert.equal(job.update(5000, cleaning()).runCleaning, true);
    // the grace period restarts after the job resumed
    assert.equal(job.update(6000, returning).recheckInMs, JOB_END_GRACE_MS + 100);
  });

  it('ends the job once the robot stayed idle for the grace period', () => {
    const job = new CleaningJob();
    job.update(0, cleaning());
    job.update(1000, returning);
    const end = job.update(1000 + JOB_END_GRACE_MS, returning);
    assert.equal(end.runCleaning, false);
    assert.equal(end.finished, true);
  });

  it('ends immediately when Apple stopped the job', () => {
    const job = new CleaningJob();
    job.update(0, cleaning());
    job.expect(1000, 'segment_cleaning', OperationalState.SeekingCharger, false);
    const view = job.update(1500, cleaning());
    assert.equal(view.runCleaning, false);
    assert.equal(view.finished, true);
  });

  it('tracks per-room progress for a room clean and clears the selection when done', () => {
    const job = new CleaningJob();
    job.select([17, 16]);
    assert.deepEqual(job.update(0, docked).progress, [{ areaId: 17, status: Pending }, { areaId: 16, status: Pending }]);
    job.started([16, 17]);
    assert.deepEqual(job.update(1000, cleaning(16)).progress.map(p => p.status), [Operating, Pending]);
    assert.deepEqual(job.update(2000, cleaning(17)).progress.map(p => p.status), [Completed, Operating]);

    job.update(3000, returning);
    const end = job.update(3000 + JOB_END_GRACE_MS, returning);
    assert.equal(end.finished, true);
    assert.deepEqual(end.selectedAreas, []);
    assert.deepEqual(end.progress, []);
    assert.equal(end.currentArea, null);
  });

  it('reports no current room while idle', () => {
    const job = new CleaningJob();
    assert.equal(job.update(0, { ...docked, currentArea: 16 }).currentArea, null);
  });

  it('forgets area ids when the rooms change', () => {
    const job = new CleaningJob();
    job.select([16]);
    job.started([16]);
    job.clearAreas();
    assert.deepEqual(job.selectedAreas, []);
    assert.deepEqual(job.update(0, cleaning(16)).progress, []);
  });
});

describe('advanceProgress', () => {
  it('marks the previous room completed when the robot moves on', () => {
    let p = [{ areaId: 16, status: Pending }, { areaId: 17, status: Pending }];
    p = advanceProgress(p, 16);
    assert.deepEqual(p.map(x => x.status), [Operating, Pending]);
    p = advanceProgress(p, 17);
    assert.deepEqual(p.map(x => x.status), [Completed, Operating]);
  });
});
