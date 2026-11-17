# The .DC harness file format (version 1)

DC Wiring stores each harness as one pretty-printed JSON file (tabs) ending in `.DC`. Part libraries use the same format with the extension `.DClib`; they hold only `parts`. The JSON Schema is [`harness.schema.json`](harness.schema.json) next to this file.

This guide is for people and AI agents who edit files by hand or generate them. Obsidian reloads an open harness when its file changes on disk.

**Stability promise.** From plugin 1.0 on, every file that follows this guide keeps opening in later 1.x versions. New fields may be added; existing ones keep their meaning.

## A small example

```json
{
	"version": 1,
	"components": [
		{ "id": "C1", "kind": "connector", "name": "ECU", "x": 0, "y": 0, "pins": 4, "signals": { "1": "+12V" }, "partId": "P1" },
		{ "id": "S1", "kind": "splice", "name": "S1", "x": 300, "y": 40, "pins": 1 }
	],
	"wires": [
		{ "id": "W1", "from": { "c": "C1", "pin": 1 }, "to": { "c": "S1", "pin": 1 }, "color": "rd/ws", "gauge": "1.5", "length": 800, "partId": "P2" }
	],
	"parts": [
		{ "id": "P1", "number": "DT04-4P", "manufacturer": "TE", "description": "", "price": 2.1, "type": "connector", "cavities": 4 },
		{ "id": "P2", "number": "FLRY 1.5", "manufacturer": "", "description": "", "price": 0.4, "type": "wire", "gauge": "1.5" }
	]
}
```

## General rules

- `version` is always `1`.
- **Keep fields you don't understand.** The plugin keeps them when it saves, so other tools can add their own.
- **Units.**
  - Lengths are millimetres.
  - Positions are canvas units on a 20-unit grid.
  - Prices are a plain number; `currency` is only the symbol shown.
- **Ids are unique and never renumbered,** because other files and wires refer to them. A deleted id can be used again by the next new thing of that kind. Each kind of thing has a prefix:

  | Prefix | Used for |
  |---|---|
  | `C` | connector |
  | `S` | splice |
  | `T` | terminal |
  | `D` | diode |
  | `R` | resistor |
  | `N` | note |
  | `CB` | cable |
  | `H` | sub-harness block |
  | `W` | wire |
  | `P` | part |
  | `G` | group |
  | `I` | image |
  | `B` | bundle |
  | `BP` | branch point |
  | `TW` | twist group |

- **Making a new id.** Take the lowest number not in use for that prefix, so a deleted id is used again. When you delete something, also remove references to its id (wire ends, group members, bundle ends, mates).
- **Files that open read-only.** A file the plugin can't draw opens read-only with the reason shown, and nothing is lost. This happens for:
  - a missing id
  - a wire end on a component or pin that doesn't exist
  - a bundle without both ends
  - a malformed `coverings` or `contacts`

## Top level

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `components`, `wires`, `parts` | Lists, see below. Missing lists are read as empty. |
| `bundles`, `branchPoints` | Layout view: how wires run physically. |
| `groups`, `images`, `mates` | Frames around components, pictures on the canvas, mated connector pairs. |
| `currency` | Symbol shown with prices, e.g. `"€"`. |
| `lengthUnit` | Unit lengths are shown in: `mm`, `cm`, `m`, `in`, `ft`, `yd`. Stored values stay in mm. |
| `gaugeUnit` | Unit of gauges typed as a plain number: `mm²` (default), `AWG`, `cmil`, `kcmil`. |
| `voltage` | Supply voltage in V, used for voltage drop percentages. `12` when unset. |
| `maxDrop` | Allowed voltage drop per wire, in % of `voltage`. `5` when unset. |
| `hideWireIds` | `true`: don't label unnamed wires with their id on the canvas. |
| `seq` | Before 1.3: last id number handed out per prefix. Ignored now, and dropped when the plugin next makes an id. |
| `export` | Title block of exported drawings: `company`, `title`, `drawing`, `date`, `drawnBy`, `notes`. |

## Components

Every component has `id`, `kind`, `name`, `x`, `y` (top-left on the Schematic) and `pins`. `kind` is one of:

