import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCleanModes, deriveCleanMode, planMotorMode } from '../dist/cleanModes.js';
import { CleanModeTag } from '../dist/matterConstants.js';
import { snapshot } from './fixtures.js';

describe('clean modes', () => {
  const s = snapshot();
  const modes = buildCleanModes({
    fanSpeeds: s.fanSpeedList, waterModes: s.waterModeOptions, routes: s.mopRouteOptions, cleaningModes: s.cleaningModeOptions,
  });
  const INTENSITY = [CleanModeTag.Quiet, CleanModeTag.Auto, CleanModeTag.Max];

  it('builds vacuum / vacuum & mop / mop x Quiet/Auto/Max plus Deep Clean', () => {
    assert.deepEqual(modes.map(m => m.mode), [1, 2, 3, 11, 12, 13, 21, 22, 23, 31]);
    assert.equal(new Set(modes.map(m => m.mode)).size, modes.length);
  });

  it('gives every mode a Vacuum or Mop tag and at most one intensity tag', () => {
    for (const m of modes) {
      assert.ok(m.tags.includes(CleanModeTag.Vacuum) || m.tags.includes(CleanModeTag.Mop), m.label);
      assert.ok(m.tags.filter(t => INTENSITY.includes(t)).length <= 1, m.label);
      assert.ok(m.label.length <= 64);
    }
    const deep = modes.find(m => m.mode === 31);
    assert.deepEqual(deep.tags, [CleanModeTag.DeepClean, CleanModeTag.Vacuum, CleanModeTag.Mop]);
    assert.equal(deep.target.route, 'deep_plus');
  });

  it('round-trips: the robot settings of each mode derive back to that mode', () => {
    for (const m of modes) {
      const t = m.target;
      const state = snapshot({
        cleaningMode: t.cleaningMode ?? null, fanSpeed: t.fan ?? 'balanced', waterMode: t.water ?? 'standard', mopRoute: t.route ?? 'standard',
      });
      assert.equal(deriveCleanMode(modes, state), m.mode, m.label);
    }
  });

  it('maps settings made in the Roborock app to the nearest mode', () => {
    assert.equal(deriveCleanMode(modes, snapshot({ cleaningMode: 'vacuum', fanSpeed: 'turbo', waterMode: 'off' })), 3);
    assert.equal(deriveCleanMode(modes, snapshot({ cleaningMode: 'custom', fanSpeed: 'quiet', waterMode: 'intense' })), 11);
  });

  it('prefers the mode Apple last selected while the robot still matches it', () => {
    const state = snapshot({ cleaningMode: 'vac_and_mop', fanSpeed: 'balanced', waterMode: 'standard', mopRoute: 'standard' });
    assert.equal(deriveCleanMode(modes, state, 12), 12);
  });

  it('honours maxFanSpeed = turbo', () => {
    const turbo = buildCleanModes({ fanSpeeds: s.fanSpeedList, waterModes: s.waterModeOptions, routes: [], cleaningModes: [] }, { maxFanSpeed: 'turbo' });
    assert.equal(turbo.find(m => m.mode === 3).target.fan, 'turbo');
  });

  it('handles a robot without a mop', () => {
    const vac = buildCleanModes({ fanSpeeds: ['quiet', 'balanced', 'max'], waterModes: [], routes: [], cleaningModes: [] });
    assert.deepEqual(vac.map(m => m.mode), [1, 2, 3]);
    assert.equal(vac[0].target.water, undefined);
  });
});

describe('one-shot clean mode', () => {
  const s = snapshot({ fanSpeed: 'balanced', waterMode: 'standard', mopRoute: 'standard', cleaningMode: 'vac_and_mop' });

  it('sends nothing when the robot already has the settings', () => {
    assert.equal(planMotorMode({ cleaningMode: 'vac_and_mop', fan: 'balanced', water: 'standard', route: 'standard' }, s).params, null);
  });

  it('switches to vacuum max in one command', () => {
    assert.deepEqual(planMotorMode({ cleaningMode: 'vacuum', fan: 'max', water: 'off' }, s).params,
      [{ fan_power: 104, water_box_mode: 200, mop_mode: 300 }]);
  });

  it('mop only uses suction off (105) and the deep route', () => {
    assert.deepEqual(planMotorMode({ cleaningMode: 'mop', water: 'intense', route: 'deep_plus' }, s).params,
      [{ fan_power: 105, water_box_mode: 203, mop_mode: 303 }]);
  });

  it('falls back to per-setting calls for water-slider robots', () => {
    assert.equal(planMotorMode({ fan: 'max', water: 'off' }, snapshot({ waterModeOptions: ['off', 'slight', 'moderate'] })), undefined);
  });
});
