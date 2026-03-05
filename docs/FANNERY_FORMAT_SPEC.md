# Fannery DOCX Format Specification: Urapanes Standard

> This document defines the target DOCX formatting for all Fannery-generated actas.
> Reference document: `Acta_Asamblea_URAPANES_-_14022026.docx`

---

## Architecture Decision: Modify Fannery In-Place

**Approach chosen:** Modify Fannery's DOCX generation pipeline directly rather than a post-processing pass.

**Rationale:**
- Fannery already has structured content blocks (`paragraph`, `intervention`, `listItem`, `votingQuestion`, `votingResults`, etc.) — the format can be applied at render time
- A post-processing pass (manipulating raw OOXML) would be fragile, complex, and harder to maintain
- The `docx` library supports all needed features: numbering, styles, table formatting, shading
- Changes are localized to 5 files: `documentSetup.ts`, `contentRenderer.ts`, `tableBuilder.ts`, `documentAssembler.ts`, and shared `TemplateConfig` type

---

## 1. PAGE SETUP

### Margins
```
Top:    1134 twips = 2.0 cm = 0.79"
Bottom: 1134 twips = 2.0 cm = 0.79"
Left:   1134 twips = 2.0 cm = 0.79"
Right:  1134 twips = 2.0 cm = 0.79"
Header: 709 twips  = 1.25 cm
Footer: 709 twips  = 1.25 cm
Gutter: 0
```

### Page Size
US Letter (12240 × 15840 twips) — unchanged.

### Usable Content Width
12240 - 1134 - 1134 = **9972 twips**

### Implementation
- File: `documentSetup.ts` → `setupPageProperties()`
- Change: margins from `{ top: 1, bottom: 1, left: 1.25, right: 1.25 }` inches to `{ top: 0.79, bottom: 0.79, left: 0.79, right: 0.79 }` inches
- Also in `TemplateConfig` default and `loadTemplate()` in `documentAssembler.ts`

---

## 2. FONT & TYPOGRAPHY

### Target
- **Font:** Calibri (via Word theme `minorHAnsi`, but in docx library just use `'Calibri'`)
- **Body size:** 11pt (sz=22 half-points)
- **Language:** es-CO

### Font Application by Element

| Element | Font | Size | Bold | Other |
|---------|------|------|------|-------|
| Building name (cover) | Calibri | 12pt | Yes | Centered |
| Assembly subtitle | Calibri | 11pt | Yes | Centered |
| Date | Calibri | 11pt | Yes | Centered |
| "ACTA DE ASAMBLEA" | Calibri | 11pt | Yes | Centered |
| Body text | Calibri | 11pt | No | Justified |
| Highlighted data (dates, %, names) | Calibri | 11pt | **Yes** | Inline |
| Section titles | Calibri | 11pt | Yes | Justified |
| Agenda items | Calibri | 11pt | No | Numbered list, justified |
| Development numbered headings | Calibri | 11pt | Yes | Numbered bold + text bold, justified |
| Header | Calibri | 9pt | No | Right-aligned |
| Footer | Calibri | 9pt | No | Centered |

### Implementation
- File: `contentRenderer.ts` — change all `font: fontFamily` from `'Arial'` to `'Calibri'`
- File: `tableBuilder.ts` — change `font: 'Arial'` to `'Calibri'`
- File: `documentSetup.ts` — change default font in `createDocument()`
- File: `documentAssembler.ts` → `loadTemplate()` — change `fontFamily: 'Arial'` to `fontFamily: 'Calibri'`

---

## 3. LINE SPACING & PARAGRAPH SPACING

### Target (Urapanes defaults)
- **Line spacing:** 259/240 = **1.08** (Word modern default)
- **After paragraph:** 160 twips = **8pt**
- **Before paragraph:** 0 (default; section titles may use `before` for visual separation)

### Cover block (first 4 paragraphs)
```
spacing: { after: 0 }
```
No space between cover lines.

