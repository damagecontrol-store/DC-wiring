# DC Wiring vs harness.design: feature gap

Source: all pages of docs.harness.design (read 2026-11-15; change logs only skimmed).
Legend: ✅ have · 🟡 partly · ❌ missing · ⏭️ skip (cloud/account feature, Obsidian or git already covers it)

## What the plugin has today
Schematic with connectors (count or rows×cols pin grid), splices, wires (colour/stripe, gauge, manual length, name), bend points + auto route, net highlight, signals with net propagation, Connections table, Parts list with totals, sub-harness files (blocks with exposed pins, BOM roll-up, back-links), undo (no redo), validation of hand-edited files.

---

## 1. Views and navigation
| Feature | Status | Notes |
|---|---|---|
| Schematic view | ✅ | |
| **Layout view** (physical harness: bundles, branch points) | ❌ | The second core view. Drives wire lengths, cut list, formboard |
| Parts view | 🟡 | No sorting, column chooser, resizable columns, sections by part type, "only highlighted" filter |
| Connections view | 🟡 | No sorting/columns, "Twisted with", net, group, contact columns; can't retype from/to; no "switch direction" |
| **Split screen** with selection synced between views | ❌ | In Obsidian: same file in two panes, shared selection |
| Search (Space): dim non-matches, jump to result; filters tables | ❌ | |
| Destinations (D): type a target pin next to a cavity to create the wire | ❌ | Fast keyboard wiring |
| Bottom-right toggle bar: highlight nets (N), dash unrouted (U), show parts (P), destinations (D), IDs (I), warnings (W), inline comps (J) | 🟡 | Only "Wire IDs" toggle |
| Selection info bar (counts, total gauge, length, diameter) | ❌ | |
| Box select, shift-click multi-select | ❌ | Only single selection |
| Arrow-key nudge, Duplicate (Mod D), copy/paste | ❌ | |
| Redo (Mod Shift Z / Mod Y) | ❌ | Undo exists |
| Rotate connector/terminal (R) | ❌ | |
| Hotkeys: F fit, X delete, O orthogonal, S select net, Mod G group, H crosshair | ❌ | |
| Input type mouse vs trackpad (wheel zooms vs pans) | 🟡 | Fixed to trackpad-style |
| Light / dark | ✅ | Obsidian theme |

