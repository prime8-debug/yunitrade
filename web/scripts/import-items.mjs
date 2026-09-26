#!/usr/bin/env node
// Bulk-loads the item master from a Google-Sheets CSV export into Supabase `items`.
//
// Usage (from web/):
//   node --env-file=../.env.import.local scripts/import-items.mjs [path/to/ITEMCODES.csv]
//   (or: npm run import:items -- path/to/ITEMCODES.csv)
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service_role, NOT anon — this
// bypasses RLS to bulk-write). Never put the service_role key in web/.env.local or any
// VITE_-prefixed variable; it must never reach the browser bundle.
//
// Expected CSV headers (case-insensitive, matches the Google Sheet export):
//   ITEMCODE, Item Description, WIDTH, W-UNIT, LENGTH, L-UNIT, STOCKING UNIT MEASURE
//
// The script only prints what it WOULD do until you pass --commit.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const csvPath = args.find((a) => !a.startsWith('--')) ?? '../data/ITEMCODES.csv'

// --- Minimal RFC4180 CSV parser (handles quoted fields, "" escapes, embedded commas) ---
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// "3/8" -> 0.375, "1-1/8" -> 1.125, "48" -> 48, "n/a"/"" -> null
function parseDimension(raw) {
  const v = raw.trim()
  if (v === '' || v.toLowerCase() === 'n/a') return null
  if (/^\d+$/.test(v) || /^\d+\.\d+$/.test(v)) return Number(v)
  const mixed = v.match(/^(\d+)-(\d+)\/(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const simple = v.match(/^(\d+)\/(\d+)$/)
  if (simple) return Number(simple[1]) / Number(simple[2])
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined // undefined = "couldn't parse, flag it"
}

function clean(raw) {
  const v = (raw ?? '').trim()
  return v === '' || v.toLowerCase() === 'n/a' ? null : v
}

// --- Load + parse the CSV ---
const text = readFileSync(csvPath, 'utf-8')
const [headerRow, ...dataRows] = parseCsv(text)
const col = (name) => {
  const i = headerRow.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
  if (i === -1) throw new Error(`Missing expected column "${name}" in ${csvPath}`)
  return i
}
const idx = {
  code: col('ITEMCODE'),
  desc: col('Item Description'),
  width: col('WIDTH'),
  widthUnit: col('W-UNIT'),
  length: col('LENGTH'),
  lengthUnit: col('L-UNIT'),
  uom: col('STOCKING UNIT MEASURE'),
}

const seen = new Map() // upper(item_code) -> first row's original code
const duplicates = []
const badDimensions = []
const rows = []

for (const [lineNo, r] of dataRows.entries()) {
  const codeRaw = r[idx.code]?.trim()
  if (!codeRaw) continue
  const code = codeRaw.toUpperCase()

  if (seen.has(code)) {
    duplicates.push({ line: lineNo + 2, code: codeRaw, firstSeenAs: seen.get(code) })
    continue // keep the FIRST occurrence, skip the rest
  }
  seen.set(code, codeRaw)

  const width = parseDimension(r[idx.width] ?? '')
  const length = parseDimension(r[idx.length] ?? '')
  if (width === undefined) badDimensions.push({ line: lineNo + 2, code: codeRaw, field: 'WIDTH', value: r[idx.width] })
  if (length === undefined) badDimensions.push({ line: lineNo + 2, code: codeRaw, field: 'LENGTH', value: r[idx.length] })

  rows.push({
    item_code: code,
    description: clean(r[idx.desc]) ?? '',
    width: width ?? null,
    width_unit: clean(r[idx.widthUnit]),
    length: length ?? null,
    length_unit: clean(r[idx.lengthUnit]),
    uom: clean(r[idx.uom])?.toUpperCase() ?? null,
  })
}

console.log(`Parsed ${dataRows.length} data rows -> ${rows.length} unique item codes.\n`)

if (duplicates.length) {
  console.log(`⚠ ${duplicates.length} duplicate item code(s) — kept the FIRST row, skipped the rest:`)
  for (const d of duplicates) console.log(`   line ${d.line}: "${d.code}" (duplicates "${d.firstSeenAs}")`)
  console.log('   Fix these in the sheet (e.g. give each size its own code) and re-export if the skipped row matters.\n')
}

if (badDimensions.length) {
  console.log(`⚠ ${badDimensions.length} value(s) in WIDTH/LENGTH could not be read as a number and were saved as blank:`)
  for (const b of badDimensions) console.log(`   line ${b.line}: "${b.code}" ${b.field} = "${b.value}"`)
  console.log()
}

if (!commit) {
  console.log(`Dry run only — nothing was written. Sample of what would be upserted:`)
  console.table(rows.slice(0, 5))
  console.log(`\nRe-run with --commit to write all ${rows.length} rows to Supabase.`)
  process.exit(0)
}

// --- Upsert in batches (credentials only needed once we're actually writing) ---
const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Pass them via --env-file (see the header of this script).')
  process.exit(1)
}
const supabase = createClient(url, serviceKey)
const BATCH = 200
let written = 0
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  const { error } = await supabase.from('items').upsert(batch, { onConflict: 'item_code' })
  if (error) {
    console.error(`✗ Batch starting at row ${i} failed:`, error.message)
    process.exit(1)
  }
  written += batch.length
  console.log(`  upserted ${written}/${rows.length}...`)
}

console.log(`\n✓ Done. ${written} item codes created or updated.`)
if (duplicates.length || badDimensions.length) {
  console.log(`  (${duplicates.length} duplicate rows and ${badDimensions.length} unparsed dimensions were skipped/blanked — see warnings above.)`)
}