| Kind | Pins | Notes |
|---|---|---|
| `connector` | any (≥ 1) | Optional `layout: {rows, cols}` draws a pin grid; then `rows * cols == pins`. |
| `splice` | 1 | Joins every wire on its pin. |
| `terminal` | 1 | `terminal`: `ferrule`, `ring`, `spade`, `male QC`, `female QC`, `loose end`. |
| `diode` | 2 | Pin 1 is the left side. `flipped: true` puts the cathode on the left. A net stops at a diode. |
| `resistor` | 2 | A net stops at a resistor. |
| `cable` | number of cores | See *Cables*. |
| `harness` | number of ports | A sub-harness block. See *Sub-harnesses*. |
| `note` | 0 | `text` and `color` (`yellow`, `orange`, `red`, `green`, `blue`, `purple`). |

Optional fields on components:

| Field | Meaning |
|---|---|
| `signals` | Pin → signal name, keys are pin numbers as strings: `{ "1": "+12V" }`. A pin without its own signal shows its net's signal. |
| `globals` | Pins whose signal is global: the same name anywhere joins the same net. |
| `nc` | Pins marked *not connected*: no wires allowed on them. |
| `cavities` | Cavity names per pin, e.g. `["A1", "A2", "B1", "B2"]`. Empty or missing names show the pin number. |
| `partId` | The assigned part (see *Parts*). |
| `config` | Name of the part configuration in use. Unset means the part's first one. |
| `contacts` | Pin → contact or cavity-plug part id chosen for that cavity, overriding the configuration. `""` means no contact. |
| `excludeFromBom` | `true`: this component's part and its accessories are not counted. |
| `exposed` | Connector: its pins show on the block when this file is used as a sub-harness. |
| `wiringTable` | `{dx, dy}`: show a wiring table this far from the component. |
| `pos` | `{x, y}` centre on the Layout view. Unset means the Schematic position. |

Lowering `pins` means deleting the wires on the removed pins first.

## Wires

```json
{ "id": "W3", "name": "Horn feed", "from": { "c": "C1", "pin": 2 }, "to": { "c": "C3", "pin": 1 },
  "color": "rd/ws", "gauge": "0.5", "length": 1200, "partId": "P2" }
```

Each wire end (`from`, `to`) names a component and a pin from 1 to its `pins`. A cable shield is pin `0`.

**Colours** are CSS colour names or the usual abbreviations, in English or German (`rd`, `sw`, `ws`, `ge`, `gn`, …). A stripe goes after a slash: `rd/ws`.

**Gauge** is text, e.g. `"0.5"`, `"20AWG"` or `"0.5 mm²"`. A plain number is in the harness's `gaugeUnit`.

**Length.** `length` is the typed length in mm. If the wire runs through bundles on the Layout view, the bundle lengths win.

**Look from the part.** When `partId` names a wire part, that part's `colour`, `stripe` and `gauge` replace the wire's own.

Other optional fields:

| Field | Meaning |
|---|---|
| `name` | Label shown on the canvas instead of the id. |
| `points` | Schematic bend points `[{x, y}, …]` from `from` to `to`. Leave them out to route the wire automatically. |
| `twist` | Twist group id (`TW1`): wires with the same value are twisted together. |
| `ident` | Marking printed on the wire: `{ "label": "…", "colors": ["…"] }`. |
| `current` | Current the wire carries, in A. With a gauge and a length it gives the voltage drop: current × 0.0175 Ω·mm²/m (copper at 20 °C) × length ÷ cross-section, over this wire only. |

## Cables

A cable component (`kind: "cable"`) has these fields:

| Field | Meaning |
|---|---|
| `cores` | `[{ "color": "rd", "gauge": "0.5" }, …]`. Core *n* is pin *n*, named `CB1.n`. |
| `shield` | `true`: pin `0` is the shield (`CB1.S`). |
| `length` | mm, counted in the parts list as metres. |

`pins` equals the number of cores. A wire on each end of a core joins the same net, so a net runs through the core.

## Parts

```json
{ "id": "P1", "number": "DT06-4S", "manufacturer": "Deutsch", "description": "4-way plug", "price": 3.2,
  "type": "connector", "cavities": 4, "designations": ["1", "2", "3", "4"], "gender": "female",
  "configurations": [{ "name": "Default", "items": [{ "partId": "P5" }, { "partId": "P6", "apply": "unconnected" }] }] }
```

`number`, `manufacturer`, `description` and `price` are always present.

**Optional on every part:**

