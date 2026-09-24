#!/usr/bin/env node
// scripts/migrate.mjs
//
// One-time historical data migration for Book Club App.
// Reads three CSV files from /data and populates Supabase:
//   - Dist. List.csv           → member emails (used for name → email mapping)
//   - History & Stats.csv      → 153 historical meetings
//   - Individual Rankings.csv  → 1,443 contributions + all individual vote scores
//
// Run:  node scripts/migrate.mjs
// Safe to re-run: club/user/membership phases use upsert.
//                 Meeting/contribution/vote phase skips if already imported.

import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')

// ── Supabase config ───────────────────────────────────────────────────────────
// Service role key bypasses RLS — never use this in frontend code.
const SUPABASE_URL = 'https://blsailkqkgtgimqawuqy.supabase.co'
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsc2FpbGtxa2d0Z2ltcWF3dXF5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU2Nzc5MCwiZXhwIjoyMDkzMTQzNzkwfQ.yDi3sI6FPw0TZwgvSME409ejRRWZ7ELMkuAX5GkxmxA'

const CLUB_NAME  = 'Book Club'
const CLUB_SLUG  = 'book-club-cincinnati'

// Matt Thomson already has an auth account from app setup — he becomes owner.
const OWNER_EMAIL = 'thomsomc@gmail.com'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Member registry ───────────────────────────────────────────────────────────
// Maps the short "First L." column headers used in the spreadsheet to full
// names and real email addresses from the distribution list.
//
// Mapping notes / judgment calls:
//   "Jake W."   → Jake Westrich. He maintains the spreadsheet, so "Jake W."
//                 is him. Jake Weber appears as "Other Jake W." in the 2026
//                 data onward; he has no historical scoring column.
//   "Steve S."  → Steve Schaefer. Confirmed by the club; Sonderman is on the
//                 dist list but does not have a scoring column.
//   "Brian Li." → Brian Linneman (Brian.Linneman@plantemoran.com). Confirmed via
//                 old club emails; he is no longer on the dist list (alumni).
//   "Donny H."  → Donald Herrmann ("Donny" as nickname for Donald).
//   "Phil H."   → Phillip Henderson (common short form "Phil").
//   "Mark A."   → "Mark" at Brink Brewing — the dist list has only his first
//                 name; we preserve that as the display name.
//
// Members tagged with "@bookclub.placeholder" have no real email in the
// distribution list — they're historical attendees no longer active. Their
// auth accounts are created with fake emails; they can't log in. Their
// historical vote and contribution data is preserved.
const MEMBER_REGISTRY = [
  // ── Active / dist-list members ────────────────────────────────────────────
  { shortName: 'Aaron T.',    displayName: 'Aaron Thessing',    email: 'thesinam@gmail.com' },
  { shortName: 'Alex M.',     displayName: 'Alex Malosh',        email: 'maloshas@gmail.com' },
  { shortName: 'Alex S.',     displayName: 'Alex Stevens',       email: 'stevenakuc@gmail.com' },
  { shortName: 'Allen M.',    displayName: 'Allen Moellmann',    email: 'wamoellmann@gmail.com' },
  { shortName: 'Andrew F.',   displayName: 'Andrew Fowler',      email: 'fowler.andrew113@gmail.com' },
  { shortName: 'Andrew P.',   displayName: 'Andrew Prentovic',   email: 'aprentovic@gmail.com' },
  { shortName: 'Andrew S.',   displayName: 'Andrew Straus',      email: 'astraus397@gmail.com' },
  { shortName: 'Anfernee A.', displayName: 'Anfernee Arazoza',   email: 'anfernee.arazoza1@gmail.com' },
  { shortName: 'Annie H.',    displayName: 'Annie Henderson',    email: 'annie.e.ferguson@gmail.com' },
  { shortName: 'Ben S.',      displayName: 'Ben Simpson',        email: 'benjo9876@gmail.com' },
  { shortName: 'Ben W.',      displayName: 'Ben Wichner',        email: 'b.wichner@gmail.com' },
  { shortName: 'Bill K.',     displayName: 'Bill Kellie',        email: '222wck@gmail.com' },
  { shortName: 'Bobby T.',    displayName: 'Bobby Trefilek',     email: 'Bobby.Trefilek@outlook.com' },
  { shortName: 'Brian La.',   displayName: 'Brian Laughlin',     email: 'bnlaughlin75@gmail.com' },
  { shortName: 'Brian Li.',   displayName: 'Brian Linneman',     email: 'Brian.Linneman@plantemoran.com' },
  { shortName: 'Carl R.',     displayName: 'Carl Reed',          email: 'carlreed28@gmail.com' },
  { shortName: 'Charlie D.',  displayName: 'Charlie Dorn',       email: 'cdorn05@gmail.com' },
  { shortName: 'Chris J.',    displayName: 'Chris Johnson',      email: 'chris134j@gmail.com' },
  { shortName: 'Chris Mo.',   displayName: 'Chris Moorman',      email: 'moormacm@gmail.com' },
  { shortName: 'Chris My.',   displayName: 'Chris Myers',        email: 'myers.christopherj@gmail.com' },
  { shortName: 'Colin J.',    displayName: 'Colin Johnson',      email: 'colinj.ccj@gmail.com' },
  { shortName: 'Cory P.',     displayName: 'Cory Perfetta',      email: 'cjperfetta@gmail.com' },
  { shortName: 'Darrell L.',  displayName: 'Darrell Larson',     email: 'Darrell.Larsen@kraftheinzcompany.com' },
  { shortName: 'Dave E.',     displayName: 'Dave Ebbeler',       email: 'ebbelerdr@gmail.com' },
  { shortName: 'David A.',    displayName: 'David Allison',      email: 'olasyn@gmail.com' },
  { shortName: 'DJ W.',       displayName: 'DJ White',           email: 'deejw.1113@gmail.com' },
  { shortName: 'Donny H.',    displayName: 'Donald Herrmann',    email: 'dkherrmann9@gmail.com' },
  { shortName: 'Drew B.',     displayName: 'Drew Bolubasz',      email: 'bolubasza1@gmail.com' },
  { shortName: 'Dustin S.',   displayName: 'Dustin Schneider',   email: 'dtschneider84@gmail.com' },
  { shortName: 'Eric A.',     displayName: 'Eric Ankenman',      email: 'eric.ankenman@gmail.com' },
  { shortName: 'Eric H.',     displayName: 'Eric Hennel',        email: 'hennel66@aol.com' },
  { shortName: 'Erik W.',     displayName: 'Erik Wallace',       email: 'erikdwallace@gmail.com' },
  { shortName: 'Forrest T.',  displayName: 'Forrest Thompson',   email: 'w100frt@gmail.com' },
  { shortName: 'Greg A.',     displayName: 'Greg Ahlberg',       email: 'gahlberg92@gmail.com' },
  { shortName: 'Jake W.',     displayName: 'Jake Westrich',      email: 'jake.westrich@gmail.com' },
  { shortName: 'Jason F.',    displayName: 'Jason Ferayorni',    email: 'jason.ferayorni@gmail.com' },
  { shortName: 'Jason M.',    displayName: 'Jason Monahan',      email: 'jason.a.monahan@gmail.com' },
  { shortName: 'Jayson L.',   displayName: 'Jayson Lindsay',     email: 'jaysonlindsay@gmail.com' },
  { shortName: 'Jeremy S.',   displayName: 'Jeremy Starry',      email: 'j.starry1950@gmail.com' },
  { shortName: 'Jesse J.',    displayName: 'Jesse Johnson',      email: 'jessejamesfour@gmail.com' },
  { shortName: 'Jim B.',      displayName: 'Jim Bourdy',         email: 'longbourder@gmail.com' },
  { shortName: 'Jim C.',      displayName: 'Jim Christman',      email: 'Jchristman@dreeshomes.com' },
  { shortName: 'Joe J.',      displayName: 'Joe Jones',          email: 'josephajones@gmail.com' },
  { shortName: 'John S.',     displayName: 'John Stahly',        email: 'HeyJohnstahly@gmail.com' },
  { shortName: 'Josh R.',     displayName: 'Josh Robbs',         email: 'josh_robbs@hotmail.com' },
  { shortName: 'Juan B.',     displayName: 'Juan Botero',        email: 'juangui404@hotmail.com' },
  { shortName: 'Katie S.',    displayName: 'Katie Stahly',       email: 'katie.hoeper@gmail.com' },
  { shortName: 'Kevin W.',    displayName: 'Kevin Wallace',      email: 'Kevin.e.wallace@icloud.com' },
  { shortName: 'Lauren D.',   displayName: 'Lauren Dorn',        email: 'kdlauren10@yahoo.com' },
  { shortName: 'Lee M.',      displayName: 'Lee Meyer',          email: 'Meyer.Lee.a@gmail.com' },
  { shortName: 'Maridee R.',  displayName: 'Maridee Robinson',   email: 'maridee.robinson@gmail.com' },
  { shortName: 'Mark A.',     displayName: 'Mark',               email: 'mark@brinkbrewing.com' },
  { shortName: 'Mark N.',     displayName: 'Mark Neyer',         email: 'mneyer@gmail.com' },
  { shortName: 'Matt G.',     displayName: 'Matt Gold',          email: 'matthew.t.gold@gmail.com' },
  { shortName: 'Matt S.',     displayName: 'Matt Siefke',        email: 'masiefke@gmail.com' },
  { shortName: 'Matt T.',     displayName: 'Matt Thomson',       email: 'thomsomc@gmail.com' },
  { shortName: 'Matthew S.',  displayName: 'Matthew Sweeterman', email: 'msweeterman24@icloud.com' },
  { shortName: 'Merritt W.',  displayName: 'Merritt Wichner',    email: 'mwichner@aol.com' },
  { shortName: 'Michael P.',  displayName: 'Michael Purves',     email: 'mjpurves27@gmail.com' },
  { shortName: 'Mike M.',     displayName: 'Mike Meyers',        email: 'meyers74@gmail.com' },
  { shortName: 'Nick K.',     displayName: 'Nick Kernan',        email: 'nkernanjd@gmail.com' },
  { shortName: 'Paul K.',     displayName: 'Paul Krehbiel',      email: 'pkrehbs@gmail.com' },
  { shortName: 'Paul W.',     displayName: 'Paul Westrich',      email: 'pauljwestrich@gmail.com' },
  { shortName: 'Phil H.',     displayName: 'Phil Henderson',     email: 'henderpp@gmail.com' },
  { shortName: 'Phil W.',     displayName: 'Phil Wyatt',         email: 'pwy02@aol.com' },
  { shortName: 'Renee K.',    displayName: 'Renee Kinkop',       email: 'kinkopr@gmail.com' },
  { shortName: 'Rick S.',     displayName: 'Rick Stratman',      email: 'rthki26@gmail.com' },
  { shortName: 'Rob C.',      displayName: 'Rob Cassidy',        email: 'cassidyrt@gmail.com' },
  { shortName: 'Ryan F.',     displayName: 'Ryan Fowler',        email: 'ryanfowlermedia@gmail.com' },
  { shortName: 'Sam E.',      displayName: 'Sam Eckroth',        email: 'sam.eckroth@gmail.com' },
  { shortName: 'Sam S.',      displayName: 'Sam Saeli',          email: 'ssaeli7@gmail.com' },
  { shortName: 'Sara P.',     displayName: 'Sara Parsons',       email: 'smallblonde1@gmail.com' },
  { shortName: 'Sarah G.',    displayName: 'Sarah Gagnon',       email: 'gagnon.sarah@gmail.com' },
  { shortName: 'Scott T.',    displayName: 'Scott Taylor',       email: 'gobearcats@hotmail.com' },
  { shortName: 'Steve B.',    displayName: 'Steve Bromberg',     email: 'stevebromberg2004@yahoo.com' },
  { shortName: 'Steve M.',    displayName: 'Steve Malosh',       email: 'smalosh@aol.com' },
  { shortName: 'Steve P.',    displayName: 'Steve Polleys',      email: 'steve.polleys@gmail.com' },
  { shortName: 'Steve S.',    displayName: 'Steve Schaefer',     email: 'schaeferstephenf@yahoo.com' },
  { shortName: 'Tim H.',      displayName: 'Tim Hilderbrand',    email: 'sdgtattoo@gmail.com' },
  { shortName: 'Tony H.',     displayName: 'Tony Hill',          email: 'anthoant@gmail.com' },
  { shortName: 'Tony W.',     displayName: 'Tony Wehby',         email: 'tonywehby@gmail.com' },
  { shortName: 'Trent D.',    displayName: 'Trent Dues',         email: 'trentdues@gmail.com' },
  { shortName: 'Wes B.',      displayName: 'Wes Batto',          email: 'batty21385@yahoo.com' },
  { shortName: 'Zach M.',     displayName: 'Zach Malosh',        email: 'maloshzp@gmail.com' },

  // ── Historical members — no real email, placeholder accounts ─────────────
  // These people attended meetings but are no longer on the dist list.
  // Their historical vote data is preserved; they get role='alumni'.
  { shortName: 'Adam H.',     displayName: 'Adam H.',            email: 'historical.adam.h@bookclub.placeholder' },
  { shortName: 'Adam W.',     displayName: 'Adam W.',            email: 'historical.adam.w@bookclub.placeholder' },
  { shortName: 'Alex Ha.',    displayName: 'Alex Ha.',           email: 'historical.alex.ha@bookclub.placeholder' },
  { shortName: 'Alex He.',    displayName: 'Alex He.',           email: 'historical.alex.he@bookclub.placeholder' },
  { shortName: 'Ben C.',      displayName: 'Ben C.',             email: 'historical.ben.c@bookclub.placeholder' },
  { shortName: 'Brant C.',    displayName: 'Brant C.',           email: 'historical.brant.c@bookclub.placeholder' },
  { shortName: 'Charlie M.',  displayName: 'Charlie M.',         email: 'historical.charlie.m@bookclub.placeholder' },
  { shortName: 'Chelsea P.',  displayName: 'Chelsea P.',         email: 'historical.chelsea.p@bookclub.placeholder' },
  { shortName: 'Chris G.',    displayName: 'Chris G.',           email: 'historical.chris.g@bookclub.placeholder' },
  { shortName: 'Dan S.',      displayName: 'Dan S.',             email: 'historical.dan.s@bookclub.placeholder' },
  { shortName: 'Dave S.',     displayName: 'Dave S.',            email: 'historical.dave.s@bookclub.placeholder' },
  { shortName: 'David J.',    displayName: 'David J.',           email: 'historical.david.j@bookclub.placeholder' },
  { shortName: 'David W.',    displayName: 'David W.',           email: 'historical.david.w@bookclub.placeholder' },
  { shortName: 'Denis M.',    displayName: 'Denis M.',           email: 'historical.denis.m@bookclub.placeholder' },
  { shortName: 'Dick K.',     displayName: 'Dick K.',            email: 'historical.dick.k@bookclub.placeholder' },
  { shortName: 'Eric B.',     displayName: 'Eric B.',            email: 'historical.eric.b@bookclub.placeholder' },
  { shortName: 'Frank B.',    displayName: 'Frank B.',           email: 'historical.frank.b@bookclub.placeholder' },
  { shortName: 'Ian S.',      displayName: 'Ian S.',             email: 'historical.ian.s@bookclub.placeholder' },
  { shortName: 'James E.',    displayName: 'James E.',           email: 'historical.james.e@bookclub.placeholder' },
  { shortName: 'Jason S.',    displayName: 'Jason S.',           email: 'historical.jason.s@bookclub.placeholder' },
  { shortName: 'Joe C.',      displayName: 'Joe C.',             email: 'historical.joe.c@bookclub.placeholder' },
  { shortName: 'Joe S.',      displayName: 'Joe S.',             email: 'historical.joe.s@bookclub.placeholder' },
  { shortName: 'Joel B.',     displayName: 'Joel B.',            email: 'historical.joel.b@bookclub.placeholder' },
  { shortName: 'John V.',     displayName: 'John V.',            email: 'historical.john.v@bookclub.placeholder' },
  { shortName: 'Jordyn P.',   displayName: 'Jordyn P.',          email: 'historical.jordyn.p@bookclub.placeholder' },
  { shortName: 'Josh J.',     displayName: 'Josh J.',            email: 'historical.josh.j@bookclub.placeholder' },
  { shortName: 'Kevin V.',    displayName: 'Kevin V.',           email: 'historical.kevin.v@bookclub.placeholder' },
  { shortName: 'Matt A.',     displayName: 'Matt A.',            email: 'historical.matt.a@bookclub.placeholder' },
  { shortName: 'Mike V.',     displayName: 'Mike V.',            email: 'historical.mike.v@bookclub.placeholder' },
  { shortName: 'Nate M.',     displayName: 'Nate M.',            email: 'historical.nate.m@bookclub.placeholder' },
  { shortName: 'OJ W.',       displayName: 'OJ W.',              email: 'historical.oj.w@bookclub.placeholder' },
  { shortName: 'Paul H.',     displayName: 'Paul H.',            email: 'historical.paul.h@bookclub.placeholder' },
  { shortName: 'Rachel H.',   displayName: 'Rachel H.',          email: 'historical.rachel.h@bookclub.placeholder' },
  { shortName: 'Richard A.',  displayName: 'Richard A.',         email: 'historical.richard.a@bookclub.placeholder' },
  { shortName: 'Rusty O.',    displayName: 'Rusty O.',           email: 'historical.rusty.o@bookclub.placeholder' },
  { shortName: 'Ryan Y.',     displayName: 'Ryan Y.',            email: 'historical.ryan.y@bookclub.placeholder' },
  { shortName: 'Scott M.',    displayName: 'Scott M.',           email: 'historical.scott.m@bookclub.placeholder' },
  { shortName: 'Shelley B.',  displayName: 'Shelley B.',         email: 'historical.shelley.b@bookclub.placeholder' },
  { shortName: 'Steve D.',    displayName: 'Steve D.',           email: 'historical.steve.d@bookclub.placeholder' },
  { shortName: 'Steve W.',    displayName: 'Steve W.',           email: 'historical.steve.w@bookclub.placeholder' },
  { shortName: 'Stuart W.',   displayName: 'Stuart W.',          email: 'historical.stuart.w@bookclub.placeholder' },
  { shortName: 'Tyler S.',    displayName: 'Tyler S.',           email: 'historical.tyler.s@bookclub.placeholder' },
  // Name variants seen in the data that don't match the standard short-name format
  { shortName: 'Chris M.',   displayName: 'Chris M.',           email: 'historical.chris.m@bookclub.placeholder' },
  { shortName: 'Renee W.',   displayName: 'Renee W.',           email: 'historical.renee.w@bookclub.placeholder' },
]

