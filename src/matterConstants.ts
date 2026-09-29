/**
 * Matter enum values used by the RVC clusters.
 *
 * Kept as plain numbers (verified against @matter/types 0.17.9 bundled with
 * Homebridge 2.4) so the mapping code stays pure and unit-testable without
 * loading matter.js.
 */

export const RunModeTag = {
  Idle: 0x4000,
  Cleaning: 0x4001,
  Mapping: 0x4002,
} as const;

export const CleanModeTag = {
  Auto: 0,
  Quick: 1,
  Quiet: 2,
  LowNoise: 3,
  LowEnergy: 4,
  Vacation: 5,
  Min: 6,
  Max: 7,
  Night: 8,
  Day: 9,
  DeepClean: 0x4000,
  Vacuum: 0x4001,
  Mop: 0x4002,
  VacuumThenMop: 0x4003,
} as const;

export const OperationalState = {
  Stopped: 0x00,
  Running: 0x01,
  Paused: 0x02,
  Error: 0x03,
  SeekingCharger: 0x40,
  Charging: 0x41,
  Docked: 0x42,
  EmptyingDustBin: 0x43,
  CleaningMop: 0x44,
  FillingWaterTank: 0x45,
  UpdatingMaps: 0x46,
} as const;

export const ErrorState = {
  NoError: 0x00,
  UnableToStartOrResume: 0x01,
  UnableToCompleteOperation: 0x02,
  CommandInvalidInState: 0x03,
  FailedToFindChargingDock: 0x40,
  Stuck: 0x41,
  DustBinMissing: 0x42,
  DustBinFull: 0x43,
  WaterTankEmpty: 0x44,
  WaterTankMissing: 0x45,
  WaterTankLidOpen: 0x46,
  MopCleaningPadMissing: 0x47,
  LowBattery: 0x48,
  CannotReachTargetArea: 0x49,
  DirtyWaterTankFull: 0x4a,
  DirtyWaterTankMissing: 0x4b,
  WheelsJammed: 0x4c,
  BrushJammed: 0x4d,
  NavigationSensorObscured: 0x4e,
} as const;

export const BatChargeState = {
  Unknown: 0,
  IsCharging: 1,
  IsAtFullCharge: 2,
  IsNotCharging: 3,
} as const;

export const BatChargeLevel = {
  Ok: 0,
  Warning: 1,
  Critical: 2,
} as const;

export const PowerSourceStatus = {
  Unspecified: 0,
  Active: 1,
  Standby: 2,
  Unavailable: 3,
} as const;

export const AreaOperationalStatus = {
  Pending: 0,
  Operating: 1,
  Skipped: 2,
  Completed: 3,
} as const;

/** Matter Common Area Namespace (0x10) tags; drive the room icons in Apple Home. */
export const AreaType = {
  Aisle: 0, Attic: 1, BackDoor: 2, BackYard: 3, Balcony: 4, Ballroom: 5, Bathroom: 6, Bedroom: 7,
  Border: 8, Boxroom: 9, BreakfastRoom: 10, Carport: 11, Cellar: 12, Cloakroom: 13, Closet: 14,
  Conservatory: 15, Corridor: 16, CraftRoom: 17, Cupboard: 18, Deck: 19, Den: 20, Dining: 21,
  DrawingRoom: 22, DressingRoom: 23, Driveway: 24, Elevator: 25, Ensuite: 26, Entrance: 27,
  Entryway: 28, FamilyRoom: 29, Foyer: 30, FrontDoor: 31, FrontYard: 32, GameRoom: 33, Garage: 34,
  GarageDoor: 35, Garden: 36, GardenDoor: 37, GuestBathroom: 38, GuestBedroom: 39, GuestRoom: 41,
  Gym: 42, Hallway: 43, HearthRoom: 44, KidsRoom: 45, KidsBedroom: 46, Kitchen: 47, LaundryRoom: 49,
  Lawn: 50, Library: 51, LivingRoom: 52, Lounge: 53, MediaTvRoom: 54, MudRoom: 55, MusicRoom: 56,
  Nursery: 57, Office: 58, OutdoorKitchen: 59, Outside: 60, Pantry: 61, ParkingLot: 62, Parlor: 63,
  Patio: 64, PlayRoom: 65, PoolRoom: 66, Porch: 67, PrimaryBathroom: 68, PrimaryBedroom: 69,
  Ramp: 70, ReceptionRoom: 71, RecreationRoom: 72, Roof: 74, Sauna: 75, Scullery: 76,
  SewingRoom: 77, Shed: 78, SideDoor: 79, SideYard: 80, SittingRoom: 81, Snug: 82, Spa: 83,
  Staircase: 84, SteamRoom: 85, StorageRoom: 86, Studio: 87, Study: 88, SunRoom: 89,
  SwimmingPool: 90, Terrace: 91, UtilityRoom: 92, Ward: 93, Workshop: 94, Toilet: 95,
} as const;

export type AreaTypeName = keyof typeof AreaType;
