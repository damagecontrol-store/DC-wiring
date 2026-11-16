# Editing .DC harness files

Harness files end in `.DC`.

For AI agents and people editing a DC Wiring harness by hand. The file is pretty-printed JSON (tabs); the full schema is `harness.schema.json` next to this file. Obsidian reloads the open view when the file changes on disk.

## Shape

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
		{ "id": "P1", "number": "DT04-4P", "manufacturer": "TE", "description": "", "price": 2.1 },
		{ "id": "P2", "number": "FLRY 1.5", "manufacturer": "", "description": "", "price": 0.4 }
	]
}
```

## Rules

- `version` is always `1`. Keep fields you don't understand: the plugin keeps them too.
- Ids are unique and prefixed: `C` connector, `S` splice, `H` sub-harness block, `W` wire, `P` part. Never reuse or renumber an id: other files refer to connectors by id. For a new id take one above both the highest existing number and `seq[prefix]`, and set `seq[prefix]` to it.
- Every wire end (`from`, `to`) must name an existing component and a pin from 1 to its `pins`. A splice has exactly one pin (`pins: 1`) and joins every wire on it. A file with a dangling wire end opens read-only.
- Connector `layout` `{rows, cols}` is optional; when present `rows * cols == pins`. Lowering `pins` means deleting the wires on the removed pins.
- `signals` keys are pin numbers as strings. A pin without its own signal shows the signal of its net (everything joined by wires and splices).
- Colours: CSS names or abbreviations (`rd`, `sw`, `ws`, `ge`, ...), stripe after a slash: `rd/ws`. Gauge is text (`"0.5"`, `"20AWG"`). Length is millimetres.
- `partId` points into `parts`. A part used on wires is counted in metres (sum of wire lengths), on components in pieces; `price` is per metre or per piece accordingly.
- Sub-harness blocks (`kind: "harness"`) point at another `.DC` file by vault path in `file`. Their `ports` (`"C4:1"`, exposed connector pins of that file) only grow, so pin numbers stay stable; `pins` equals `ports.length`. The plugin maintains them: don't edit by hand.
- Positions (`x`, `y`, wire `points`, `wiringTable` offsets) are canvas units on a 20-unit grid. Optional; leave `points` out and the wire is routed automatically.
- `export` holds the title block (`company`, `title`, `drawing`, `date`, `drawnBy`) and `notes` used by exports.