| Field | Meaning |
|---|---|
| `type` | The part's type; see the table below. Unset means a generic part. |
| `internalNumber` | Your own stores, ERP or drawing number. |
| `url` | Link to the datasheet or shop page. |
| `colour` | Housing, insulation or plating colour. |
| `image` | Vault path of a picture of the part. |
| `excludeFromBom` | `true`: the part is listed but not counted. |

**Fields per type:**

| `type` | Fields |
|---|---|
| `connector` | `cavities`; `designations` (one per cavity; connectors with that many pins take them); `gender` (`male` or `female`); `shell` |
| `wire` | `gauge`, `stripe`, `insulation` (mm), `diameter` (mm), `ampacity` (max current in A, from the datasheet) |
| `cable` | `coreList` (`[{color, gauge}]`; cables using the part take these cores), `cores` (count), `shield`, `diameter` |
| `terminal` | `terminalType` (`ring`, `spade`, `quick-connect`, `ferrule`, `other`), `size`, `gaugeMin`, `gaugeMax` |
| `contact` | `contactType` (`crimp`, `solder`, `other`), `gender` (`pin` or `socket`), `gaugeMin`, `gaugeMax` |
| `splice` | `gaugeMin`, `gaugeMax` |
| `diode`, `resistor` | `value` (rating, or ohms) |
| `covering` | `coveringType` (`heatshrink`, `tape`, `corrugated tubing`, `spiral wrap`, `tubing`, `braided sleeve`); `cutToLength`; `length` (mm, fixed-length); `diameter` |
| Accessories and group parts | No extra fields. Accessories: `cavity-plug`, `cavity-seal`, `lock`, `dust-cover`, `boot`, `backshell`, `mount`. Other types: `group` (a device, assigned to groups) and `other`. |

**Configurations.** Parts of type connector, terminal, splice, diode and resistor can have `configurations`. Each is a named list of accessory parts that come with every component using the part. Contacts, cavity plugs and seals go per cavity, by their `apply` rule:

- `connected`: the default for contacts and seals
- `unconnected`: the default for plugs
- `never`

A contact also has to take the cavity's wire gauge (`gaugeMin` to `gaugeMax`). Each cavity gets the first contact or plug that fits. Other accessories count once per component.

**How the parts list counts:**

| Type | Counted in | How |
|---|---|---|
| `wire`, `cable` | metres | sum of wire or cable lengths |
| `covering` with `cutToLength` | metres | sum of the lengths of the bundles it covers |
| everything else | pieces | per component, group, bundle, branch point or configuration use |

## Sub-harnesses

A block with `kind: "harness"` stands for another `.DC` file. These fields are kept up to date by the plugin; don't edit them by hand:

| Field | Meaning |
|---|---|
| `file` | Vault path of the other file. The plugin updates it when that file is renamed. |
| `ports` | One entry per pin, e.g. `"C4:1"`: the exposed connector pins of that file. The list only grows, so pin numbers stay stable. |
| `pins` | Always equals `ports.length`. |

The sub-harness's parts count in the parent's parts list, unless they are excluded.

## Layout: bundles and branch points

| Field | Meaning |
|---|---|
| `branchPoints` | `[{ "id": "BP1", "x": 400, "y": 120 }]`. Optional `coverings` lists covering or boot part ids, one piece each. |
| `bundles` | `[{ "id": "B1", "from": "C1", "to": "BP1", "length": 350 }]`. Ends are component or branch point ids. |

Optional bundle fields:

- `points`: bend points on the Layout view
- `label`
- `coverings`: covering part ids. A cut-to-length covering counts the bundle's `length`.

Wires take the shortest path through the bundles between their two components, and their length becomes the sum of those bundle lengths.

## Groups, mates and images

| Field | Meaning |
|---|---|
| `groups` | `[{ "id": "G1", "name": "ECU", "members": ["C1", "C2"], "partId": "P9", "locked": true }]`. A component is in at most one group. A group part (type `group`) counts once per group. `locked` stops editing inside the group. |
| `mates` | `[{ "a": "C3", "b": "C7" }]`: two connectors with the same number of pins plugged together. Pin *n* of `a` is joined to pin *n* of `b`. |
| `images` | `[{ "id": "I1", "path": "Attachments/ecu.png", "x": 0, "y": 0, "w": 240, "h": 160 }]`. `path` is a vault path. |
