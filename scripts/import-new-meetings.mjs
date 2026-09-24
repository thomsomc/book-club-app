// scripts/import-new-meetings.mjs
//
// General-purpose meeting importer. Reads directly from the xlsx spreadsheet,
// figures out which meetings are not yet in the database, and imports them.
//
// Usage:
//   node scripts/import-new-meetings.mjs             (dry run — preview only)
//   node scripts/import-new-meetings.mjs --commit    (actually write to DB)
//
// Safe to re-run at any time:
//   - Already-imported meetings are skipped automatically.
//   - New members without email addresses get placeholder accounts so their
//     scores are preserved. They can be upgraded to real accounts later.
//
// Workflow for catching up after meetings:
//   1. Download the latest Google Sheet as .xlsx and drop it in /data/
//      (replace the existing file)
//   2. Run: node scripts/import-new-meetings.mjs
//      to preview what would be imported
//   3. Run: node scripts/import-new-meetings.mjs --commit
//      to actually import

import { createClient } from '@supabase/supabase-js'
import pkg from 'xlsx'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const { readFile, utils } = pkg
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const XLSX_PATH    = join(__dirname, '..', 'data', 'Book Club_ Official Book Rankings.xlsx')
const SHEET_NAME   = 'Rankings 2026'   // update this when a new year's tab is added
const CLUB_SLUG    = 'book-club-cincinnati'
const SUPABASE_URL = 'https://blsailkqkgtgimqawuqy.supabase.co'

// Service role key bypasses Row Level Security — only used in scripts, never in the frontend.
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsc2FpbGtxa2d0Z2ltcWF3dXF5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzU2Nzc5MCwiZXhwIjoyMDkzMTQzNzkwfQ.yDi3sI6FPw0TZwgvSME409ejRRWZ7ELMkuAX5GkxmxA'

// Whether to actually write to the database (pass --commit to enable)
const DRY_RUN = !process.argv.includes('--commit')

// ── Known member registry ─────────────────────────────────────────────────────
// Maps the short "First L." column headers to email addresses.
// Members not in this list get auto-created as placeholder accounts.
// To upgrade a placeholder to a real account later, update their email here
// and re-run — the script will link their historical data to the real account.
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
  'Jake W.':       'jake.westrich@gmail.com',
  'Other Jake W.': 'jakeweber@gmail.com',
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
  'Steve S.':      'schaeferstephenf@yahoo.com',
  'Tim H.':        'sdgtattoo@gmail.com',
  'Tony H.':       'anthoant@gmail.com',
  'Tony W.':       'tonywehby@gmail.com',
  'Trent D.':      'trentdues@gmail.com',
  'Wes B.':        'batty21385@yahoo.com',
  'Zach M.':       'maloshzp@gmail.com',
  // Historical placeholder members (no real email, can't log in)
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

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert an Excel date serial number to an ISO string.
// Excel stores dates as days since Jan 0 1900, with a known leap-year bug
// (it counts 1900 as a leap year). The magic offset 25569 converts to Unix epoch days.
function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null
  const date = new Date((serial - 25569) * 86400 * 1000)
  // Set time to 17:00 UTC (≈1pm Eastern) so the date doesn't shift by timezone
  date.setUTCHours(17, 0, 0, 0)
  return date.toISOString()
}

// Take the first name from strings like "Sara P. and Matt T." or "Dave E. / Jake W."
function primaryName(raw) {
  if (!raw) return null
  const name = (raw + '').trim().split(/\s+and\s+|\s*\/\s*/)[0].trim()
  // Normalize "Charlie D" (no period) → "Charlie D."
  return /^[A-Z][a-z]+ [A-Z]$/.test(name) ? name + '.' : name
}

