/**
 * Fake Home Assistant WebSocket API emulating the Roborock integration's
 * entities for an S7 MaxV, for end-to-end runs in a local Homebridge.
 *
 *   node test/fake-ha.mjs [port]            # scripted scenario cycling through states
 *   node test/fake-ha.mjs [port] commands   # robot reacts to service calls instead
 */
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 18123);
const V = 'vacuum.roborock_s7_maxv';
const DEV = 'dev_vac';
const DOCK = 'dev_dock';
const DUID = 'FAKEDUID0000000000000';

const reg = (entity_id, device_id, unique_id, translation_key = null, options = {}) =>
  ({ entity_id, device_id, platform: 'roborock', unique_id, translation_key, disabled_by: null, options });

const registry = [
  reg(V, DEV, 'abc', null, { vacuum: { area_mapping: { living_room: ['0_16'], kitchen: ['0_17'], downstairs_hallway: ['0_19'] } } }),
  reg('sensor.roborock_s7_maxv_status', DEV, 'status_abc', 'status'),
  reg('sensor.roborock_s7_maxv_vacuum_error', DEV, 'vacuum_error_abc', 'vacuum_error'),
  reg('sensor.roborock_s7_maxv_dock_dock_error', DOCK, 'dock_error_abc', 'dock_error'),
  reg('sensor.roborock_s7_maxv_battery', DEV, 'battery_abc'),
  reg('binary_sensor.roborock_s7_maxv_charging', DEV, 'battery_charging_abc'),
  reg('binary_sensor.roborock_s7_maxv_cleaning', DEV, 'in_cleaning_abc', 'in_cleaning'),
  reg('sensor.roborock_s7_maxv_current_room', DEV, 'current_room_abc', 'current_room'),
  reg('select.roborock_s7_maxv_cleaning_mode', DEV, 'cleaning_mode_abc', 'cleaning_mode'),
  reg('select.roborock_s7_maxv_mop_intensity', DEV, 'water_box_mode_abc', 'mop_intensity'),
  reg('select.roborock_s7_maxv_mop_mode', DEV, 'mop_mode_abc', 'mop_mode'),
  reg('select.roborock_s7_maxv_selected_map', DEV, 'selected_map_abc', 'selected_map'),
];
const devices = [
  {
    id: DEV, name: 'Roborock S7 MaxV', manufacturer: 'Roborock', model: 'roborock.vacuum.a27', sw_version: '02.59.36',
    identifiers: [['roborock', DUID]], via_device_id: null,
  },
  // Like the real integration, the dock is only linked through its "<duid>_dock" identifier.
  {
    id: DOCK, name: 'Roborock S7 MaxV Dock', manufacturer: 'Roborock', model: 'roborock.vacuum.a27 Dock', sw_version: '02.59.36',
    identifiers: [['roborock', `${DUID}_dock`]], via_device_id: null,
  },
];

const states = {
  [V]: { s: 'docked', a: { fan_speed: 'balanced', fan_speed_list: ['quiet', 'balanced', 'turbo', 'max', 'gentle', 'custom'] } },
  'sensor.roborock_s7_maxv_status': { s: 'charging_complete', a: {} },
  'sensor.roborock_s7_maxv_vacuum_error': { s: 'none', a: {} },
  'sensor.roborock_s7_maxv_dock_dock_error': { s: 'water_empty', a: {} },
  'sensor.roborock_s7_maxv_battery': { s: '100', a: {} },
  'binary_sensor.roborock_s7_maxv_charging': { s: 'off', a: {} },
  'binary_sensor.roborock_s7_maxv_cleaning': { s: 'off', a: {} },
  'sensor.roborock_s7_maxv_current_room': { s: 'unknown', a: { options: ['Living room', 'Kitchen', 'Corridor'] } },
  'select.roborock_s7_maxv_cleaning_mode': { s: 'vac_and_mop', a: { options: ['vacuum', 'vac_and_mop', 'mop', 'custom'] } },
  'select.roborock_s7_maxv_mop_intensity': { s: 'standard', a: { options: ['off', 'mild', 'standard', 'intense', 'custom'] } },
  'select.roborock_s7_maxv_mop_mode': { s: 'standard', a: { options: ['standard', 'deep', 'deep_plus', 'fast', 'custom'] } },
  'select.roborock_s7_maxv_selected_map': { s: 'Ground floor', a: { options: ['Ground floor'] } },
};

