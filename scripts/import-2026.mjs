// scripts/import-2026.mjs
//
// Imports the Rankings 2026 CSV. Meetings 150-153 are already in the database;
// this script only processes meeting #154 (April 24, 2026) which was previously
// a placeholder "scheduled" entry and now has real contribution/vote data.
//
// The 2026 CSV introduces "Other Jake W." for Jake Weber, while the regular
// "Jake W." column remains Jake Westrich (who maintains the spreadsheet).
//
// Run: node scripts/import-2026.mjs

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

// Full short-name → email map (corrected after post-migration fixes).
// Jake W.   = Jake Westrich  (spreadsheet maintainer)
// Steve S.  = Steve Schaefer (confirmed)
// Brian Li. = Brian Linneman (confirmed via old emails, alumni)
// Other Jake W. = Jake Weber (new in 2026 file)
const SHORT_NAME_TO_EMAIL = {
  'Aaron T.':      'thesinam@gmail.com',
  'Alex M.':       'maloshas@gmail.com',
  'Alex S.':       'stevenakuc@gmail.com',
  'Allen M.':      'wamoellmann@gmail.com',
  'Andrew F.':     'fowler.andrew113@gmail.com',
  'Andrew P.':     'aprentovic@gmail.com',
  'Andrew S.':     'astraus397@gmail.com',
  'Anfernee A.':   'anfernee.arazoza1@gmail.com',
  'Annie H.':      'annie.e.ferguson@gmail.com',
  'Ben S.':        'benjo9876@gmail.com',
  'Ben W.':        'b.wichner@gmail.com',
  'Bill K.':       '222wck@gmail.com',
  'Bobby T.':      'Bobby.Trefilek@outlook.com',
  'Brian La.':     'bnlaughlin75@gmail.com',
  'Brian Li.':     'Brian.Linneman@plantemoran.com',
  'Carl R.':       'carlreed28@gmail.com',
  'Charlie D.':    'cdorn05@gmail.com',
  'Chris J.':      'chris134j@gmail.com',
  'Chris Mo.':     'moormacm@gmail.com',
  'Chris My.':     'myers.christopherj@gmail.com',
  'Colin J.':      'colinj.ccj@gmail.com',
  'Cory P.':       'cjperfetta@gmail.com',
  'Darrell L.':    'Darrell.Larsen@kraftheinzcompany.com',
  'Dave E.':       'ebbelerdr@gmail.com',
  'David A.':      'olasyn@gmail.com',
  'DJ W.':         'deejw.1113@gmail.com',
  'Donny H.':      'dkherrmann9@gmail.com',
  'Drew B.':       'bolubasza1@gmail.com',
  'Dustin S.':     'dtschneider84@gmail.com',
  'Eric A.':       'eric.ankenman@gmail.com',
  'Eric H.':       'hennel66@aol.com',
  'Erik W.':       'erikdwallace@gmail.com',
  'Forrest T.':    'w100frt@gmail.com',
  'Greg A.':       'gahlberg92@gmail.com',
  'Jake W.':       'jake.westrich@gmail.com',      // Westrich = spreadsheet maintainer
  'Other Jake W.': 'jakeweber@gmail.com',           // Weber = newer regular
  'Jason F.':      'jason.ferayorni@gmail.com',
  'Jason M.':      'jason.a.monahan@gmail.com',
  'Jayson L.':     'jaysonlindsay@gmail.com',
  'Jeremy S.':     'j.starry1950@gmail.com',
  'Jesse J.':      'jessejamesfour@gmail.com',
  'Jim B.':        'longbourder@gmail.com',
  'Jim C.':        'Jchristman@dreeshomes.com',
  'Joe J.':        'josephajones@gmail.com',
  'John S.':       'HeyJohnstahly@gmail.com',
  'Josh R.':       'josh_robbs@hotmail.com',
  'Juan B.':       'juangui404@hotmail.com',
  'Katie S.':      'katie.hoeper@gmail.com',
  'Kevin W.':      'Kevin.e.wallace@icloud.com',
  'Lauren D.':     'kdlauren10@yahoo.com',
  'Lee M.':        'Meyer.Lee.a@gmail.com',
  'Maridee R.':    'maridee.robinson@gmail.com',
  'Mark A.':       'mark@brinkbrewing.com',
  'Mark N.':       'mneyer@gmail.com',
  'Matt G.':       'matthew.t.gold@gmail.com',
  'Matt S.':       'masiefke@gmail.com',
  'Matt T.':       'thomsomc@gmail.com',
  'Matthew S.':    'msweeterman24@icloud.com',
  'Merritt W.':    'mwichner@aol.com',
  'Michael P.':    'mjpurves27@gmail.com',
  'Mike M.':       'meyers74@gmail.com',
  'Nick K.':       'nkernanjd@gmail.com',
  'Paul K.':       'pkrehbs@gmail.com',
  'Paul W.':       'pauljwestrich@gmail.com',
  'Phil H.':       'henderpp@gmail.com',
  'Phil W.':       'pwy02@aol.com',
  'Renee K.':      'kinkopr@gmail.com',
  'Rick S.':       'rthki26@gmail.com',
  'Rob C.':        'cassidyrt@gmail.com',
  'Ryan F.':       'ryanfowlermedia@gmail.com',
  'Sam E.':        'sam.eckroth@gmail.com',
  'Sam S.':        'ssaeli7@gmail.com',
  'Sara P.':       'smallblonde1@gmail.com',
  'Sarah G.':      'gagnon.sarah@gmail.com',
  'Scott T.':      'gobearcats@hotmail.com',
  'Steve B.':      'stevebromberg2004@yahoo.com',
  'Steve M.':      'smalosh@aol.com',
  'Steve P.':      'steve.polleys@gmail.com',
  'Steve S.':      'schaeferstephenf@yahoo.com',   // Schaefer confirmed
  'Tim H.':        'sdgtattoo@gmail.com',
  'Tony H.':       'anthoant@gmail.com',
  'Tony W.':       'tonywehby@gmail.com',
  'Trent D.':      'trentdues@gmail.com',
  'Wes B.':        'batty21385@yahoo.com',
  'Zach M.':       'maloshzp@gmail.com',
  // Historical placeholder accounts
  'Adam H.':       'historical.adam.h@bookclub.placeholder',
  'Adam W.':       'historical.adam.w@bookclub.placeholder',
  'Alex Ha.':      'historical.alex.ha@bookclub.placeholder',
  'Alex He.':      'historical.alex.he@bookclub.placeholder',
  'Ben C.':        'historical.ben.c@bookclub.placeholder',
  'Brant C.':      'historical.brant.c@bookclub.placeholder',
  'Charlie M.':    'historical.charlie.m@bookclub.placeholder',
  'Chelsea P.':    'historical.chelsea.p@bookclub.placeholder',
  'Chris G.':      'historical.chris.g@bookclub.placeholder',
  'Dan S.':        'historical.dan.s@bookclub.placeholder',
  'Dave S.':       'historical.dave.s@bookclub.placeholder',
  'David J.':      'historical.david.j@bookclub.placeholder',
  'David W.':      'historical.david.w@bookclub.placeholder',
  'Denis M.':      'historical.denis.m@bookclub.placeholder',
  'Dick K.':       'historical.dick.k@bookclub.placeholder',
  'Eric B.':       'historical.eric.b@bookclub.placeholder',
  'Frank B.':      'historical.frank.b@bookclub.placeholder',
  'Ian S.':        'historical.ian.s@bookclub.placeholder',
  'James E.':      'historical.james.e@bookclub.placeholder',
  'Jason S.':      'historical.jason.s@bookclub.placeholder',
  'Joe C.':        'historical.joe.c@bookclub.placeholder',
  'Joe S.':        'historical.joe.s@bookclub.placeholder',
  'Joel B.':       'historical.joel.b@bookclub.placeholder',
  'John V.':       'historical.john.v@bookclub.placeholder',
  'Jordyn P.':     'historical.jordyn.p@bookclub.placeholder',
  'Josh J.':       'historical.josh.j@bookclub.placeholder',
  'Kevin V.':      'historical.kevin.v@bookclub.placeholder',
  'Matt A.':       'historical.matt.a@bookclub.placeholder',
  'Mike V.':       'historical.mike.v@bookclub.placeholder',
  'Nate M.':       'historical.nate.m@bookclub.placeholder',
  'OJ W.':         'historical.oj.w@bookclub.placeholder',
  'Paul H.':       'historical.paul.h@bookclub.placeholder',
  'Rachel H.':     'historical.rachel.h@bookclub.placeholder',
  'Richard A.':    'historical.richard.a@bookclub.placeholder',
  'Rusty O.':      'historical.rusty.o@bookclub.placeholder',
  'Ryan Y.':       'historical.ryan.y@bookclub.placeholder',
  'Scott M.':      'historical.scott.m@bookclub.placeholder',
  'Shelley B.':    'historical.shelley.b@bookclub.placeholder',
  'Steve D.':      'historical.steve.d@bookclub.placeholder',
  'Steve W.':      'historical.steve.w@bookclub.placeholder',
  'Stuart W.':     'historical.stuart.w@bookclub.placeholder',
  'Tyler S.':      'historical.tyler.s@bookclub.placeholder',
  'Chris M.':      'historical.chris.m@bookclub.placeholder',
  'Renee W.':      'historical.renee.w@bookclub.placeholder',
}