### Implementation
- File: `contentRenderer.ts` → all `renderXxx()` functions: change `after: 120` → `after: 160`, `line: 1.15 * 240` → `line: 259`
- File: `documentAssembler.ts` → section title spacing: change `after: 120, before: 300` → `after: 160, before: 0` (or small before only for major sections)
- File: `documentSetup.ts` → `createDocument()` default paragraph spacing

---

## 4. TEXT ALIGNMENT

### Target
- **Cover block (4 lines):** `CENTER`
- **All body text:** `JUSTIFIED` (both)
- **Agenda items:** `JUSTIFIED`
- **Section headings:** `JUSTIFIED` (not LEFT)

### Implementation
- Already mostly correct. Just ensure section titles in `documentAssembler.ts` use `JUSTIFIED` instead of `LEFT`.

---

## 5. DOCUMENT STRUCTURE

### Cover Block (4 lines, centered, no space between)
```
CONJUNTO RESIDENCIAL {BUILDING_NAME}         (bold, 12pt, centered, after=0)
ASAMBLEA GENERAL ORDINARIA DE PROPIETARIOS.  (bold, 11pt, centered, after=0)
{DATE_IN_SPANISH}                            (bold, 11pt, centered, after=0)
ACTA DE ASAMBLEA                             (bold, 11pt, centered, after=0)
[empty paragraph]
```

### Implementation
- File: `documentAssembler.ts` → `assembleActa()` — detect `sectionStyle === 'encabezado'` and render as cover block instead of generic title
- Need to replace "TRANSCRIPCIÓN COMPLETA" header with 4-line cover block
- The building name and date should come from the pipeline metadata (`clientName`, assembly date)

### Agenda ("ORDEN DEL DÍA")
- Title: bold paragraph, justified
- Items: `ListParagraph` style with `numPr` (Word numbered list)
- Justified

### Implementation
- File: `contentRenderer.ts` → `renderListItem()` — use docx `NumberProperties` with level + numId
- File: `documentAssembler.ts` → add numbering definitions to the `Document` constructor

### Development Sections
- Numbered bold headings: `1. LLAMADO A LISTA Y VERIFICACIÓN DEL QUORUM.`
- Use numbered list with bold + CAPS
- Body text below each heading: regular paragraphs, justified

### Implementation
- File: `documentAssembler.ts` → detect `sectionStyle` and render section titles as numbered list items when in development sections

---

## 6. VOTING TABLES

### Summary Table (4 columns)

#### Table Properties
```
Width: 100% (5000 pct)
Cell margins: left=70 right=70 twips
```

#### Grid Columns (proportional)
```
Respuestas:      2132 twips (21.4%)
Coeficientes %:  2895 twips (29.0%)
Asistentes %:    2620 twips (26.3%)
Nominal:         2315 twips (23.2%)
```

