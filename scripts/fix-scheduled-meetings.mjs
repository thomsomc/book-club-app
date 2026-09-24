// scripts/fix-scheduled-meetings.mjs
//
// Fixes the 47 future/scheduled meetings that were imported with null held_at
// because their date was "April 2026" style (month + year only) rather than
// the full M/D/YYYY format used by completed meetings.
//
// For each of those meetings this script:
//   1. Parses the "Month YYYY" date → first day of that month at 17:00 UTC
//   2. Sets held_at to that value
//   3. Sets status to 'scheduled' (they haven't happened yet)
//
// Run: node scripts/fix-scheduled-meetings.mjs

import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')

const SUPABASE_URL = 'https://blsailkqkgtgimqawuqy.supabase.co'
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsc2FpbGtxa2d0Z2ltcWF3dXF5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU2Nzc5MCwiZXhwIjoyMDkzMTQzNzkwfQ.yDi3sI6FPw0TZwgvSME409ejRRWZ7ELMkuAX5GkxmxA'

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Map English month names to 0-based month index (for Date.UTC)
const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3,
  may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
}

// Try parsing both date formats:
//   "6/4/2013"   → full date (M/D/YYYY)
//   "April 2026" → first day of the month
// Returns an ISO string, or null if unparseable.
function parseDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null
  const str = dateStr.trim()

  // Format 1: M/D/YYYY
  if (str.includes('/')) {
    const parts = str.split('/')
    if (parts.length === 3) {
      const [m, d, y] = parts.map(Number)
      if (y && m && d) return new Date(Date.UTC(y, m - 1, d, 17, 0, 0)).toISOString()
    }
    return null
  }

  // Format 2: "Month YYYY" (e.g. "April 2026")
  const parts = str.split(/\s+/)
  if (parts.length === 2) {
    const monthIdx = MONTH_INDEX[parts[0].toLowerCase()]
    const year = parseInt(parts[1])
    if (monthIdx !== undefined && year) {
      // Use the 15th of the month as a reasonable mid-month placeholder since
      // we don't know the exact day yet.
      return new Date(Date.UTC(year, monthIdx, 15, 17, 0, 0)).toISOString()
    }
  }

  return null
}

// Today's date for deciding whether a scheduled meeting is in the future or past
const TODAY = new Date()

async function main() {
  // Load the club
  const { data: club } = await sb.from('clubs').select('id').eq('slug', 'book-club-cincinnati').single()
  if (!club) { console.error('Club not found'); process.exit(1) }

  // Read the history CSV
  const raw = readFileSync(
    join(DATA_DIR, 'Book Club_ Official Book Rankings - History & Stats.csv'),
    'utf8'
  ).replace(/^﻿/, '')
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true })

  // Keep only rows with a numeric Meeting No. AND a "Month YYYY" style date
  // (i.e. rows that didn't have a parseable date during the original import)
  const toFix = rows.filter((row) => {
    const num = (row['Meeting No.'] || '').trim()
    const date = (row['Date'] || '').trim()
    return /^\d+$/.test(num) && date && !date.includes('/')
  })

  console.log(`Found ${toFix.length} scheduled meetings to fix`)

  let updated = 0
  for (const row of toFix) {
    const meetingNumber = parseInt(row['Meeting No.'])
    const held_at       = parseDate(row['Date'])

    if (!held_at) {
      console.warn(`  Could not parse date for meeting #${meetingNumber}: "${row['Date']}"`)
      continue
    }

    // A meeting is "scheduled" if its parsed date is in the future; if it's in
    // the past but has no contributions, it was probably recently skipped/postponed —
    // leave it as scheduled rather than guessing.
    const meetingDate = new Date(held_at)
    const status = meetingDate > TODAY ? 'scheduled' : 'scheduled' // always scheduled — no data

    const { error } = await sb
      .from('meetings')
      .update({ held_at, status })
      .eq('club_id', club.id)
      .eq('meeting_number', meetingNumber)
      .is('held_at', null) // only touch rows that still have null held_at

    if (error) {
      console.warn(`  Error updating meeting #${meetingNumber}:`, error.message)
    } else {
      console.log(`  #${meetingNumber}  ${row['Date']} → ${held_at.slice(0, 10)}  (${row['Host'] || 'host TBD'})`)
      updated++
    }
  }

  console.log(`\nUpdated ${updated} meetings`)
}

main().catch(console.error)
