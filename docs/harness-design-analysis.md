# harness.design — feature & UX analysis (for an Obsidian plugin)

Source: www.harness.design + docs.harness.design, read 2026-11-15. The app itself needs a login and was not opened.

## What it is
A browser/desktop CAD tool for wire harnesses. One harness document, shown in **4 linked views**. Data model is a plain JSON file (`.harness`, format v1.3), part libraries are `.harnesslib`.

## Core model
| Concept | Meaning |
|---|---|
| Component | Connector, Terminal, Splice, Diode, Resistor, Branch Point, Layout Point, Group, Note, Image |
| Conductor | Wire, Twisted Wires, Cable (multi-core, shielded) — schematic only |
| Bundle | Physical path between connectors/branch points — layout only; has length + coverings |
| Part | Real product (MPN, manufacturer, price, colour, gauge, cavities, gender…) assigned to a component |
| Net | Everything electrically connected; stops at diodes/resistors; crosses mates |
| Signal | Text label on a cavity (VCC, CAN H), auto-propagates over the net |
| Mate | Connector↔connector or terminal↔terminal plug-together (bulkhead) |

## The 4 views (core UX)
1. **Schematic** — node canvas. Right-click canvas → add component. Drag from a cavity handle → wire. Right-click wire → add splice. Double-click wire → layout point (bend).
2. **Layout** — physical canvas. Drag between connectors/branch points → bundle. Wires auto-route via shortest bundle path. Splices/diodes auto-placed to minimise length. Bundles drawn at estimated thickness, coloured by covering.
3. **Parts** — table = BOM. Quantities auto-count from assignments, total price, sortable/resizable columns, "Not used" flag.
4. **Connections** — table = wiring list. From/to, wire part, length (auto from bundles), ident. "No part" / "NO ROUTE" flags.

**Split screen**: any two views side by side, selection syncs between them. This is the headline UX feature.

## Cross-cutting UX
- **Selection sync / net highlight**: select anything → its wires, net and parts light up in every view. Toggle "whole net" vs "direct only".
- **Bottom-right toggle bar** per view: fit, highlight nets, dash unrouted, show parts, show destinations (D), show IDs, show warnings, hide inline components (J).
- **Destinations**: select connector → input per cavity, type target name, Enter = wire created. Keyboard wiring without dragging.
- **Search**: Space opens; dims non-matches on canvas, filters tables.
- **Selection info** bar: counts, total gauge, length, bundle diameter.
- **Length fields accept math & units**: `40+30+40`, `5' 3"`, `30 + 20cm`.
- Arrow keys nudge by grid; K = parts catalog.
- Right-click context menus everywhere; double-click to edit.
- Light/dark/auto; dashed vs parallel wire stripes; outline black/white wires.
- Component IDs auto-numbered (C1, W3) by canvas position or static.

## Feature list (by priority for a plugin)
**Must (MVP)**
- Schematic canvas: connectors with cavities, wires with colour/stripe/gauge, splices.
- Connections table (wiring list) + Parts table (BOM) derived from the model.
- Net computation + highlight; signals with propagation.
- Save as JSON file in the vault.

**Should**
- Layout canvas with bundles, lengths, auto-routing → wire length calc (cut list).
- Validation: gauge vs contact, cavity count mismatch, unassigned/unrouted wires, mate gender/cavity mismatch.
- Split view with synced selection.
- Wiring tables & pinouts on canvas.
- Destinations quick-wiring, search, selection info.
- Export: PDF/SVG of views, CSV of BOM + cut list.
- Part library (reusable across harnesses).

**Could / skip**
- Formboard 1:1 print, cross-section drawings, bundle thickness estimation.
- Parts catalog (hosted manufacturer DB) — skip; let users build libraries.
- Teams, sharing, revisions, embed, MCP server — Obsidian/sync/git cover most of this; an agent can edit the JSON file directly.
- Twisted wires, cables, diodes/resistors, coverings/accessories — later.

## Obsidian mapping
| harness.design | Obsidian plugin |
|---|---|
| `.harness` JSON file | Register `.harness` extension → custom `FileView` (or ```harness code block for embeds) |
| 4 views | One view with a view switcher; split screen = open the same file in two leaves, sync selection via plugin event bus |
| Part library `.harnesslib` | A JSON file (or folder of notes with frontmatter) in the vault |
| Sharing / revisions | Vault sync + git; free |
| MCP / AI | Not needed: documented JSON → any agent edits the file |
| Export | Obsidian's own PDF for tables; SVG/PNG export of canvas; CSV for BOM/cut list |
| Notes/images on canvas | Link to vault notes/attachments (`[[...]]`) — a real plus over the original |
| Theme | Use Obsidian CSS variables → light/dark free |

## Open questions for design
- Canvas tech: SVG + hand-rolled interaction, or a library (React Flow / Svelte Flow / JointJS)?
- Is "DC wiring" scope smaller (vans/boats/solar: wires + fuses + batteries + gauge/voltage-drop calc) rather than full automotive harness CAD? That changes the component set and validation a lot.