#### Header Row
- Height: 300 twips minimum
- All borders: single, size 4, color auto
- Background: `#D9D9D9` (gray)
- Vertical align: bottom
- No wrap
- Text: Calibri, bold, black (#000000)
- Spacing inside cell: after=0, line=240 (single)

#### Data Rows
- Same borders, noWrap, vAlign=bottom
- **No background** (no shading)
- Text: Calibri, regular (not bold), black
- Same single-line spacing inside cell

#### Column Headers
| Col 1 | Col 2 | Col 3 | Col 4 |
|-------|-------|-------|-------|
| Respuestas | Coeficientes % | Asistentes % | Nominal |

### Detail Voting Tables → REMOVE
Urapanes does **NOT** include detail voting tables in the body. Instead:
```
• Ver anexo de acta de votación detallada.
```
(Bullet list, 10pt, Calibri)

### Implementation
- File: `tableBuilder.ts` → completely rewrite `buildSummaryTable()` with Urapanes formatting:
  - Gray header shading (`D9D9D9`)
  - Explicit column widths
  - Cell margins
  - Single-line spacing inside cells
  - Bold header text, regular data text
- File: `documentAssembler.ts` → in `renderBlock()` case `'votingResults'`:
  - Remove detail table generation
  - Add "Ver anexo de acta de votación detallada." bullet paragraph after summary table

---

## 7. HEADER & FOOTER

### Header
- "Tecnoreuniones.com" — right-aligned, 9pt (sz=18), Calibri
- Already correct, just change font from Arial to Calibri

### Footer
- "Página X de Y" — centered, 9pt (sz=18), Calibri
- Already correct, just change font

### Implementation
- File: `documentSetup.ts` → `setupHeader()`, `setupFooter()` — change font to Calibri

---

## 8. BOLD INLINE PATTERNS

### Elements that should be bold inline:
- Full dates
- Times
- Quorum and voting percentages
- Full names with apartment/unit (e.g., **DIEGO MORENO (APTO. 1-1904)**)
- Decision keywords: **APROBADA**, **UNANIMIDAD**, **NO PRESENTARSE OBJECIONES**
- Designated roles: **PRESIDENTE**, **SECRETARIA**

### Implementation
- This is already partially handled by Lina's markdown output using `**bold**` markers
- The `parseInlineBold()` function in `contentRenderer.ts` already splits on `**`
- Completeness depends on Lina's prompt producing the right bold markers

---

## 9. BULLET LISTS

### Format
- Style: `ListParagraph` with bullet numPr
- Indent: left=720, hanging=360
- Justified

### Used For
- Names of nominated persons
- Reference notes ("Ver anexo de acta de votación detallada")

### Implementation
- File: `contentRenderer.ts` → `renderListItem()` — add bullet numbering option
- File: `documentAssembler.ts` → add bullet list numbering definition

---

## 10. IMPLEMENTATION CHECKLIST

### Phase 1: Page & Typography (documentSetup.ts, TemplateConfig)
- [ ] Change margins to 1134 twips (0.79" all sides)
- [ ] Change default font from Arial to Calibri
- [ ] Change default line spacing from 1.15 to 1.08 (line=259)
- [ ] Change default paragraph spacing from after=120 to after=160
- [ ] Update header/footer font to Calibri

### Phase 2: Document Structure (documentAssembler.ts)
- [ ] Replace "TRANSCRIPCIÓN COMPLETA" header with 4-line cover block
- [ ] Add Word numbering definitions for ordered lists and bullets
- [ ] Section titles: justified, not left-aligned
- [ ] Cover block: centered, after=0

### Phase 3: Content Rendering (contentRenderer.ts)
- [ ] Change all font references from Arial to Calibri
- [ ] Update spacing: after=120 → 160, line from 1.15*240 → 259
- [ ] ListItem: use Word numbered list instead of indent
- [ ] Section development headings: numbered list with bold caps

### Phase 4: Tables (tableBuilder.ts)
- [ ] Rewrite buildSummaryTable with Urapanes formatting
- [ ] Gray header (#D9D9D9), explicit column widths, cell margins
- [ ] Single-line spacing inside cells
- [ ] Change font from Arial to Calibri

### Phase 5: Voting Results (documentAssembler.ts)
- [ ] Remove detail voting tables from body
- [ ] Add "Ver anexo de acta de votación detallada." bullet note
- [ ] Keep detail tables only for separate annex document (future)

---

## 11. FILES TO MODIFY

| File | Changes |
|------|---------|
| `shared/src/types/templateTypes.ts` | Add optional fields if needed (coverLines, numberingStyle) |
| `fannery/src/documentSetup.ts` | Margins, font, spacing defaults, header/footer |
| `fannery/src/documentAssembler.ts` | Cover block, numbering defs, section rendering, remove detail tables |
| `fannery/src/contentRenderer.ts` | Font → Calibri, spacing values, list numbering |
| `fannery/src/tableBuilder.ts` | Complete rewrite of summary table format |
| `fannery/src/fanneryService.ts` | Update loadTemplate default values |

---

## 12. REFERENCE XML PATTERNS

See the user's original specification for exact OOXML patterns for:
- Normal body paragraph
- Bold inline paragraph
- Section title
- Numbered list item
- Development section heading
- Complete voting table (header + data rows)
- Annex reference note
