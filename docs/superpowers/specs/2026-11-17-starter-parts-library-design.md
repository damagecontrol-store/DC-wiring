# Starter parts library: design

## Why
New users should not have to type in the common connectors from datasheets before they can use DC Wiring. The plugin comes with the generic Deutsch DT and TE Superseal 1.5 connectors, ready to assign.

## Goals
- One command, **Install starter parts library**, puts a ready `.DClib` into the vault.
- Every housing comes with its cavity names and a ready configuration (wedgelock, contacts, seals, cavity plugs), so the BOM is complete after assigning.
- Every housing has a picture: a face view the plugin draws itself.

## Non-goals
- Pin functions (what each pin does). Generic connectors have none; that stays on the component (`signals`).
- Manufacturer photos. They are copyrighted.
- Other families (DTM, DTP, Metri-Pack, …). Adding them later is only new data rows.
- Prices. They are left at 0, because they differ per supplier.

## Anti-goals
- A wrong part number or cavity count. Every number is checked against the TE datasheet before it ships.
- Silently losing a user's edits to their library.

## Approaches
- **A. Install command (picked).** The data is built into the plugin. The command writes a normal `.DClib` and SVG images into the vault, so the library picker, sync status and part images work without changes. Users can edit or extend it. Trade-off: files in the vault, and a plugin update does not change an installed library until the command runs again.
- B. Built-in read-only catalog. Nothing in the vault, but the picker, sync status and images would each need a special case, and users can't extend it.
- C. Download from GitHub. Needs network and a network disclosure for Obsidian review. Too many failure points for a starter set.

## Design
- **Files:** `DC Wiring starter parts/Starter parts.DClib` and `DC Wiring starter parts/images/<part number>.svg`.
- **Running it again** updates the library: starter parts are replaced by part number (the existing `copyPart`), and parts the user added themselves stay. Images are rewritten.
- **Data:** `src/starter.ts`, a short table per family (sizes, housing numbers per gender, wedgelock, contacts, seals, plugs, cavity grid) that builds the parts. It is pure, with no Obsidian imports, so tests can load it.
- **Contents:**
  - DT plugs (DT06-xS) and receptacles (DT04-xP) in 2, 3, 4, 6, 8 and 12 way, each with its wedgelock, size 16 contacts and the cavity sealing plug.
  - Superseal 1.5 plug and tab housings in 1 to 6 way, each with its contacts, wire seals and cavity plugs.
  - Added at the user's request (JDM): Sumitomo DL 090 sealed male and female housings in 1, 2, 3, 4, 6, 8, 12 and 16 way. Each has two configurations, one per wire size: 0.3–0.5 mm² and 0.75–0.85 mm², each with its terminal and wire seal.
  - Left out:
    - The 10 way, because its layout can't be read from the catalog.
    - The dummy plugs, because the catalog doesn't say which plug fits which housing.
    - Yazaki and Hitachi, because there is no public catalog to check against.
    - Generic 110 and 250 spades, because there are no real part numbers.
- **Face view:** an SVG drawn from the cavity grid with each cavity name, labelled "mating face, not to scale". It shows in the part editor like any part image.
- **Discoverability:** when "Add a part from a part library" finds no library, it points to the new command.
- **Tests:** every housing's cavity names match its cavity count, configuration items point to parts that exist, and part numbers are unique. Installing twice keeps a user-added part.
- **Docs:** README commands list, and the "no manufacturer parts catalog" limit is reworded.

## Left to the builder
- The exact part numbers and cavity layouts, taken from TE datasheets, with the source listed in the PR.
- The look of the face-view SVG, kept in line with the schematic's connector drawing.