## 2. Components
| Component | Status | Missing pieces |
|---|---|---|
| Connector | 🟡 | Label vs ID, **cavity designations** (A1/B2, templates), **N/C cavities**, insert/move/delete a cavity, **shell** connection, width, rotate, gender, inline connectors on wires/bundles |
| Wire | 🟡 | **Move connections** (Mod-drag a cavity's wires elsewhere), **idents** (colour bands + label along the wire), colour menu, jumper wire (same connector), dashed when unrouted, "select wires on net" |
| Splice | 🟡 | Label, add splice from selected wires, delete-merges-two-wires, drop a bend point on a splice to tee in, location on layout |
| **Terminal** (ferrule, ring, spade, male/female quick connect, loose wire end) | ❌ | Single-pin end; mates with size rules |
| **Diode / Resistor** | ❌ | Nets stop at them; flip direction |
| **Cable** (cores, shield, twisted cores, "make cable" from wires) | ❌ | Core names CB1.2; length = longest core |
| **Twisted wires** ("twist together") | ❌ | |
| **Group** (frame, nested, lock, hide content, header position, group part = device) | ❌ | Their way to model ECU/fusebox/relay |
| Note (text, colour, width, alignment) | ❌ | Could link `[[notes]]` in Obsidian |
| Image (photo/drawing on canvas) | ❌ | Use vault attachments |
| Layout point | ✅ | Called bend points here; no multi-select, no guide lines, no "make orthogonal" per wire (O) |
| **Bundle** (layout) | ❌ | Length, length maths (`40+30`, `5' 3"`), coverings, labels (ends/middle), thickness, dashed when empty |
| **Branch point** (layout) | ❌ | Join bundles, boots/coverings, merge, delete-merges-two |
| Wiring table node on canvas | ❌ | Per-connector pin table next to the connector; editable cells |
| Pinout node on canvas | 🟡 | We draw a rows×cols face; no real housing shapes, keys, mirroring, harness-side view |
| Part image node | ❌ | |

## 3. Mates
| Feature | Status |
|---|---|
| Connector ↔ connector mates (pins map 1:1, same net) | ❌ |
| Terminal mates with rules (ring/spade/stud size, quick-connect gender) | ❌ |
| Validation: cavities don't match, genders don't match | ❌ |

Our sub-harness "exposed pins" covers part of this; real mates (bulkhead/inline pairs) are missing.

## 4. Signals and nets
| Feature | Status |
|---|---|
| Signal on cavity, propagates over net | ✅ |
| Do not propagate | ❌ |
| Global signals (same name = same net) | ❌ |
| Conflicts: show all signals on a net | ❌ (we show the first) |
| Paste a column of signals into a connector | ❌ |
| Nets break at diodes/resistors | ❌ (no diodes yet) |
| Highlight whole net vs direct connections toggle | ❌ |
| Select a part → highlight where used; select cavity → its parts | ❌ |

## 5. Component IDs and labels
| Feature | Status |
|---|---|
| Prefixes C, T, W, CB, TW, S, D, R, B, BP | 🟡 C, S, W, H only |
| Numbering by canvas position (default) or static, renumber button | 🟡 static only, never reused |
| Label on every component, used instead of ID everywhere (`ECU (C1)`, `Sensor:C2` when labels clash) | 🟡 connector name, wire name |

## 6. Parts system (biggest gap after Layout)
| Feature | Status | Notes |
|---|---|---|
| Generic part (number, manufacturer, description, price) | ✅ | |
| Internal part number, URL, colour | ❌ | |
| **Typed parts** with their own fields | ❌ | Connector (cavities, designations, gender, shell, colour), Wire (gauge, colour, stripe, insulation, diameter), Cable (cores, shield, jacket), Terminal types (size), Splice/Diode/Resistor, Group (device) |
| Wire colour/gauge **taken from the wire part** | ❌ | Today typed per wire |
| **Coverings**: heatshrink, tape, corrugated tubing, spiral wrap, tubing, braided sleeve; cut-to-length vs fixed | ❌ | Cut-to-length gets bundle length in BOM |
| **Accessories**: contact, cavity plug, cavity seal, lock, dust cover, boot, backshell, mount | ❌ | |
| **Configurations** (variants of a part with accessories) | ❌ | e.g. "sealed": boot + backshell |
| **Contact / plug / seal rules** (connected vs unconnected cavities, cavity size, gauge range, wire diameter) and manual override per cavity | ❌ | Auto-loads contacts into cavities; counts in BOM |
| Create part from component; assign dropdown ranks fitting parts first | 🟡 | Plain dropdown |
| Exclude from BOM | ❌ | |
| Part images | ❌ | Vault images |
| BOM sections by type, quantity per unit (pcs / m) | 🟡 | pcs/m only |
| **Part libraries** reused across harnesses, sync status, push/pull | ❌ | `.harnesslib` file in the vault |
| Parts catalog (hosted manufacturer DB) | ⏭️ | No data source; maybe import later |
| Duplicate part number warning | ❌ | |

## 7. Validation (Show warnings, W)
| Check | Status |
|---|---|
| Wire gauge vs contact range (summed when several wires share a contact) | ❌ |
| Connector cavities vs connector part | ❌ |
| Wires with no part ("No part") | ❌ |
| Wires not routed through bundles ("NO ROUTE") | ❌ (needs Layout) |
| Parts not used | ✅ |
| Mate checks (cavities, gender, terminal size) | ❌ |
| Unconnected cavity warning (skips N/C) | ❌ |

## 8. Units and settings
| Feature | Status |
|---|---|
| Currency per harness | ❌ (no symbol shown) |
| Length unit mm/cm/m/in/ft/yd + length maths in every length field | ❌ (mm only) |
| Gauge unit mm² / AWG / cmil / kcmil with conversion | ❌ (free text) |
| Read-only harness toggle | ❌ |
| Default connector/terminal width | ❌ |
| Preferences: stripes dashed vs parallel, outline black/white wires, part-bar contents, default wiring-table columns, pinout side | ❌ |

## 9. Layout-only features (all ❌, need the Layout view first)
- Wires auto-routed through the shortest bundle path; **wire length = sum of bundle lengths** (cut list)
- Splices/diodes/resistors placed automatically to minimise length, or dragged to a branch point
- Bundles drawn at estimated thickness (packed wires + covering walls), coverings drawn (ribs, spiral, tape, braid), wires side by side in colour
- **Cross sections** of a bundle / wire / cable to scale with estimated diameter
- Connector drawings (top/side) from catalog ⏭️ (no catalog)

## 10. Formboard (all ❌)
1:1 layout mode, panel size (A4–A1, custom) and grid, bend radius, annotation scale, "match length" button, set whole harness to scale, branch bending, panel-by-panel PDF, formboard JSON for projection systems.

## 11. Export
| Output | Status |
|---|---|
| PDF: schematic, layout, parts, connections pages, title block, notes, page sizes, filter by net | ❌ |
| Wiring table Excel (all + per connector sheets) | ❌ |
| BOM CSV | ❌ |
| Formboard panels PDF / formboard JSON | ❌ |
| Native file (`.harness` JSON) | ✅ (the file itself) |
| `$schema` + `$docs` keys so AI agents can edit the file safely | ❌ |

## 12. Sub-harnesses: theirs vs ours
| harness.design "Embed" | Ours |
|---|---|
| Linked group holds a full read-only **copy**, refresh when source changes | Live link to the file, no copy |
| Connect straight to any connector/terminal inside | Connect via "exposed" connectors only |
| IDs prefixed `Rear.C1` everywhere | Block shows `C1:1` refs |
| Parts **not** counted in parent BOM | Counted (your choice) |
| Unlink → becomes editable group; **Save group as linked harness** to split a design | ❌ |

## 13. Skip (⏭️)
Accounts, teams, seats, email sharing, public links/embeds, revisions (Obsidian File recovery + git), MCP server (agents edit the `.harness` file directly), mobile/desktop apps, hosted parts catalog, billing.

---

## Suggested build order
1. **Schematic completeness** (small pieces, big daily value): component labels + ID prefixes, cavity designations and N/C, terminals, diodes/resistors, notes, multi-select + box select, move connections (Mod-drag), duplicate/copy, redo, search, destinations, hotkeys + toggle bar, signal extras, connector mates.
2. **Parts system**: typed parts (connector, wire, terminal, splice, covering, contact, plug, seal), wire colour/gauge from part, units with AWG ↔ mm² conversion, configurations with contact rules, validation + warnings, exclude from BOM, part libraries as vault files.
3. **Layout view**: bundles, branch points, length maths, automatic routing through bundles → automatic wire lengths and cut list, coverings, bundle labels, thickness and cross sections, split screen with synced selection.
4. **Output**: canvas wiring tables and pinouts, BOM/cut-list CSV, wiring table Excel, PDF with title block.
5. **Advanced**: cables, twisted wires, shields, groups/devices, idents, images, formboard, "save group as sub-harness".
