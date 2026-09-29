import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BatChargeState, ErrorState, OperationalState } from '../dist/matterConstants.js';
import {
  baseOperationalState,
  deriveBattery,
  deriveOperational,
  describeOperational,
  dockErrorToMatter,
  isCleaningJob,
  vacuumErrorToMatter,
} from '../dist/vacuumState.js';
import { snapshot } from './fixtures.js';

const STANDARD_ERROR_IDS = new Set(Object.values(ErrorState));

// matter.js only accepts standard ErrorState ids, and ErrorStateLabel only for manufacturer ids.
function assertConformant(err) {
  const id = err.errorStateId;
  assert.ok(STANDARD_ERROR_IDS.has(id), `0x${id.toString(16)} is not a standard Matter RVC error`);
  assert.equal(err.errorStateLabel, undefined, `label not allowed for 0x${id.toString(16)}`);
  assert.ok(!err.errorStateDetails || err.errorStateDetails.length <= 64);
}

const VACUUM_ERRORS = [
  'lidar_blocked', 'bumper_stuck', 'wheels_suspended', 'cliff_sensor_error', 'main_brush_jammed', 'side_brush_jammed',
  'wheels_jammed', 'robot_trapped', 'no_dustbin', 'strainer_error', 'compass_error', 'low_battery', 'charging_error',
  'battery_error', 'wall_sensor_dirty', 'robot_tilted', 'side_brush_error', 'fan_error', 'dock', 'optical_flow_sensor_dirt',
  'vertical_bumper_pressed', 'dock_locator_error', 'return_to_dock_fail', 'nogo_zone_detected', 'visual_sensor', 'light_touch',
  'vibrarise_jammed', 'robot_on_carpet', 'filter_blocked', 'invisible_wall_detected', 'cannot_cross_carpet', 'internal_error',
  'collect_dust_error_3', 'collect_dust_error_4', 'mopping_roller_1', 'mopping_roller_error_2', 'clear_water_box_hoare',
  'dirty_water_box_hoare', 'sink_strainer_hoare', 'clear_water_box_exception', 'clear_brush_exception',
  'clear_brush_exception_2', 'filter_screen_exception', 'up_water_exception', 'drain_water_exception',
  'temperature_protection', 'clean_carousel_exception', 'clean_carousel_water_full', 'water_carriage_drop',
  'check_clean_carouse', 'audio_error', 'something_new',
];
const DOCK_ERRORS = [
  'no_dustbin_or_filter', 'auto_empty_dock_fan_error', 'duct_blockage', 'auto_empty_dock_voltage_error', 'water_empty',
  'waste_water_tank_full', 'maintenance_brush_jammed', 'dirty_tank_latch_open', 'no_dustbin',
  'cleaning_tank_full_or_blocked', 'something_new',
];

describe('errors', () => {
  it('every vacuum error passes Matter conformance', () => {
    for (const name of VACUUM_ERRORS) {
      assertConformant(vacuumErrorToMatter(name));
    }
  });

  it('every dock error passes Matter conformance', () => {
    for (const name of DOCK_ERRORS) {
      assertConformant(dockErrorToMatter(name));
    }
  });

  it('maps common faults to the standard codes Apple localises', () => {
    assert.equal(vacuumErrorToMatter('main_brush_jammed').errorStateId, ErrorState.BrushJammed);
    assert.equal(vacuumErrorToMatter('wheels_jammed').errorStateId, ErrorState.WheelsJammed);
    assert.equal(vacuumErrorToMatter('lidar_blocked').errorStateId, ErrorState.NavigationSensorObscured);
    assert.equal(vacuumErrorToMatter('no_dustbin').errorStateId, ErrorState.DustBinMissing);
    assert.equal(dockErrorToMatter('water_empty').errorStateId, ErrorState.WaterTankEmpty);
    assert.equal(dockErrorToMatter('waste_water_tank_full').errorStateId, ErrorState.DirtyWaterTankFull);
    assert.deepEqual(vacuumErrorToMatter('fan_error'), { errorStateId: ErrorState.UnableToCompleteOperation, errorStateDetails: 'Roborock: Fan error' });
    assert.equal(vacuumErrorToMatter('none'), null);
    assert.equal(dockErrorToMatter('ok'), null);
  });

  it('shows the dock error (e.g. clean water tank empty) while docked but not while cleaning', () => {
    const docked = deriveOperational(snapshot({ dockError: 'water_empty' }), { dockAlerts: 'always' });
    assert.equal(docked.operationalState, OperationalState.Error);
    assert.equal(docked.operationalError.errorStateId, ErrorState.WaterTankEmpty);

    const cleaning = deriveOperational(snapshot({ dockError: 'water_empty', status: 'segment_cleaning', activity: 'cleaning' }), { dockAlerts: 'always' });
    assert.equal(cleaning.operationalState, OperationalState.Running);
    assert.equal(cleaning.operationalError.errorStateId, ErrorState.NoError);
    // explicit undefined clears stale details text in Homebridge's patch-style updates
    assert.ok('errorStateDetails' in cleaning.operationalError);

    const paused = deriveOperational(snapshot({ dockError: 'water_empty', status: 'paused', activity: 'paused', inCleaning: true }), { dockAlerts: 'always' });
    assert.equal(paused.operationalState, OperationalState.Paused);

    const off = deriveOperational(snapshot({ dockError: 'water_empty' }), { dockAlerts: 'off' });
    assert.equal(off.operationalState, OperationalState.Docked);
  });

  it("dockAlerts 'mop' raises water problems only while a mop mode is selected", () => {
    const mop = { dockAlerts: 'mop' };
    const mopping = deriveOperational(snapshot({ dockError: 'water_empty', cleaningMode: 'vac_and_mop', waterMode: 'standard' }), mop);
    assert.equal(mopping.operationalError.errorStateId, ErrorState.WaterTankEmpty);
    const vacuumOnly = deriveOperational(snapshot({ dockError: 'water_empty', cleaningMode: 'vacuum', waterMode: 'off' }), mop);
    assert.equal(vacuumOnly.operationalState, OperationalState.Docked);
    const noCleaningModeEntity = deriveOperational(snapshot({ dockError: 'waste_water_tank_full', cleaningMode: null, waterMode: 'mild' }), mop);
    assert.equal(noCleaningModeEntity.operationalError.errorStateId, ErrorState.DirtyWaterTankFull);
    const dust = deriveOperational(snapshot({ dockError: 'duct_blockage', cleaningMode: 'vac_and_mop' }), mop);
    assert.equal(dust.operationalState, OperationalState.Docked);
  });

  it('ignores a stale error_code once the robot left the error state', () => {
    const r = deriveOperational(snapshot({ status: 'charging', vacuumError: 'main_brush_jammed' }), { dockAlerts: 'always' });
    assert.equal(r.operationalState, OperationalState.Charging);
    assert.equal(r.operationalError.errorStateId, ErrorState.NoError);
  });

  it('reports the robot error while in the error state', () => {
    const r = deriveOperational(snapshot({ status: 'error', activity: 'error', vacuumError: 'robot_trapped' }), { dockAlerts: 'always' });
    assert.equal(r.operationalState, OperationalState.Error);
    assert.equal(r.operationalError.errorStateId, ErrorState.Stuck);
  });

  it('reports HA/vacuum unavailability as a conformant error', () => {
    const r = deriveOperational(snapshot({ available: false }), { dockAlerts: 'always' });
    assert.equal(r.operationalState, OperationalState.Error);
    assertConformant(r.operationalError);
  });
});

