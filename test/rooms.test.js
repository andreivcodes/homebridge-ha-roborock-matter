import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AreaType } from '../dist/matterConstants.js';
import { areaTypeFor, buildRooms, roomForRoborockName, toSupportedAreas } from '../dist/rooms.js';

describe('rooms', () => {
  it('guesses Apple room icons from names', () => {
    assert.equal(areaTypeFor('Living Room'), AreaType.LivingRoom);
    assert.equal(areaTypeFor('Main Bedroom'), AreaType.PrimaryBedroom);
    assert.equal(areaTypeFor('Guest Bathroom'), AreaType.GuestBathroom);
    assert.equal(areaTypeFor('Downstairs Corridor'), AreaType.Corridor);
    assert.equal(areaTypeFor('Stairs'), AreaType.Staircase);
    assert.equal(areaTypeFor('Front Door'), AreaType.Entrance);
    assert.equal(areaTypeFor('Dressing'), AreaType.DressingRoom);
    assert.equal(areaTypeFor('Kitchen'), AreaType.Kitchen);
    assert.equal(areaTypeFor('Xyzzy'), null);
    assert.equal(areaTypeFor('Xyzzy', { xyzzy: 'Gym' }), AreaType.Gym);
  });

  const segments = [
    { id: '0_16', name: 'Living room', group: 'Ground floor' },
    { id: '0_17', name: 'Kitchen', group: 'Ground floor' },
    { id: '0_18', name: 'Bathroom', group: 'Ground floor' },
    { id: '0_19', name: 'Corridor', group: 'Ground floor' },
    { id: '1_16', name: 'Bedroom', group: 'Upstairs' },
  ];

  it('uses one area per segment of the active map without HA area mapping', () => {
    const rooms = buildRooms({ segments, currentMap: 'Ground floor' });
    assert.deepEqual(rooms.map(r => [r.areaId, r.name]), [[16, 'Living room'], [17, 'Kitchen'], [18, 'Bathroom'], [19, 'Corridor']]);
    const areas = toSupportedAreas(rooms);
    assert.ok(areas.every(a => a.mapId === 1));
    assert.equal(areas[0].areaInfo.locationInfo.areaType, AreaType.LivingRoom);
  });

  it('groups segments by HA area and uses the HA area name', () => {
    const rooms = buildRooms({
      segments,
      currentMap: 'Ground floor',
      areaMapping: { living_room: ['0_16', '0_19'], kitchen: ['0_17'] },
      areaNames: { living_room: 'Living Room', kitchen: 'Kitchen' },
    });
    assert.deepEqual(rooms.map(r => [r.areaId, r.name, r.segments]), [
      [16, 'Living Room', [16, 19]], [17, 'Kitchen', [17]], [18, 'Bathroom', [18]],
    ]);
    assert.equal(roomForRoborockName(rooms, 'Corridor').areaId, 16);
  });

  it('keeps area names unique', () => {
    const rooms = buildRooms({ segments: [{ id: '0_1', name: 'Room' }, { id: '0_2', name: 'Room' }] });
    assert.deepEqual(rooms.map(r => r.name), ['Room', 'Room 2']);
  });
});