// Generate a placeholder email for a member we don't have a real email for.
// Converts "Jake M." → "placeholder.jake.m@bookclub.placeholder"
function placeholderEmail(shortName) {
  const slug = shortName.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/\.$/, '')
  return `placeholder.${slug}@bookclub.placeholder`
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) {
    console.log('=== DRY RUN — no changes will be written (pass --commit to import) ===\n')
  } else {
    console.log('=== IMPORTING — writing to database ===\n')
  }

  // ── Load the spreadsheet ───────────────────────────────────────────────────
  console.log(`Reading ${SHEET_NAME} from spreadsheet...`)
  const wb   = readFile(XLSX_PATH)
  const ws   = wb.Sheets[SHEET_NAME]
  if (!ws) {
    console.error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`)
    process.exit(1)
  }

  const rows = utils.sheet_to_json(ws, { defval: '' })
  console.log(`  ${rows.length} data rows loaded`)

  // Figure out which columns are member vote columns (everything after "Average")
  const allKeys      = Object.keys(rows[0])
  const avgIdx       = allKeys.findIndex(k => k === 'Average' || k === 'Composite')
  if (avgIdx === -1) {
    console.error('Could not find "Average" or "Composite" column — check the sheet structure.')
    process.exit(1)
  }
  const scoreColName = allKeys[avgIdx]           // "Average" or "Composite"
  const memberCols   = allKeys.slice(avgIdx + 1) // all vote columns

  // Group rows by meeting number
  const meetingGroups = new Map()
  for (const row of rows) {
    const num = parseInt(row['Meeting No.'])
    if (!num) continue
    if (!meetingGroups.has(num)) meetingGroups.set(num, [])
    meetingGroups.get(num).push(row)
  }
  console.log(`  Meeting numbers in spreadsheet: ${[...meetingGroups.keys()].sort((a,b)=>a-b).join(', ')}`)

  // ── Connect to Supabase ────────────────────────────────────────────────────
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Find the club ──────────────────────────────────────────────────────────
  const { data: club } = await sb.from('clubs').select('id').eq('slug', CLUB_SLUG).single()
  if (!club) { console.error('Club not found'); process.exit(1) }

  // ── Find which meetings are already complete in the DB ────────────────────
  const { data: existingMeetings } = await sb
    .from('meetings')
    .select('id, meeting_number, status')
    .eq('club_id', club.id)
    .not('meeting_number', 'is', null)

  // Maps: meeting_number → { id, status }
  const meetingByNumber = new Map()
  for (const m of existingMeetings ?? []) meetingByNumber.set(m.meeting_number, m)

  const completedNumbers = new Set(
    (existingMeetings ?? []).filter(m => m.status === 'completed').map(m => m.meeting_number)
  )

  const toImport = [...meetingGroups.keys()].filter(n => !completedNumbers.has(n)).sort((a,b)=>a-b)
  if (!toImport.length) {
    console.log('\n✅ Database is already up to date — nothing to import.')
    return
  }
  console.log(`\nMeetings to import: ${toImport.join(', ')}\n`)

  // ── Build membership lookup ────────────────────────────────────────────────
  // Load all existing auth users and memberships so we can resolve short names
  const { data: authData } = await sb.auth.admin.listUsers({ perPage: 1000 })
  const authByEmail = {}
  for (const u of authData.users) authByEmail[u.email.toLowerCase()] = u

  const { data: allMemberships } = await sb
    .from('memberships').select('id, user_id').eq('club_id', club.id)

  const membershipIdByUserId = {}
  const userIdByMembershipId = {}
  for (const ms of allMemberships ?? []) {
    membershipIdByUserId[ms.user_id] = ms.id
    userIdByMembershipId[ms.id]      = ms.user_id
  }

  // Resolve or auto-create a membership for a given short name.
  // Returns the membership ID, or null if it can't be resolved.
  async function resolveMembership(shortName) {
    if (!shortName) return null

    // Look up the email — use known registry or auto-generate a placeholder
    let email = SHORT_NAME_TO_EMAIL[shortName]
    let isNew  = false

    if (!email) {
      email  = placeholderEmail(shortName)
      isNew  = true
      console.log(`  ⚠ Unknown member "${shortName}" — will create placeholder account`)
    }

    const emailLower = email.toLowerCase()

    // Find or create the auth user
    let user = authByEmail[emailLower]
    if (!user) {
      if (DRY_RUN) {
        console.log(`  [dry run] Would create auth user: ${shortName} <${email}>`)
        return null
      }
      const { data, error } = await sb.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { display_name: shortName },
      })
      if (error) { console.warn(`  Could not create user ${shortName}: ${error.message}`); return null }
      user = data.user
      authByEmail[emailLower] = user
      console.log(`  ✚ Created ${isNew ? 'placeholder' : ''} user: ${shortName}`)
    }

    // Find or create the membership
    let msId = membershipIdByUserId[user.id]
    if (!msId) {
      if (DRY_RUN) {
        console.log(`  [dry run] Would create membership for: ${shortName}`)
        return null
      }
      const { data, error } = await sb
        .from('memberships')
        .insert({ club_id: club.id, user_id: user.id, role: 'member', status: isNew ? 'inactive' : 'active' })
        .select('id')
        .single()
      if (error) { console.warn(`  Could not create membership for ${shortName}: ${error.message}`); return null }
      msId = data.id
      membershipIdByUserId[user.id] = msId
      userIdByMembershipId[msId]    = user.id
    }

    return msId
  }

  // ── Import each new meeting ────────────────────────────────────────────────
  let totalContribs = 0, totalVotes = 0, totalSkipped = 0

  for (const meetingNum of toImport) {
    const meetingRows = meetingGroups.get(meetingNum)
    const firstRow    = meetingRows[0]
    const heldAt      = excelDateToISO(firstRow['Date'])
    const hostName    = primaryName(firstRow['Host'])
    const hostMsId    = await resolveMembership(hostName)

    console.log(`\n── Meeting #${meetingNum} (${heldAt?.slice(0,10)}, host: ${hostName}) ──`)

    if (DRY_RUN) {
      console.log(`  [dry run] Would import ${meetingRows.filter(r => r['Book']).length} contributions`)
      continue
    }

    // Create or update the meeting record
    let meetingId
    const existing = meetingByNumber.get(meetingNum)

    if (existing) {
      // Meeting exists as "scheduled" — update it to completed
      await sb.from('meetings').update({
        held_at: heldAt,
        status: 'completed',
        host_membership_id: hostMsId,
      }).eq('id', existing.id)
      meetingId = existing.id
      console.log(`  Updated existing meeting → completed`)
    } else {
      // Create a fresh meeting record
      const { data, error } = await sb.from('meetings').insert({
        club_id:            club.id,
        meeting_number:     meetingNum,
        held_at:            heldAt,
        status:             'completed',
        counts_for_record:  true,
        host_membership_id: hostMsId,
      }).select('id').single()
      if (error) { console.error(`  Could not create meeting #${meetingNum}:`, error.message); continue }
      meetingId = data.id
      console.log(`  Created meeting record`)
    }

    // ── Import contributions and votes for this meeting ──────────────────────
    for (const row of meetingRows) {
      const bookName = (row['Book'] || '').trim()
      if (!bookName) continue

      // Find or create the offering in the club catalog
      let { data: offering } = await sb
        .from('offerings')
        .select('id')
        .eq('club_id', club.id)
        .ilike('name', bookName)
        .maybeSingle()

      if (!offering) {
        const { data, error } = await sb.from('offerings').insert({
          club_id:  club.id,
          name:     bookName,
          producer: row['Publisher']    || null,
          category: row['Category']     || null,
          style:    row['Subcategory']  || null,
        }).select('id').single()
        if (error) { console.warn(`  Could not create offering "${bookName}":`, error.message); totalSkipped++; continue }
        offering = data
      }

      // Resolve the contributor
      const contribName = primaryName(row['Contributor'])
      const contribMsId = await resolveMembership(contribName)
      if (!contribMsId) {
        console.warn(`  SKIP "${bookName}": could not resolve contributor "${contribName}"`)
        totalSkipped++; continue
      }

      const avgScore = row[scoreColName] ? parseFloat(row[scoreColName]) : null

      const { data: contribution, error: contribErr } = await sb.from('contributions').insert({
        meeting_id:       meetingId,
        offering_id:      offering.id,
        contributor_id:   contribMsId,
        actor_id:         contribMsId,
        composite_score:  avgScore,
      }).select('id').single()

      if (contribErr) {
        // Unique constraint hit = already imported, skip silently
        if (contribErr.code !== '23505') console.warn(`  SKIP "${bookName}":`, contribErr.message)
        totalSkipped++; continue
      }
      totalContribs++

      // Build vote rows for every member column that has a score
      const votes = []
      for (const col of memberCols) {
        const scoreStr = (row[col] + '').trim()
        if (!scoreStr) continue
        const score = parseFloat(scoreStr)
        if (isNaN(score)) continue

        const voterMsId = await resolveMembership(col)
        if (!voterMsId) continue

        const voterUserId  = userIdByMembershipId[voterMsId]
        const contribUserId = userIdByMembershipId[contribMsId]
        const isSelfVote   = !!(voterUserId && contribUserId && voterUserId === contribUserId)

        votes.push({
          contribution_id: contribution.id,
          voter_id:        voterMsId,
          actor_id:        voterMsId,
          score,
          is_self_vote:    isSelfVote,
        })
      }

      if (votes.length) {
        const { error: voteErr } = await sb.from('votes').insert(votes)
        if (voteErr) console.warn(`  Vote error for "${bookName}":`, voteErr.message)
        else totalVotes += votes.length
      }

      console.log(`  ✓ ${bookName} (${contribName}) — avg ${avgScore}, ${votes.length} votes`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50))
  if (DRY_RUN) {
    console.log('Dry run complete. Run with --commit to import.')
  } else {
    console.log(`✅ Done: ${totalContribs} contributions, ${totalVotes} votes, ${totalSkipped} skipped`)
  }
}

main().catch(err => { console.error('\nFatal error:', err); process.exit(1) })