const subs = new Set();
function set(entity, s, a) {
  states[entity] = { s: s ?? states[entity].s, a: { ...states[entity].a, ...(a ?? {}) } };
  for (const { ws, id, ids } of subs) {
    if (ids.includes(entity)) {
      ws.send(JSON.stringify({ id, type: 'event', event: { c: { [entity]: { '+': { s: states[entity].s, a: a ?? {} } } } } }));
    }
  }
  console.log(`[fake-ha] ${entity} = ${states[entity].s}`);
}

const scenario = [
  ['dock error cleared', () => set('sensor.roborock_s7_maxv_dock_dock_error', 'ok')],
  ['start segment clean', () => {
    set('sensor.roborock_s7_maxv_status', 'segment_cleaning');
    set(V, 'cleaning');
    set('binary_sensor.roborock_s7_maxv_cleaning', 'on');
    set('sensor.roborock_s7_maxv_battery', '97');
  }],
  ['in living room', () => set('sensor.roborock_s7_maxv_current_room', 'Living room')],
  ['in kitchen', () => set('sensor.roborock_s7_maxv_current_room', 'Kitchen')],
  ['mop wash mid-job', () => set('sensor.roborock_s7_maxv_status', 'washing_the_mop')],
  ['back cleaning', () => set('sensor.roborock_s7_maxv_status', 'segment_cleaning')],
  ['brush jammed', () => {
    set('sensor.roborock_s7_maxv_status', 'error');
    set(V, 'error');
    set('sensor.roborock_s7_maxv_vacuum_error', 'main_brush_jammed');
  }],
  ['vibrarise jammed (manufacturer code)', () => set('sensor.roborock_s7_maxv_vacuum_error', 'vibrarise_jammed')],
  ['recovered, paused', () => { set('sensor.roborock_s7_maxv_status', 'paused'); set(V, 'paused'); }],
  ['returning', () => { set('sensor.roborock_s7_maxv_status', 'returning_home'); set(V, 'returning'); set('binary_sensor.roborock_s7_maxv_cleaning', 'off'); }],
  ['emptying bin', () => { set('sensor.roborock_s7_maxv_status', 'emptying_the_bin'); set(V, 'docked'); }],
  ['charging (stale error code)', () => { set('sensor.roborock_s7_maxv_status', 'charging'); set('binary_sensor.roborock_s7_maxv_charging', 'on'); }],
  ['dirty tank full', () => set('sensor.roborock_s7_maxv_dock_dock_error', 'waste_water_tank_full')],
  ['duct blocked (manufacturer dock code)', () => set('sensor.roborock_s7_maxv_dock_dock_error', 'duct_blockage')],
  ['rooms edited in app', () => {
    segments.push({ id: '0_18', name: 'Bathroom', group: 'Ground floor' });
    set('sensor.roborock_s7_maxv_current_room', null, { options: ['Living room', 'Kitchen', 'Bathroom', 'Corridor'] });
  }],
  ['fan changed in app', () => set(V, null, { fan_speed: 'turbo' })],
];

const segments = [
  { id: '0_16', name: 'Living room', group: 'Ground floor' },
  { id: '0_17', name: 'Kitchen', group: 'Ground floor' },
  { id: '0_19', name: 'Corridor', group: 'Ground floor' },
];