// ── Dist-list members with no scoring column ──────────────────────────────────
// These people are on the email list but never had a dedicated vote column in
// the spreadsheet (or their column is covered by another person's short name).
// They get accounts and memberships but no historical vote data.
const EXTRA_MEMBERS = [
  { displayName: 'Jake Weber',      email: 'jakeweber@gmail.com' },      // "Other Jake W." in 2026+ data
  { displayName: 'Steve Sonderman', email: 'sonderman1@gmail.com' },     // on dist list, no scoring column
  { displayName: 'Nick Wendt',      email: 'nickwendt03@gmail.com' },
  { displayName: 'Sean Johnson',    email: 'seanjohnseo@gmail.com' },
  { displayName: 'Zack Coomer',     email: 'zachary.coomer@gmail.com' },
  { displayName: 'Danny Romanello', email: 'romanellod1@gmail.com' },
  { displayName: 'Liz Lowery',      email: 'lizardlowery@gmail.com' },
  { displayName: 'Steve Schaefer',  email: 'schaeferstephenf@yahoo.com' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadCsv(filename) {
  // Strip UTF-8 BOM (sometimes added by Google Sheets export) then parse.
  const raw = readFileSync(join(DATA_DIR, filename), 'utf8').replace(/^﻿/, '')
  return parse(raw, {
    columns: true,          // use first row as column headers
    skip_empty_lines: true,
    relax_column_count: true, // History CSV has ragged right side (member stats)
    trim: true,
  })
}

// Parse "M/D/YYYY" → ISO 8601 string at noon local time (so display dates
// don't shift by timezone when the app converts back to local time).
function parseDate(dateStr) {
  if (!dateStr) return null
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  const [m, d, y] = parts.map(Number)
  // Use UTC noon to avoid timezone boundary issues
  return new Date(Date.UTC(y, m - 1, d, 17, 0, 0)).toISOString() // 17:00 UTC ≈ 1pm ET
}

// Handle hosts like "Dave E. and Jake W." or "Dave E. / Jake W." — take first.
function parsePrimaryHost(hostStr) {
  if (!hostStr) return null
  return hostStr.split(/ and | \/ /)[0].trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Book Club Historical Data Migration ===\n')

  // ── 1. Load CSVs ───────────────────────────────────────────────────────────
  console.log('Loading CSV files...')
  const historyRows  = loadCsv('Book Club_ Official Book Rankings - History & Stats.csv')
  const rankingRows  = loadCsv('Book Club_ Official Book Rankings - Individual Rankings.csv')

  // The member vote columns live after the "Composite" column in Individual Rankings.
  // Since csv-parse returns an object per row, get the ordered keys from the first row
  // and slice off everything after "Composite".
  const firstRow = rankingRows[0]
  const allKeys = Object.keys(firstRow)
  const compositeIdx = allKeys.indexOf('Composite')
  if (compositeIdx === -1) {
    console.error('ERROR: Could not find "Composite" column in Individual Rankings.')
    process.exit(1)
  }
  const memberCols = allKeys.slice(compositeIdx + 1) // ["Aaron T.", "Adam H.", ...]

  console.log(`  History rows:  ${historyRows.length}`)
  console.log(`  Ranking rows:  ${rankingRows.length}`)
  console.log(`  Member columns: ${memberCols.length}`)

  // ── 2. Fetch existing auth users ───────────────────────────────────────────
  // So we can skip creating accounts that already exist (e.g. Matt Thomson).
  console.log('\nFetching existing auth users...')
  const { data: authData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) { console.error('Failed to list users:', listErr); process.exit(1) }

  // Build a lowercase-email → existing user map
  const existingByEmail = {}
  for (const u of authData.users) {
    existingByEmail[u.email.toLowerCase()] = u
  }
  console.log(`  ${authData.users.length} existing auth users found`)

  // ── 3. Create auth users for every member ──────────────────────────────────
  // supabase.auth.admin.createUser() with email_confirm:true creates the account
  // without sending any email. The handle_new_user DB trigger automatically
  // inserts a record into public.users with the display_name from user_metadata.
  console.log('\nCreating auth users...')

  const allMembers = [
    ...MEMBER_REGISTRY,
    ...EXTRA_MEMBERS.map((m) => ({ ...m, shortName: null })),
  ]

  // userId keyed by lowercase email
  const userIdByEmail = {}

  for (const member of allMembers) {
    const emailKey = member.email.toLowerCase()

    if (existingByEmail[emailKey]) {
      userIdByEmail[emailKey] = existingByEmail[emailKey].id
      process.stdout.write('.')
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: member.email,
        email_confirm: true, // pre-confirm, no email sent
        user_metadata: { display_name: member.displayName },
      })
      if (error) {
        console.error(`\n  WARN: Could not create ${member.displayName} <${member.email}>: ${error.message}`)
      } else {
        userIdByEmail[emailKey] = data.user.id
        process.stdout.write('+')
      }
      await sleep(80) // avoid auth rate-limit
    }
  }
  console.log(`\n  Done (${Object.keys(userIdByEmail).length} users ready)`)

  // Build shortName → userId for members that have a column in the spreadsheet
  const userIdByShortName = {}
  for (const m of MEMBER_REGISTRY) {
    const uid = userIdByEmail[m.email.toLowerCase()]
    if (uid) userIdByShortName[m.shortName] = uid
  }

  // ── 4. Create the club ─────────────────────────────────────────────────────
  console.log('\nUpserting club...')
  const { data: club, error: clubErr } = await supabase
    .from('clubs')
    .upsert({ name: CLUB_NAME, slug: CLUB_SLUG }, { onConflict: 'slug' })
    .select()
    .single()
  if (clubErr) { console.error('Club error:', clubErr); process.exit(1) }
  console.log(`  Club: "${club.name}"  id=${club.id}`)

  // ── 5. Create memberships ──────────────────────────────────────────────────
  console.log('\nUpserting memberships...')

  const membershipRows = []
  for (const member of allMembers) {
    const uid = userIdByEmail[member.email.toLowerCase()]
    if (!uid) continue

    const isOwner       = member.email.toLowerCase() === OWNER_EMAIL.toLowerCase()
    const isPlaceholder = member.email.includes('@bookclub.placeholder')

    membershipRows.push({
      club_id: club.id,
      user_id: uid,
      role:   isOwner ? 'owner' : 'member',
      // Historical-only (no real email) get status='inactive'; real members 'active'
      status: isPlaceholder ? 'inactive' : 'active',
    })
  }

  // Upsert in chunks — Supabase has a default row limit per request
  const CHUNK = 100
  const membershipIdByUserId = {}     // userId → membershipId
  const userIdByMembershipId = {}     // membershipId → userId (for self-vote detection)

  for (let i = 0; i < membershipRows.length; i += CHUNK) {
    const chunk = membershipRows.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('memberships')
      .upsert(chunk, { onConflict: 'club_id,user_id' })
      .select('id, user_id')
    if (error) { console.error('Membership error:', error); process.exit(1) }
    for (const row of data) {
      membershipIdByUserId[row.user_id] = row.id
      userIdByMembershipId[row.id] = row.user_id
    }
  }
  console.log(`  ${Object.keys(membershipIdByUserId).length} memberships ready`)

  // Convenience: shortName → membershipId (the most common lookup)
  const membershipByShortName = {}
  for (const [sn, uid] of Object.entries(userIdByShortName)) {
    if (membershipIdByUserId[uid]) membershipByShortName[sn] = membershipIdByUserId[uid]
  }

  // ── 6. Create meetings ─────────────────────────────────────────────────────
  // Check whether meetings have already been imported so re-running is safe.
  console.log('\nChecking for existing meetings...')
  const { count: existingMeetingCount } = await supabase
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .eq('club_id', club.id)
    .is('deleted_at', null)

  const meetingIdByNumber = {} // meeting_number → meeting UUID

  if (existingMeetingCount > 0) {
    // Already imported — load existing IDs so contributions phase can use them
    console.log(`  ${existingMeetingCount} meetings already imported, loading IDs...`)
    const { data: existingMeetings } = await supabase
      .from('meetings')
      .select('id, meeting_number')
      .eq('club_id', club.id)
      .is('deleted_at', null)
    for (const m of existingMeetings) {
      meetingIdByNumber[m.meeting_number] = m.id
    }
  } else {
    console.log('\nInserting meetings...')

    // Filter history rows to only rows that have a numeric Meeting No.
    // (the History CSV has member-stats rows on the right that share the same
    //  spreadsheet rows as the meeting rows — ignore those extra rows by
    //  requiring a valid meeting number)
    const meetingData = historyRows.filter((row) => /^\d+$/.test((row['Meeting No.'] || '').trim()))

    const rows = meetingData.map((row) => {
      const hostShortName      = parsePrimaryHost(row['Host'])
      const hostMembershipId   = hostShortName ? membershipByShortName[hostShortName] : null
      const theme              = (row['Theme'] && row['Theme'] !== 'None') ? row['Theme'] : null

      return {
        club_id:            club.id,
        meeting_number:     parseInt(row['Meeting No.']),
        title:              theme,             // use the theme as the meeting title
        held_at:            parseDate(row['Date']),
        host_membership_id: hostMembershipId || null,
        status:             'completed',
        counts_for_record:  true,
        metadata: {
          // Store attendee count and raw host string for reference
          attendees:  row['Attendees'] ? parseInt(row['Attendees']) : null,
          host_raw:   row['Host'] || null,
        },
      }
    })

    // Insert in chunks
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { data, error } = await supabase
        .from('meetings')
        .insert(chunk)
        .select('id, meeting_number')
      if (error) { console.error(`Meeting insert error at row ${i}:`, error); process.exit(1) }
      for (const m of data) {
        meetingIdByNumber[m.meeting_number] = m.id
      }
    }
    console.log(`  ${rows.length} meetings inserted`)
  }

  // ── 7. Create offerings ────────────────────────────────────────────────────
  // Deduplicate by normalized name before inserting — the same beer can appear
  // in multiple rows (brought to different meetings) but should only have one
  // offering record in the catalog.
  console.log('\nInserting offerings...')

  const { count: existingOfferingCount } = await supabase
    .from('offerings')
    .select('id', { count: 'exact', head: true })
    .eq('club_id', club.id)
    .is('deleted_at', null)

  const offeringIdByName = {} // normalizedName → offering UUID

  if (existingOfferingCount > 0) {
    console.log(`  ${existingOfferingCount} offerings already imported, loading IDs...`)
    // Load in pages since there could be many
    let page = 0
    while (true) {
      const { data } = await supabase
        .from('offerings')
        .select('id, name')
        .eq('club_id', club.id)
        .is('deleted_at', null)
        .range(page * 1000, page * 1000 + 999)
      if (!data || data.length === 0) break
      for (const o of data) offeringIdByName[o.name.toLowerCase()] = o.id
      if (data.length < 1000) break
      page++
    }
  } else {
    // Collect unique offerings from the rankings CSV
    const uniqueOfferings = new Map() // normalizedName → row data
    for (const row of rankingRows) {
      const name = (row['Book'] || '').trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (!uniqueOfferings.has(key)) {
        uniqueOfferings.set(key, {
          club_id:  club.id,
          name,
          producer: row['Publisher']    || null,
          category: row['Category']     || null,  // e.g. "IPA"
          style:    row['Subcategory']  || null,  // e.g. "Imperial IPA"
        })
      }
    }

    const offeringsList = [...uniqueOfferings.values()]
    console.log(`  ${offeringsList.length} unique offerings to insert`)

    for (let i = 0; i < offeringsList.length; i += CHUNK) {
      const chunk = offeringsList.slice(i, i + CHUNK)
      const { data, error } = await supabase
        .from('offerings')
        .insert(chunk)
        .select('id, name')
      if (error) { console.error(`Offering insert error at row ${i}:`, error); process.exit(1) }
      for (const o of data) offeringIdByName[o.name.toLowerCase()] = o.id
    }
    console.log(`  Done`)
  }

  // ── 8. Create contributions and votes ──────────────────────────────────────
  console.log('\nInserting contributions and votes...')

  // Only count contributions that belong to THIS club's meetings
  const clubMeetingIds = Object.values(meetingIdByNumber)
  const { count: existingContribCount } = await supabase
    .from('contributions')
    .select('id', { count: 'exact', head: true })
    .in('meeting_id', clubMeetingIds)
    .is('deleted_at', null)

  if (existingContribCount > 0) {
    console.log(`  ${existingContribCount} contributions already exist — inserting only new ones...`)
  }
  {
    let contribCount = 0
    let voteCount    = 0
    let skipCount    = 0

    for (const row of rankingRows) {
      const meetingNum = parseInt(row['Meeting No.'])
      const meetingId  = meetingIdByNumber[meetingNum]
      if (!meetingId) {
        console.warn(`  SKIP: no meeting for #${meetingNum} (row: ${row['Book']})`)
        skipCount++
        continue
      }

      // Normalize the contributor name. Some rows have multi-contributor strings like
      // "Ben W. / Jeremy S." or retrial markers like "Jake W. / Retrial". We always
      // credit the first person listed — the exact multi-contributor breakdown isn't
      // tracked in our schema at this level.
      let rawContributor = (row['Contributor'] || '').trim()

      // Split on "/" or "and" — take only the first person
      rawContributor = rawContributor.split(/\s*\/\s*|\s+and\s+/)[0].trim()

      // Strip the word "Retrial" in case it was the only thing left
      if (rawContributor.toLowerCase() === 'retrial') { skipCount++; continue }

      // Normalize: "Charlie D" (no trailing period) → "Charlie D."
      // Short names in the registry always end with a period.
      let contributorShortName = rawContributor
      if (/^[A-Z][a-z]+ [A-Z]$/.test(contributorShortName)) {
        contributorShortName += '.'
      }

      const contributorMembershipId = membershipByShortName[contributorShortName]
      if (!contributorMembershipId) {
        console.warn(`  SKIP: unknown contributor "${rawContributor}" → "${contributorShortName}" (${row['Book']})`)
        skipCount++
        continue
      }

      const beerName   = (row['Book'] || '').trim()
      const offeringId = offeringIdByName[beerName.toLowerCase()]
      if (!offeringId) {
        console.warn(`  SKIP: no offering found for "${beerName}"`)
        skipCount++
        continue
      }

      // Composite score is already calculated in the spreadsheet (excludes self-votes).
      // Trust the CSV value rather than recalculating — it's the source of truth.
      const compositeScore = row['Composite'] ? parseFloat(row['Composite']) : null

      const { data: contribution, error: contribErr } = await supabase
        .from('contributions')
        .insert({
          meeting_id:          meetingId,
          offering_id:         offeringId,
          contributor_id:      contributorMembershipId,
          actor_id:            contributorMembershipId, // same for historical data
          composite_score:     compositeScore,
          is_flagged_duplicate: false,
        })
        .select('id')
        .single()

      if (contribErr) {
        // Duplicate constraint (meeting_id, offering_id) — skip silently
        if (contribErr.code === '23505') {
          skipCount++
        } else {
          console.warn(`  WARN contrib "${beerName}" mtg #${meetingNum}:`, contribErr.message)
          skipCount++
        }
        continue
      }
      contribCount++

      // Build votes for every member column that has a non-empty score
      const votesToInsert = []
      for (const colName of memberCols) {
        const scoreStr = (row[colName] || '').trim()
        if (!scoreStr) continue

        const score = parseFloat(scoreStr)
        if (isNaN(score)) continue

        const voterMembershipId = membershipByShortName[colName]
        if (!voterMembershipId) continue // member column not mapped — skip

        // Self-vote: voter and contributor are the same auth user
        const voterUserId       = userIdByMembershipId[voterMembershipId]
        const contributorUserId = userIdByMembershipId[contributorMembershipId]
        const isSelfVote        = !!(voterUserId && contributorUserId && voterUserId === contributorUserId)

        votesToInsert.push({
          contribution_id: contribution.id,
          voter_id:        voterMembershipId,
          actor_id:        voterMembershipId,
          score,
          is_self_vote:    isSelfVote,
        })
      }

      if (votesToInsert.length > 0) {
        const { error: voteErr } = await supabase
          .from('votes')
          .insert(votesToInsert)
        if (voteErr) {
          console.warn(`  WARN votes for "${beerName}":`, voteErr.message)
        } else {
          voteCount += votesToInsert.length
        }
      }

      // Progress indicator every 100 contributions
      if (contribCount % 100 === 0) {
        process.stdout.write(`\r  Progress: ${contribCount} contributions, ${voteCount} votes...`)
      }
    }

    console.log(`\n\n  Contributions: ${contribCount}`)
    console.log(`  Votes:         ${voteCount}`)
    console.log(`  Skipped rows:  ${skipCount}`)
  }

  console.log('\n✅ Migration complete!')
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
