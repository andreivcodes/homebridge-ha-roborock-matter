/**
 * Rooms: turns Home Assistant's vacuum segments (+ optional segment-to-area
 * mapping) into Matter ServiceArea areas.
 */
import { AreaType, type AreaTypeName } from './matterConstants.js';

/** One entry of HA's `vacuum/get_segments`: id is "<mapFlag>_<segmentId>" for Roborock. */
export interface HaSegment {
  id: string;
  name: string;
  group?: string | null;
}

export interface Room {
  /** Matter areaId; the (lowest) Roborock segment id so it is stable across restarts */
  areaId: number;
  name: string;
  /** Roborock segment ids to clean for this room */
  segments: number[];
  /** Roborock room names that belong to this room (for current-room tracking) */
  segmentNames: string[];
  areaType: number | null;
}

export interface RoomInputs {
  segments: HaSegment[];
  /** HA entity-registry option vacuum.area_mapping: HA area id -> segment ids */
  areaMapping?: Record<string, string[]> | null;
  /** HA area id -> area name */
  areaNames?: Record<string, string>;
  /** Only segments of this map (segment group) are exposed; null = all */
  currentMap?: string | null;
  /** user overrides: room name (case-insensitive) -> AreaType tag name */
  roomTypes?: Record<string, string>;
}

function parseSegmentId(id: string): number | null {
  const last = id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id;
  const n = Number.parseInt(last, 10);
  return Number.isFinite(n) ? n : null;
}

const AREA_TYPE_RULES: Array<[RegExp, AreaTypeName]> = [
  [/guest.*bath|bath.*guest/, 'GuestBathroom'],
  [/guest.*bed|bed.*guest|guest ?room/, 'GuestBedroom'],
  [/(main|master|primary|parents?).*bath/, 'PrimaryBathroom'],
  [/(main|master|primary|parents?).*bed/, 'PrimaryBedroom'],
  [/kid|child/, 'KidsRoom'],
  [/nursery|baby/, 'Nursery'],
  [/toilet|\bwc\b|restroom|powder/, 'Toilet'],
  [/bath|shower/, 'Bathroom'],
  [/ensuite|en-suite/, 'Ensuite'],
  [/bed|sleep/, 'Bedroom'],
  [/living|lounge|sitting/, 'LivingRoom'],
  [/kitchen/, 'Kitchen'],
  [/dining|dinner/, 'Dining'],
  [/office|work ?room/, 'Office'],
  [/study/, 'Study'],
  [/corridor/, 'Corridor'],
  [/hall/, 'Hallway'],
  [/stair/, 'Staircase'],
  [/foyer/, 'Foyer'],
  [/entr|front door|vestibule|mud/, 'Entrance'],
  [/dress|wardrobe/, 'DressingRoom'],
  [/closet/, 'Closet'],
  [/laundry|washing/, 'LaundryRoom'],
  [/utility/, 'UtilityRoom'],
  [/pantry/, 'Pantry'],
  [/storage|store ?room/, 'StorageRoom'],
  [/garage/, 'Garage'],
  [/patio/, 'Patio'],
  [/terrace/, 'Terrace'],
  [/balcon/, 'Balcony'],
  [/porch/, 'Porch'],
  [/gym|fitness/, 'Gym'],
  [/play/, 'PlayRoom'],
  [/game/, 'GameRoom'],
  [/family/, 'FamilyRoom'],
  [/\bden\b/, 'Den'],
  [/library/, 'Library'],
  [/attic|loft/, 'Attic'],
  [/cellar|basement/, 'Cellar'],
  [/sun ?room/, 'SunRoom'],
  [/workshop/, 'Workshop'],
  [/studio/, 'Studio'],
  [/(tv|media|cinema)/, 'MediaTvRoom'],
];

export function areaTypeFor(name: string, overrides: Record<string, string> = {}): number | null {
  const lower = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(overrides)) {
    if (key.trim().toLowerCase() === lower && value in AreaType) {
      return AreaType[value as AreaTypeName];
    }
  }
  for (const [pattern, type] of AREA_TYPE_RULES) {
    if (pattern.test(lower)) {
      return AreaType[type];
    }
  }
  return null;
}

export function buildRooms(input: RoomInputs): Room[] {
  const segs = input.segments
    .filter(s => !input.currentMap || !s.group || s.group === input.currentMap)
    .map(s => ({ key: s.id, id: parseSegmentId(s.id), name: s.name }))
    .filter((s): s is { key: string; id: number; name: string } => s.id !== null);

  const byKey = new Map(segs.map(s => [s.key, s]));
  const used = new Set<string>();
  const rooms: Room[] = [];

  for (const [areaId, segmentKeys] of Object.entries(input.areaMapping ?? {})) {
    const members = (segmentKeys ?? [])
      .map(k => byKey.get(k))
      .filter((s): s is { key: string; id: number; name: string } => s !== undefined && !used.has(s.key));
    if (members.length === 0) {
      continue;
    }
    members.forEach(m => used.add(m.key));
    const ids = members.map(m => m.id).sort((a, b) => a - b);
    rooms.push({
      areaId: ids[0],
      name: input.areaNames?.[areaId] ?? members[0].name,
      segments: ids,
      segmentNames: members.map(m => m.name),
      areaType: null,
    });
  }
  for (const s of segs) {
    if (!used.has(s.key)) {
      rooms.push({ areaId: s.id, name: s.name, segments: [s.id], segmentNames: [s.name], areaType: null });
    }
  }

  // Matter requires unique area info per map.
  const seen = new Map<string, number>();
  for (const room of rooms) {
    const base = room.name.trim() || `Room ${room.areaId}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    room.name = (count > 1 ? `${base} ${count}` : base).slice(0, 128);
    room.areaType = areaTypeFor(base, input.roomTypes);
  }
  return rooms.sort((a, b) => a.areaId - b.areaId);
}

/**
 * The single Matter map we publish. matter.js' ServiceArea server needs the Maps
 * feature, and Apple Home shows no rooms when SupportedMaps is empty, so the
 * active Roborock map is always published as map 1.
 */
export const MAP_ID = 1;

export function toSupportedMaps(mapName: string | null) {
  return [{ mapId: MAP_ID, name: (mapName?.trim() || 'Home').slice(0, 64) }];
}

/** Matter ServiceArea.supportedAreas, all on MAP_ID. */
export function toSupportedAreas(rooms: Room[]) {
  return rooms.map(r => ({
    areaId: r.areaId,
    mapId: MAP_ID,
    areaInfo: {
      locationInfo: { locationName: r.name, floorNumber: null, areaType: r.areaType },
      landmarkInfo: null,
    },
  }));
}

export function roomForRoborockName(rooms: Room[], roborockRoom: string | null): Room | null {
  if (!roborockRoom) {
    return null;
  }
  const lower = roborockRoom.toLowerCase();
  return rooms.find(r => r.segmentNames.some(n => n.toLowerCase() === lower))
    ?? rooms.find(r => r.name.toLowerCase() === lower)
    ?? null;
}
