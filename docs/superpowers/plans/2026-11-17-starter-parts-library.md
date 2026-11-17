# Starter Parts Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command installs a `.DClib` with generic Deutsch DT and TE Superseal 1.5 connectors, their accessories and drawn face views.

**Architecture:** `src/starter.ts` (pure) holds the data table, builds the library `Harness`, draws each face as an SVG string and merges into an existing library with the existing `copyPart`. `main.ts` adds the command and does the vault I/O.

**Tech Stack:** TypeScript, Obsidian API, `node --test` (tests import `.ts` directly).

**Spec:** `docs/superpowers/specs/2026-11-17-starter-parts-library-design.md`

## Global Constraints

- Files: `DC Wiring starter parts/Starter parts.DClib` and `DC Wiring starter parts/images/<part number>.svg`.
- Prices 0. No manufacturer photos. No network use.
- Gauges are written with their unit (`"0.5 mm²"`), so they read right in an AWG harness (`toMm2` parses the unit).
- `starter.ts` has no Obsidian imports.

## Verified data (sources)

The DT data comes from the Deutsch DT Family catalog pages 18–21 ([cdn.shopify.com/…/DT_Series.pdf](https://cdn.shopify.com/s/files/1/0083/7782/7386/files/DT_Series.pdf)). The Superseal data comes from TE catalog 1654292-2, AMP Superseal 1.5, rev. 06-2016 ([customconnectorkits.com/…/AMP_SUPERSEAL_1.5_Catalog.pdf](https://www.customconnectorkits.com/cdn/shop/files/AMP_SUPERSEAL_1.5_Catalog.pdf)).

| Family | Part | Numbers |
|---|---|---|
| DT receptacle (pin contacts), gender male | 2, 3, 4, 6, 8, 12 way | DT04-2P, DT04-3P, DT04-4P, DT04-6P, DT04-08PA, DT04-12PA |
| DT plug (socket contacts), gender female | same | DT06-2S, DT06-3S, DT06-4S, DT06-6S, DT06-08SA, DT06-12SA |
| DT wedgelock (type `lock`) | receptacle / plug | W2P…W12P / W2S…W12S (W2, W3, W4, W6, W8, W12) |
| DT contact, size 16 solid, 16–20 AWG (0.5–1.5 mm²) | pin / socket | 0460-202-16141 / 0462-201-16141 |
| DT cavity plug, size 12/16, white | | 114017 |
| Superseal plug housing (receptacle contacts), female | 1–6 way | 282079-2, 282080-1, 282087-1, 282088-1, 282089-1, 282090-1 |
| Superseal cap housing (tab contacts), male | 1–6 way | 282103-1, 282104-1, 282105-1, 282106-1, 282107-1, 282108-1 |
| Superseal contact 0.75–1.5 mm², tin | receptacle / tab | 282110-1 / 282109-1 |
| Superseal wire seal, yellow, insulation 1.7–2.4 mm | | 281934-2 |
| Superseal cavity plug, red | | 282081-1 |
| Sumitomo DL 090 sealed housing, male / female | 1, 2, 3, 4, 6, 8, 12, 16 way | 6195-0240/0066, 6195-0006/0003, 6195-0012/0009, 6195-0018/0015, 6195-0024/0021, 6195-0054/0051, 6195-0152/0149, 6188-0495 / 6189-0715 |
| Sumitomo DL 090 terminal, tin, male / female | 0.3–0.5 mm² and 0.75–0.85 mm² | 8230-4472 / 8100-1427 and 8230-4562 / 8100-1429 |
| Sumitomo DL 090 wire seal | cable diameter 1.4–1.6 mm (black) and 1.6–2.4 mm (gray) | 7165-0516 and 7165-0515 |

The Sumitomo source is the DL Sealed Series 2.3 mm (090) catalog, pages M-02 to M-06 ([prd.sws.co.jp/…/dls.pdf](https://prd.sws.co.jp/components/series/pdf/en/dls.pdf)). Layouts: 1–3 way in one row, 4 = 2×2, 6 = 2×3, 8 = 2×4, 12 = 3×4, 16 = 4×4. The proposed numbering goes row by row on the male face, and the female face is its mirror image.

**DT cavity arrangement** (catalog page 20, rows top to bottom): 2 = one row of 2; 3 = 2 over 1 (triangle); 4 = 2×2; 6 = 3 rows of 2; 8 = 2 rows of 4; 12 = 2 rows of 6. Superseal is one row, 6 mm pitch.

**Cavity numbers in the arrangement are NOT in either catalog** (TE: "molded into the housing"). Proposed receptacle/cap mating-face numbering, to be confirmed by the user against a housing before merge: DT 2 `[[1,2]]`, 3 `[[1,2],[3]]`, 4 `[[1,2],[4,3]]`, 6 `[[1,6],[2,5],[3,4]]`, 8 `[[1,2,3,4],[8,7,6,5]]`, 12 `[[1..6],[12..7]]`; Superseal `[[1..n]]`. Plug faces are the mirror image (each row reversed).

## Review Focus

1. The library file exists but isn't valid JSON (hand-edited): install must not overwrite it. Show a Notice and stop.
2. The library is open in a view during install: the view shows the new parts (Obsidian reloads a modified file). Check by hand in Task 2.
3. Install runs twice: no duplicate part numbers, user-added parts kept, image files overwritten without a "file exists" error.
4. Assigning DT04-4P in an AWG harness: the contact range still fits 18 AWG wire (the units in the gauge strings).
5. A user part with the same number as a starter part (for example their own DT04-2P with a price) is replaced on reinstall. This is by design and is stated in the Notice.

---

### Task 1: Starter data, face drawings and merge

**Files:**
- Create: `src/starter.ts`
- Test: `src/starter.test.ts`

**Interfaces:**
- Produces:
  - `STARTER_DIR = "DC Wiring starter parts"`, `STARTER_LIB = \`${STARTER_DIR}/Starter parts.DClib\``
  - `starterLibrary(): Harness`: every part has an `id` (`nextId`), `number`, `manufacturer` (`"TE Connectivity (Deutsch)"` for DT, `"TE Connectivity"` for Superseal), `description`, `price: 0`, `type`. Housings also have `cavities`, `designations` `["1"…"n"]`, `gender`, `image: \`${STARTER_DIR}/images/${number}.svg\`` and one configuration named `"Standard"`. DT: wedgelock (no apply), contact `apply: "connected"`, 114017 `apply: "unconnected"`. Superseal: contact and 281934-2 `"connected"`, 282081-1 `"unconnected"`. Contacts: `contactType: "crimp"`, `gender` pin/socket, `gaugeMin`/`gaugeMax` with units.
  - `STARTER_FACES: Record<string, number[][]>`: part number to cavity numbers by row, as seen from the mating face.
  - `faceSvg(number: string, rows: number[][]): string`: rows centred (so the DT 3-way draws as a triangle), a circle and number per cavity, the part number as a title, and the caption `"Mating face, not to scale"`. Fixed light colours, because it renders as an image.
  - `installStarter(existing?: Harness): { lib: Harness; images: Record<string, string> }`: with no existing library it returns `starterLibrary()`. Otherwise it runs `copyPart` (from `library.ts`) on every starter part into `existing` and returns that. `images` maps vault path to SVG for every housing.

- [ ] **Step 1: Write the failing tests** in `src/starter.test.ts`:
  - `"has 43 parts with unique numbers"`: 12 DT housings, 12 wedgelocks, 2 contacts and 1 plug (27), plus 12 Superseal housings, 2 contacts, 1 seal and 1 plug (16).
  - `"every connector's names, count and face agree"`: `designations.length === cavities`, and `STARTER_FACES[number].flat().sort()` equals 1…cavities.
  - `"plug faces mirror receptacle faces"`: `STARTER_FACES["DT06-4S"]` deep-equals `[[2,1],[3,4]]`.
  - `"configuration items point at parts in the library"`.
  - `"contact ranges read the same in an AWG harness"`: `fitsRange({ ...lib, gaugeUnit: "AWG" }, socket, toMm2("18AWG"))` is true.
  - `"reinstall keeps user parts and resets starter parts"`: the existing library has its own part `MY-1` and an edited `DT04-4P` description. After the install, `MY-1` is still there, DT04-4P has the starter description, its id is unchanged, and no number appears twice.
  - `"face svg shows every cavity number and the caption"`.
  - `"images cover every housing"`: 24 keys, all under `STARTER_DIR/images/`.
- [ ] **Step 2:** `npm test`. Expected: the starter tests fail with "Cannot find module ./starter.ts".
- [ ] **Step 3:** Implement `src/starter.ts`. Use one table row per size (`{ ways, rec, plug, wedge?, rows }`) and a loop, not 43 literal parts.
- [ ] **Step 4:** `npm test`. Expected: all pass (81 existing tests plus the new ones).
- [ ] **Step 5:** Commit `feat: starter parts data for DT and Superseal`.

### Task 2: Install command, empty-library hint, docs

**Files:**
- Modify: `src/main.ts` (new command after `add-part-from-library`, plus a private `installStarter()`)
- Modify: `src/view.ts:513` (the empty-library Notice)
- Modify: `README.md` (Commands list, "Limits of 1.0" line about the parts catalog)

**Interfaces:**
- Consumes: `STARTER_DIR`, `STARTER_LIB`, `installStarter` from Task 1. Uses `parseHarness` from `model.ts`.

- [ ] **Step 1:** In `main.ts`, add command id `install-starter-library`, name `"Install starter parts library (DT, Superseal)"`. It is always available.
  - Create `STARTER_DIR` and `${STARTER_DIR}/images` if they're missing.
  - Read `STARTER_LIB` if it exists. If `parseHarness` throws: `Notice("DC Wiring: <path> can't be read (<msg>); nothing was changed.")` and return.
  - Write each image with `vault.modify` if it exists, else `vault.create`. Then write the library the same way, with `JSON.stringify(lib, null, "\t")`, and open it in a new leaf.
  - Notice: `"DC Wiring: starter library installed: N parts. Starter parts were reset; your own parts were kept."`
- [ ] **Step 2:** In `view.ts:513`, change the empty Notice to `"DC Wiring: no part libraries with numbered parts in this vault. Run "Install starter parts library" for common DT and Superseal connectors."`
- [ ] **Step 3:** README: add the command to Commands. Change the limit line to "No manufacturer catalog beyond the starter DT and Superseal library."
- [ ] **Step 4:** `npm run build`. Expected: tsc passes and the bundle is written (into the test vault).
- [ ] **Step 5:** Check in Obsidian (test vault): run the command, open DT04-4P and see the face image, and run "Add a part from a part library" in a harness and assign DT04-4P. Then check Review Focus items 1–3: corrupt the file and rerun; run with the library open; run twice.
- [ ] **Step 6:** Commit `feat: install starter parts library command`.