const wss = new WebSocketServer({ port, path: '/api/websocket' });
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'auth_required' }));
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    const ok = result => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
    switch (m.type) {
      case 'auth': ws.send(JSON.stringify({ type: m.access_token === 'test-token' ? 'auth_ok' : 'auth_invalid', ha_version: '2026.9.4' })); return;
      case 'ping': ws.send(JSON.stringify({ id: m.id, type: 'pong' })); return;
      case 'config/entity_registry/list_for_display':
        return ok({
          entity_categories: {},
          entities: registry.map(e => ({ ei: e.entity_id, pl: e.platform, di: e.device_id, tk: e.translation_key ?? undefined })),
        });
      case 'config/entity_registry/get_entries':
        return ok(Object.fromEntries(m.entity_ids.map(id => [id, registry.find(e => e.entity_id === id) ?? null])));
      case 'config/device_registry/list': return ok(devices);
      case 'config/entity_registry/get': return ok(registry.find(e => e.entity_id === m.entity_id));
      case 'config/area_registry/list':
        return ok([
          { area_id: 'living_room', name: 'Living Room' },
          { area_id: 'kitchen', name: 'Kitchen' },
          { area_id: 'downstairs_hallway', name: 'Downstairs Corridor' },
        ]);
      case 'vacuum/get_segments': return ok({ segments });
      case 'subscribe_entities': {
        ok(null);
        subs.add({ ws, id: m.id, ids: m.entity_ids });
        const a = Object.fromEntries(m.entity_ids.filter(e => states[e]).map(e => [e, states[e]]));
        ws.send(JSON.stringify({ id: m.id, type: 'event', event: { a } }));
        return;
      }
      case 'unsubscribe_events':
        for (const s of subs) {if (s.id === m.subscription) {subs.delete(s);}}
        return ok(null);
      case 'call_service':
        console.log(`[fake-ha] SERVICE ${m.domain}.${m.service} ${JSON.stringify(m.service_data)} ${JSON.stringify(m.target)}`);
        if (interactive) {
          setTimeout(() => react(m), 1000);
        }
        return ok({ context: {} });
      default:
        ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command', message: m.type } }));
    }
  });
  ws.on('close', () => { for (const s of subs) {if (s.ws === ws) {subs.delete(s);}} });
});
console.log(`[fake-ha] listening on ${port}`);

const interactive = process.argv[3] === 'commands';

/** Minimal robot: follows the commands the plugin sends through HA. */
function react({ domain, service, service_data: data, target }) {
  const robot = (status, activity, inCleaning) => {
    set('sensor.roborock_s7_maxv_status', status);
    set(V, activity);
    if (inCleaning !== undefined) {
      set('binary_sensor.roborock_s7_maxv_cleaning', inCleaning ? 'on' : 'off');
    }
    set('binary_sensor.roborock_s7_maxv_charging', 'off');
  };
  if (domain === 'vacuum') {
    if (service === 'send_command' && data.command === 'app_segment_clean') {robot('segment_cleaning', 'cleaning', true);}
    if (service === 'send_command' && data.command === 'app_start') {robot('cleaning', 'cleaning', true);}
    if (service === 'start') {robot('cleaning', 'cleaning', true);}
    if (service === 'pause') {robot('paused', 'paused');}
    if (service === 'stop') {robot('idle', 'idle', false);}
    if (service === 'return_to_base') {robot('returning_home', 'returning', false);}
    if (service === 'set_fan_speed') {set(V, null, { fan_speed: data.fan_speed });}
  }
  if (domain === 'select' && service === 'select_option') {
    set(target.entity_id, data.option);
  }
}

let step = interactive ? scenario.length : 0;
setTimeout(function next() {
  if (step < scenario.length) {
    const [label, fn] = scenario[step++];
    console.log(`[fake-ha] --- step ${step}: ${label}`);
    fn();
    setTimeout(next, 3000);
  } else {
    console.log('[fake-ha] --- scenario done');
  }
}, 25000);
