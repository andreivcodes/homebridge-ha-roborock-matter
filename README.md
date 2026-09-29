# homebridge-ha-roborock-matter

A [Homebridge](https://homebridge.io) 2 plugin that puts a Roborock vacuum from the
[Home Assistant Roborock integration](https://www.home-assistant.io/integrations/roborock/)
into Apple Home as a native **Matter robot vacuum**, with rooms, clean modes, dock
states and proper error alerts.

Home Assistant stays the only thing talking to the robot. The plugin reads HA's
Roborock entities over the WebSocket API and translates them to the Matter
robotic-vacuum clusters Apple Home understands, so there is no second Roborock
client competing for the robot's connection.

## What you get in Apple Home

| Apple Home | Backed by |
| --- | --- |
| Start, Pause, Resume, Return to Dock, Play Sound | `vacuum.*` services in HA |
| Room picker with icons, current room, per-room progress | HA vacuum segments, optionally grouped by HA areas |
| Vacuum / Vacuum & Mop / Mop, each Quiet · Auto · Max, plus Deep Clean | suction, water flow and mop route, sent as one command |
| Running, Paused, Returning, Charging, Docked, Emptying dust bin, Washing mop | Roborock status, `in_cleaning`, charging |
| Alerts: brush or wheels jammed, stuck, sensors dirty, dust bin missing/full, water tank empty, dirty water tank full, … | robot and dock error sensors, mapped to standard Matter error codes |
| Battery level and charging state | battery and charging sensors |
| Siri ("vacuum the kitchen"), scenes and automations | standard Apple Home support for Matter vacuums |

## Requirements

- **Homebridge 2.4 or newer with Matter enabled** on the bridge. The vacuum is
  published as its own Matter device with its own pairing code; Apple Home needs
  robot vacuums as standalone Matter devices for rooms and Siri to work.
- **Home Assistant 2026.3 or newer** with the Roborock integration set up and working.
- **Apple home hubs on iOS/tvOS/HomePod software 18.4 or newer** (Matter robot
  vacuum support).
- Node.js 22, 24 or 26.

Developed and tested with a Roborock S7 MaxV (with auto-empty and mop-wash dock).
Other Roborock models that the HA integration exposes the same way should work;
models it treats differently (Q7/Q10, Zeo/Dyad) are untested.

## Install

The plugin isn't on npm yet. Install the packaged release into your Homebridge
directory, for example from the Homebridge UI terminal:

```bash
cd /var/lib/homebridge
npm install https://github.com/andreivcodes/homebridge-ha-roborock-matter/releases/download/v0.3.0/homebridge-ha-roborock-matter-0.3.0.tgz
```

Then restart Homebridge. Pick the tarball of the latest version from the
[releases page](https://github.com/andreivcodes/homebridge-ha-roborock-matter/releases).

## Configure

1. **Create a Home Assistant access token**: HA → your profile → Security →
   Long-lived access tokens. An **admin** user is recommended: HA's API for listing
   the vacuum's rooms is admin-only. With a non-admin token the plugin falls back
   to the `roborock.get_maps` service and works the same.
2. **Add the platform** in the Homebridge UI (plugin settings) or in `config.json`:

```json
{
  "platform": "HaRoborockMatter",
  "name": "HA Roborock Matter",
  "haUrl": "http://homeassistant.local:8123",
  "haToken": "<long-lived access token>",
  "vacuums": [
    { "entityId": "vacuum.roborock_s7_maxv" }
  ]
}
```

3. **Restart Homebridge**, then add the vacuum in the Home app with the pairing
   code shown in the Homebridge UI (Matter accessories) or the Homebridge log.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `haUrl` | required | Home Assistant URL, e.g. `http://homeassistant.local:8123`. |
| `haToken` | required | Long-lived access token (admin user recommended). |
| `vacuums[].entityId` | required | The HA vacuum entity, e.g. `vacuum.roborock_s7_maxv`. |
| `vacuums[].name` | HA device name | Name shown in Apple Home. |
| `vacuums[].dockAlerts` | `mop` | When dock problems appear as alerts: `mop`, `always` or `off`. See [Dock alerts](#dock-alerts). |
| `vacuums[].maxFanSpeed` | `max` | Roborock suction used for Apple's "Max" intensity: `max`, `turbo` or `max_plus`. |
| `vacuums[].roomTypes` | – | Room name → Matter area type, to fix a room icon, e.g. `{ "Den": "FamilyRoom" }`. |
| `vacuums[].entities` | auto | Override an auto-discovered companion entity (only needed if discovery picks the wrong one). |

## How it maps things

### Rooms

Rooms come from the vacuum's segments on the **active Roborock map**. If you
link segments to Home Assistant areas (HA → the vacuum entity's settings), rooms
use your HA area names and several segments can form one room. Room icons are
guessed from the names (living room, kitchen, bathroom, corridor, …) and can be
overridden with `roomTypes`.

Selecting no rooms and pressing Start cleans the whole home. Skipping a room in
the middle of a clean is not supported by Roborock and is rejected.

### Clean modes

Apple Home groups modes by type and shows an intensity picker per type:

| Apple Home | Suction | Water | Mop route |
| --- | --- | --- | --- |
| Vacuum · Quiet / Auto / Max | quiet / balanced / max | off | – |
| Vacuum & Mop · Quiet / Auto / Max | quiet / balanced / max | mild / standard / intense | standard |
| Mop · Quiet / Auto / Max | off | mild / standard / intense | standard |
| Deep Clean | balanced | standard | deep+ |

Apple Home sends the clean mode again before every start. The plugin only sends
it to the robot when something actually changes, and then as a single
`set_clean_motor_mode` command, so the robot doesn't beep once per setting.
Modes the robot doesn't support are left out.

### Dock alerts

Matter has no separate "dock needs attention" alert: any error puts the vacuum
into an error state, and Apple Home then blocks Start and room selection until
it clears. So by default (`dockAlerts: "mop"`), dock problems that stop mopping
(clean water tank empty, dirty water tank full, cleaning tray full) are shown
only while a mop mode is selected. Switch to Vacuum and you can still clean;
refill the tank and the alert goes away. Problems the robot itself runs into
during a clean are always shown.

## Behaviour notes and limitations

- **State lag:** HA polls the robot every 15–30 seconds. After each command the
  plugin shows the expected state right away and asks HA for a fresh poll.
- **One map:** only the active map's rooms are exposed.
- **HA offline:** if HA is unreachable at startup, the vacuum is published from a
  cache so it stays in Apple Home, and it shows as unreachable after a minute
  without HA.
- **Clean mode list:** it is fixed when the vacuum is first published. If the
  robot gains or loses modes (for example after a firmware update), restart
  Homebridge.
- **"Updating…" in the Home app:** a known Apple Home issue with Matter robot
  vacuums. Opening the tile or using "Play Sound" usually refreshes it.

## Development

```bash
npm install
npm run lint
npm test
```

`npm test` builds the plugin and runs the unit tests. `test/fake-ha.mjs` is a
fake Home Assistant WebSocket server that emulates the Roborock integration, for
running the plugin end to end in a local Homebridge:

```bash
node test/fake-ha.mjs 18123            # replays a scripted sequence of robot states
node test/fake-ha.mjs 18123 commands   # the fake robot follows the commands it receives
```

Point a test Homebridge config at `http://127.0.0.1:18123` with the token `test-token`.

## License

MIT