function parseDate(dateStr) {
  if (!dateStr) return null
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  const [m, d, y] = parts.map(Number)
  return new Date(Date.UTC(y, m - 1, d, 17, 0, 0)).toISOString()
}

function primaryContributor(raw) {
  let name = (raw || '').trim().split(/\s*\/\s*|\s+and\s+/)[0].trim()
  if (name.toLowerCase() === 'retrial') return null
  if (/^[A-Z][a-z]+ [A-Z]$/.test(name)) name += '.'
  return name || null
}

async function main() {
  // ── Load club + build membership lookup ────────────────────────────────────
  const { data: club } = await sb.from('clubs').select('id').eq('slug', 'book-club-cincinnati').single()
  if (!club) { console.error('Club not found'); process.exit(1) }

  const { data: authData } = await sb.auth.admin.listUsers({ perPage: 1000 })
  const authByEmail = {}
  for (const u of authData.users) authByEmail[u.email.toLowerCase()] = u

  const { data: allMemberships } = await sb
    .from('memberships')
    .select('id, user_id')
    .eq('club_id', club.id)

  // membershipId keyed by userId
  const membershipIdByUserId = {}
  for (const ms of allMemberships) membershipIdByUserId[ms.user_id] = ms.id

  // Reverse: membershipId → userId (for self-vote detection)
  const userIdByMembershipId = {}
  for (const ms of allMemberships) userIdByMembershipId[ms.id] = ms.user_id

  // shortName → membershipId (the main lookup used during import)
  const membershipByShortName = {}
  for (const [shortName, email] of Object.entries(SHORT_NAME_TO_EMAIL)) {
    const auth = authByEmail[email.toLowerCase()]
    if (!auth) continue
    const msId = membershipIdByUserId[auth.id]
    if (msId) membershipByShortName[shortName] = msId
  }

  // ── Load CSV ───────────────────────────────────────────────────────────────
  const raw = readFileSync(
    join(DATA_DIR, 'Book Club_ Official Book Rankings - Rankings 2026.csv'),
    'utf8'
  ).replace(/^﻿/, '')
  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true })

  const allKeys   = Object.keys(rows[0])
  const memberCols = allKeys.slice(allKeys.indexOf('Composite') + 1)

  // Only process meeting #154 — everything else is already imported
  const newRows = rows.filter(r => parseInt(r['Meeting No.']) === 154)
  console.log(`Meeting #154: ${newRows.length} contributions to import`)
  if (!newRows.length) { console.log('Nothing to do.'); return }

  // ── Update meeting #154: real date + completed status ─────────────────────
  const realDate         = parseDate(newRows[0]['Date'])
  const hostShortName    = (newRows[0]['Host'] || '').trim()
  const hostMembershipId = membershipByShortName[hostShortName] || null

  const { error: updateErr } = await sb
    .from('meetings')
    .update({ held_at: realDate, status: 'completed', host_membership_id: hostMembershipId })
    .eq('club_id', club.id)
    .eq('meeting_number', 154)

  if (updateErr) { console.error('Error updating meeting #154:', updateErr.message); process.exit(1) }
  console.log(`Updated meeting #154 → completed on ${realDate?.slice(0, 10)}, host: ${hostShortName}`)

  const { data: meeting } = await sb
    .from('meetings')
    .select('id')
    .eq('club_id', club.id)
    .eq('meeting_number', 154)
    .single()

  // ── Import contributions and votes ─────────────────────────────────────────
  let contribCount = 0, voteCount = 0, skipCount = 0

  for (const row of newRows) {
    const beerName = (row['Book'] || '').trim()
    if (!beerName) { skipCount++; continue }

    // Find or create the offering in the club catalog
    let { data: offering } = await sb
      .from('offerings')
      .select('id')
      .eq('club_id', club.id)
      .ilike('name', beerName)
      .maybeSingle()

    if (!offering) {
      const { data: created, error } = await sb
        .from('offerings')
        .insert({ club_id: club.id, name: beerName, producer: row['Publisher'] || null, category: row['Category'] || null, style: row['Subcategory'] || null })
        .select('id')
        .single()
      if (error) { console.warn(`  Could not create offering "${beerName}":`, error.message); skipCount++; continue }
      offering = created
    }

    // Resolve contributor
    const contribShortName    = primaryContributor(row['Contributor'])
    const contributorMsId     = contribShortName ? membershipByShortName[contribShortName] : null
    if (!contributorMsId) {
      console.warn(`  SKIP unknown contributor "${row['Contributor']}" (${beerName})`)
      skipCount++; continue
    }

    const compositeScore = row['Composite'] ? parseFloat(row['Composite']) : null

    const { data: contribution, error: contribErr } = await sb
      .from('contributions')
      .insert({ meeting_id: meeting.id, offering_id: offering.id, contributor_id: contributorMsId, actor_id: contributorMsId, composite_score: compositeScore })
      .select('id')
      .single()

    if (contribErr) {
      console.warn(`  SKIP "${beerName}":`, contribErr.message)
      skipCount++; continue
    }
    contribCount++

    // Build vote rows for every member column with a non-empty score
    const votes = []
    for (const col of memberCols) {
      const scoreStr = (row[col] || '').trim()
      if (!scoreStr) continue
      const score = parseFloat(scoreStr)
      if (isNaN(score)) continue
      const voterMsId = membershipByShortName[col]
      if (!voterMsId) continue

      const voterUserId       = userIdByMembershipId[voterMsId]
      const contributorUserId = userIdByMembershipId[contributorMsId]
      const isSelfVote        = !!(voterUserId && contributorUserId && voterUserId === contributorUserId)

      votes.push({ contribution_id: contribution.id, voter_id: voterMsId, actor_id: voterMsId, score, is_self_vote: isSelfVote })
    }

    if (votes.length) {
      const { error: voteErr } = await sb.from('votes').insert(votes)
      if (voteErr) console.warn(`  Vote error for "${beerName}":`, voteErr.message)
      else voteCount += votes.length
    }

    console.log(`  ✓ ${beerName} (${contribShortName}) — composite ${compositeScore}, ${votes.length} votes`)
  }

  console.log(`\nDone: ${contribCount} contributions, ${voteCount} votes, ${skipCount} skipped`)
}

main().catch(console.error)