describe('operational state', () => {
  const cases = [
    [{ status: 'segment_cleaning' }, OperationalState.Running],
    [{ status: 'zoned_cleaning' }, OperationalState.Running],
    [{ status: 'paused' }, OperationalState.Paused],
    [{ status: 'returning_home' }, OperationalState.SeekingCharger],
    [{ status: 'going_to_wash_the_mop' }, OperationalState.SeekingCharger],
    [{ status: 'charging' }, OperationalState.Charging],
    [{ status: 'charging_complete' }, OperationalState.Docked],
    [{ status: 'emptying_the_bin' }, OperationalState.EmptyingDustBin],
    [{ status: 'washing_the_mop' }, OperationalState.CleaningMop],
    [{ status: 'idle', charging: true }, OperationalState.Charging],
    [{ status: 'idle', activity: 'docked' }, OperationalState.Docked],
    [{ status: 'idle', activity: 'idle' }, OperationalState.Stopped],
    [{ status: null, activity: 'returning' }, OperationalState.SeekingCharger],
  ];
  for (const [over, expected] of cases) {
    it(`${JSON.stringify(over)} -> 0x${expected.toString(16)}`, () => {
      assert.equal(baseOperationalState(snapshot(over)), expected);
    });
  }

  it('keeps the run mode on Cleaning through a mid-job mop wash', () => {
    assert.equal(isCleaningJob(snapshot({ status: 'washing_the_mop', inCleaning: true })), true);
    assert.equal(isCleaningJob(snapshot({ status: 'returning_home', inCleaning: false })), false);
    assert.equal(isCleaningJob(snapshot({ status: 'paused', inCleaning: null })), true);
    // status flips to cleaning before HA's in_cleaning sensor catches up
    assert.equal(isCleaningJob(snapshot({ status: 'segment_cleaning', activity: 'cleaning', inCleaning: false })), true);
  });
});

describe('battery', () => {
  it('reports half-percent units and charge state', () => {
    assert.deepEqual(deriveBattery(snapshot({ battery: 57, status: 'charging' })),
      { batPercentRemaining: 114, batChargeLevel: 0, batChargeState: BatChargeState.IsCharging });
    assert.equal(deriveBattery(snapshot({ battery: 100 })).batChargeState, BatChargeState.IsAtFullCharge);
    assert.equal(deriveBattery(snapshot({ battery: 60, status: 'segment_cleaning', activity: 'cleaning' })).batChargeState, BatChargeState.IsNotCharging);
    assert.equal(deriveBattery(snapshot({ battery: 15, status: 'cleaning' })).batChargeLevel, 1);
    assert.equal(deriveBattery(snapshot({ battery: 5, status: 'cleaning' })).batChargeLevel, 2);
  });
});

describe('describeOperational', () => {
  it('names the state and error for the log', () => {
    assert.equal(describeOperational({ operationalState: OperationalState.Charging, operationalError: { errorStateId: 0 } }), 'Charging');
    assert.equal(describeOperational(deriveOperational(snapshot({ dockError: 'water_empty' }), { dockAlerts: 'always' })),
      'Error (WaterTankEmpty: Dock: Clean water tank empty)');
  });
});
