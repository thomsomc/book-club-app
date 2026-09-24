import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const DEFAULT_PAGE_SIZE = 10

// Returns a human-readable label for a meeting row.
function meetingLabel(m) {
  if (m.title) return m.title
  if (m.meeting_number) return `Meeting #${m.meeting_number}`
  return new Date(m.held_at).toLocaleDateString()
}

function defaultDateTimeLocal() {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  return d.toISOString().slice(0, 16)
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
})

// Shorter format used in duplicate-warning summaries (no time, no weekday)
const SHORT_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
})

// ── MeetingCard ──────────────────────────────────────────────────────────────
// Standard card for "later upcoming" and completed meetings.
// Accepts an optional preRegSection element for scheduled meetings —
// rendered inside a stopPropagation wrapper so clicks don't navigate.
function MeetingCard({ m, statsMap, isOwnerOrAdmin, onStatusChange, onClick, preRegSection }) {
  return (
    <div
      onClick={onClick}
      className="bg-gray-900 rounded-xl p-5 cursor-pointer hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate">{meetingLabel(m)}</h3>
          <p className="text-sm text-gray-400 mt-0.5">
            {DATE_FMT.format(new Date(m.held_at))}
          </p>
          {m.memberships?.users?.display_name && (
            <p className="text-xs text-gray-500 mt-0.5">
              Host: {m.memberships.users.display_name}
            </p>
          )}
          {m.status === 'completed' && statsMap[m.id] && (
            <p className="text-xs text-gray-500 mt-0.5">
              {statsMap[m.id].count} offering{statsMap[m.id].count !== 1 ? 's' : ''}
              {statsMap[m.id].avgScore != null && (
                <> · avg {statsMap[m.id].avgScore.toFixed(2)}</>
              )}
            </p>
          )}
        </div>

        {isOwnerOrAdmin && (
          <div className="shrink-0">
            {m.status === 'scheduled' && (
              <button
                onClick={e => onStatusChange(e, m.id, 'active')}
                className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-medium"
              >
                Start
              </button>
            )}
            {m.status === 'active' && (
              <button
                onClick={e => onStatusChange(e, m.id, 'completed')}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-medium"
              >
                End
              </button>
            )}
          </div>
        )}
      </div>

      {/* Pre-registration section — clicks here stop propagation so we don't navigate */}
      {preRegSection && (
        <div onClick={e => e.stopPropagation()} className="mt-4">
          {preRegSection}
        </div>
      )}
    </div>
  )
}

// ── MeetingsList ─────────────────────────────────────────────────────────────
export default function MeetingsList({ club, session, myRole }) {
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState([])
  const [members, setMembers]   = useState([])
  const [statsMap, setStatsMap] = useState({})
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  // Past meetings section controls
  const [selectedYear, setSelectedYear] = useState('all')
  const [showCount, setShowCount]       = useState(DEFAULT_PAGE_SIZE)

  // New meeting form fields
  const [heldAt, setHeldAt]                   = useState(defaultDateTimeLocal)
  const [title, setTitle]                     = useState('')
  const [hostId, setHostId]                   = useState('')
  const [meetingNumber, setMeetingNumber]     = useState('')
  const [countsForRecord, setCountsForRecord] = useState(true)

  // ── Pre-registration state ─────────────────────────────────────────────────
  // preRegs: map of meetingId -> { all: enrichedContribution[], mine: enrichedContribution | null }
  const [preRegs, setPreRegs]               = useState({})
  // expandedRegs: set of meetingIds where the full registrant list is expanded
  const [expandedRegs, setExpandedRegs]     = useState(new Set())
  // registeringFor: the meetingId whose inline form is currently open, or null
  const [registeringFor, setRegisteringFor] = useState(null)
  // Fields for the inline registration / edit form
  const [pickName, setPickName]             = useState('')
  const [pickProducer, setPickProducer]     = useState('')
  const [pickStyle, setPickStyle]           = useState('')
  const [pickAbv, setPickAbv]               = useState('')
  const [pickLoading, setPickLoading]       = useState(false)
  const [pickError, setPickError]           = useState(null)
  // pendingDuplicate: set when a duplicate is detected before registering —
  // holds the offering info and last-brought context for the confirmation screen.
  // Shape: { meetingId, offering: {id, name, producer}, lastBrought: {displayName, heldAt} | null }
  const [pendingDuplicate, setPendingDuplicate] = useState(null)

  const isOwnerOrAdmin = myRole === 'owner' || myRole === 'admin'

  useEffect(() => {
    loadAll()

    // Live updates — if a host starts/ends a meeting, everyone's list refreshes
    const channel = supabase
      .channel(`meetings-list-${club.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'meetings', filter: `club_id=eq.${club.id}` },
        () => loadAll()
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [club.id])

  // Reset pagination whenever the year filter changes
  useEffect(() => { setShowCount(DEFAULT_PAGE_SIZE) }, [selectedYear])

  // ── Data loading ───────────────────────────────────────────────────────────

  // Master load function — fetches meetings, members, completion stats, and
  // pre-registrations in the right order. Called on mount and realtime updates.
  async function loadAll() {
    // Fetch meetings and members in parallel
    const [{ data: meetingsData }, { data: membersData }] = await Promise.all([
      supabase
        .from('meetings')
        .select('*, memberships(users(display_name))')
        .eq('club_id', club.id)
        .is('deleted_at', null)
        .order('held_at', { ascending: false }),
      supabase
        .from('memberships')
        // Include users.id so we can identify the current user's own membership
        .select('id, users(id, display_name)')
        .eq('club_id', club.id)
        .eq('status', 'active'),
    ])

    setMeetings(meetingsData ?? [])
    setMembers(membersData ?? [])

    // Fetch offering counts + avg scores for completed meetings
    const completedIds = (meetingsData ?? [])
      .filter(m => m.status === 'completed')
      .map(m => m.id)
    if (completedIds.length) {
      const { data: contribs } = await supabase
        .from('contributions')
        .select('meeting_id, composite_score')
        .in('meeting_id', completedIds)
        .is('deleted_at', null)
      const stats = {}
      completedIds.forEach(id => {
        const mc     = (contribs ?? []).filter(c => c.meeting_id === id)
        const scores = mc.map(c => c.composite_score).filter(v => v != null).map(Number)
        stats[id] = {
          count:    mc.length,
          avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        }
      })
      setStatsMap(stats)
    }

    // Load pre-registrations for upcoming scheduled meetings.
    // Pass membersData directly to avoid stale state closure.
    const scheduledMeetings = (meetingsData ?? []).filter(m => m.status === 'scheduled')
    if (scheduledMeetings.length) {
      await loadPreRegs(scheduledMeetings, membersData ?? [])
    } else {
      setPreRegs({})
    }
  }

  // Fetches all contributions for the given scheduled meetings, joins with offering
  // details, and organises into a map by meeting ID. memberData is passed in
  // explicitly so we don't depend on stale state.
  async function loadPreRegs(scheduledMeetings, memberData) {
    const ids = scheduledMeetings.map(m => m.id)

    // Find the current user's membership so we can flag their own contribution
    const myMembership = memberData.find(m => m.users?.id === session.user.id)

    const { data } = await supabase
      .from('contributions')
      // Fetch offering details so we can display and pre-fill on edit
      .select('id, meeting_id, contributor_id, is_flagged_duplicate, presentation_order, offerings(name, producer, style, abv)')
      .in('meeting_id', ids)
      .is('deleted_at', null)
      .order('presentation_order')

    // Build a membership-id -> display-name lookup for contributor labels
    const nameById = {}
    memberData.forEach(m => { nameById[m.id] = m.users?.display_name ?? 'Unknown' })

    // Group contributions by meeting, enrich with display name, mark "mine"
    const map = {}
    ids.forEach(id => { map[id] = { all: [], mine: null } })
    ;(data ?? []).forEach(c => {
      if (!map[c.meeting_id]) return
      const enriched = { ...c, displayName: nameById[c.contributor_id] ?? 'Unknown' }
      map[c.meeting_id].all.push(enriched)
      if (myMembership && c.contributor_id === myMembership.id) {
        map[c.meeting_id].mine = enriched
      }
    })
    setPreRegs(map)
  }

  // ── Pre-registration helpers ───────────────────────────────────────────────

  // Returns the effective prereg_visibility for a meeting.
  // Per-meeting override (in metadata.settings) wins over the club-level default.
  function effectivePreregVisibility(meeting) {
    const meetingVal = meeting.metadata?.settings?.prereg_visibility
    if (meetingVal != null) return meetingVal
    return club.settings?.prereg_visibility ?? 'full'
  }

  // Opens the inline registration form, optionally pre-filling with an existing pick.
  function openRegisterForm(meetingId, existingPick = null) {
    setRegisteringFor(meetingId)
    setPickName(existingPick?.offerings?.name ?? '')
    setPickProducer(existingPick?.offerings?.producer ?? '')
    setPickStyle(existingPick?.offerings?.style ?? '')
    setPickAbv(existingPick?.offerings?.abv != null ? String(existingPick.offerings.abv) : '')
    setPickError(null)
  }

  // Called when the form is submitted. Runs a client-side duplicate check
  // BEFORE inserting — if a match is found, sets pendingDuplicate and waits
  // for the user to confirm via "Bring it anyway" or bail out via "Nevermind".
  async function handleRegisterSubmit(e, meetingId) {
    e.preventDefault()
    setPickLoading(true)
    setPickError(null)

    // Check if any offering in this club has the same name (case-insensitive)
    const { data: existing } = await supabase
      .from('offerings')
      .select('id, name, producer')
      .eq('club_id', club.id)
      .ilike('name', pickName.trim())
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    if (existing) {
      // Find the most recent time this offering was brought (for the summary card)
      const { data: lastContrib } = await supabase
        .from('contributions')
        .select('contributor_id, meetings(held_at)')
        .eq('offering_id', existing.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Contributor name comes from the already-loaded members list
      const displayName =
        members.find(m => m.id === lastContrib?.contributor_id)?.users?.display_name
        ?? 'a club member'

      setPendingDuplicate({
        meetingId,
        offering: existing,
        lastBrought: lastContrib
          ? { displayName, heldAt: lastContrib.meetings?.held_at }
          : null,
      })
      setPickLoading(false)
      return
    }

    // No duplicate found — go straight to registration
    await submitRegistration(meetingId)
  }

  // The actual insert path — called either directly (no duplicate) or after the
  // user confirms "Bring it anyway". Handles delete-then-reinsert for edits.
  async function submitRegistration(meetingId) {
    setPickLoading(true)
    setPickError(null)

    const existingPick = preRegs[meetingId]?.mine

    // Delete the old contribution first when editing an existing pick
    if (existingPick) {
      const { error: delErr } = await supabase.rpc('delete_contribution', {
        p_contribution_id: existingPick.id,
      })
      if (delErr) {
        setPickError(delErr.message)
        setPickLoading(false)
        return
      }
    }

    const { error: logErr } = await supabase.rpc('log_offering', {
      p_meeting_id: meetingId,
      p_name:       pickName.trim(),
      p_producer:   pickProducer.trim() || null,
      p_style:      pickStyle.trim() || null,
      p_abv:        pickAbv ? parseFloat(pickAbv) : null,
    })

    if (logErr) {
      setPickError(logErr.message)
      setPickLoading(false)
      return
    }

    setRegisteringFor(null)
    setPendingDuplicate(null)
    setPickLoading(false)
    await loadAll()
  }

  // User confirmed they want to bring the duplicate beer anyway.
  async function handleBringItAnyway(meetingId) {
    setPendingDuplicate(null)
    await submitRegistration(meetingId)
  }

  // User backed out of the duplicate confirmation — clear everything.
  function handleNevermind() {
    setPendingDuplicate(null)
    setRegisteringFor(null)
    setPickName('')
    setPickProducer('')
    setPickStyle('')
    setPickAbv('')
    setPickError(null)
  }

  // Soft-deletes a pre-registration and refreshes data.
  async function handleRemovePick(e, contributionId, meetingId) {
    e.stopPropagation()
    const { error } = await supabase.rpc('delete_contribution', {
      p_contribution_id: contributionId,
    })
    if (error) { alert(error.message); return }
    await loadAll()
  }

  // Renders the pre-registration section for a scheduled meeting.
  // The returned JSX must be wrapped in a stopPropagation container by the caller
  // (so clicks don't navigate into the meeting detail view).
  function renderPreRegSection(meeting) {
    const reg            = preRegs[meeting.id] ?? { all: [], mine: null }
    const visibility     = effectivePreregVisibility(meeting)
    const { all, mine }  = reg
    const count          = all.length
    const isExpanded     = expandedRegs.has(meeting.id)
    const isFormOpen     = registeringFor === meeting.id
    const isConfirming   = pendingDuplicate?.meetingId === meeting.id
    const isEditing      = !!mine

    return (
      <div className="pt-3 border-t border-gray-700 space-y-3">

        {/* Pre-registration count / expandable list (respects visibility setting) */}
        {visibility !== 'hidden' && count > 0 && (
          <div>
            {visibility === 'full' || visibility === 'attendees_only' ? (
              // full / attendees_only — expandable list (beer details hidden for attendees_only)
              <button
                onClick={e => {
                  e.stopPropagation()
                  setExpandedRegs(s => {
                    const ns = new Set(s)
                    ns.has(meeting.id) ? ns.delete(meeting.id) : ns.add(meeting.id)
                    return ns
                  })
                }}
                className="text-xs text-indigo-300 hover:text-indigo-100 transition-colors"
              >
                {count} {count === 1 ? 'person' : 'people'} registered {isExpanded ? '▴' : '▾'}
              </button>
            ) : (
              // count_only — number only, not clickable
              <p className="text-xs text-indigo-300">{count} registered</p>
            )}

            {/* Expanded list: names always shown; beer details only for 'full' */}
            {(visibility === 'full' || visibility === 'attendees_only') && isExpanded && (
              <ul className="mt-1.5 space-y-1 pl-2">
                {all.map(c => (
                  <li key={c.id} className="text-xs text-gray-400 flex items-center gap-1.5">
                    <span className="text-gray-300">{c.displayName}</span>
                    {visibility === 'full' && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span>{c.offerings?.name}</span>
                        {c.offerings?.producer && (
                          <span className="text-gray-600">· {c.offerings.producer}</span>
                        )}
                        {/* ⚠ indicates a beer that's been brought to this club before */}
                        {c.is_flagged_duplicate && (
                          <span title="Brought to this club before" className="text-yellow-500">⚠</span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Duplicate confirmation ─────────────────────────────────────────── */}
        {/* Shown instead of the form when a name-match is detected pre-insert.  */}
        {/* The user must explicitly choose to proceed or back out.              */}
        {isConfirming && (
          <div className="space-y-3">
            <div className="bg-yellow-950 border border-yellow-700/60 rounded-lg p-3 space-y-2.5">
              <p className="text-sm font-medium text-yellow-300">
                Heads up — it looks like this beer has been brought to this club before.
              </p>
              {/* Summary of the matched offering */}
              <div className="bg-black/30 rounded-lg px-3 py-2.5 space-y-0.5">
                <p className="text-sm font-semibold text-white">
                  {pendingDuplicate.offering.name}
                </p>
                {pendingDuplicate.offering.producer && (
                  <p className="text-xs text-gray-400">{pendingDuplicate.offering.producer}</p>
                )}
                {pendingDuplicate.lastBrought && (
                  <p className="text-xs text-gray-500 mt-1">
                    Brought by {pendingDuplicate.lastBrought.displayName}
                    {pendingDuplicate.lastBrought.heldAt && (
                      <> · {SHORT_DATE_FMT.format(new Date(pendingDuplicate.lastBrought.heldAt))}</>
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={e => { e.stopPropagation(); handleBringItAnyway(meeting.id) }}
                disabled={pickLoading}
                className="flex-1 py-2 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-colors"
              >
                {pickLoading ? 'Registering…' : 'Bring it anyway'}
              </button>
              <button
                onClick={e => { e.stopPropagation(); handleNevermind() }}
                className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Nevermind
              </button>
            </div>
          </div>
        )}

        {/* ── User's existing pick, or the Register call-to-action ──────────── */}
        {/* Hidden while the form or duplicate confirmation is showing.         */}
        {!isFormOpen && !isConfirming && (
          mine ? (
            // User already has a pick — show it with Edit / Remove actions
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs font-medium text-green-400">Your pick: </span>
                <span className="text-xs text-white">{mine.offerings?.name}</span>
                {mine.offerings?.producer && (
                  <span className="text-xs text-gray-500"> · {mine.offerings.producer}</span>
                )}
              </div>
              <div className="flex gap-3 shrink-0">
                <button
                  onClick={e => { e.stopPropagation(); openRegisterForm(meeting.id, mine) }}
                  className="text-xs text-indigo-400 hover:text-indigo-200 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={e => handleRemovePick(e, mine.id, meeting.id)}
                  className="text-xs text-red-400 hover:text-red-200 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            // No pick yet — prominent call-to-action
            <button
              onClick={e => { e.stopPropagation(); openRegisterForm(meeting.id) }}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 rounded-lg text-sm font-semibold text-white transition-colors"
            >
              Register My Pick
            </button>
          )
        )}

        {/* ── Inline registration / edit form ───────────────────────────────── */}
        {/* Hidden while the duplicate confirmation is showing.                 */}
        {isFormOpen && !isConfirming && (
          <form
            onSubmit={e => handleRegisterSubmit(e, meeting.id)}
            onClick={e => e.stopPropagation()}
            className="space-y-3 pt-1"
          >
            <div>
              <label className="block text-xs text-gray-400 mb-1">Beer name *</label>
              <input
                type="text"
                value={pickName}
                onChange={e => setPickName(e.target.value)}
                required
                autoFocus
                placeholder="e.g. Founders All Day IPA"
                className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Brewery</label>
                <input
                  type="text"
                  value={pickProducer}
                  onChange={e => setPickProducer(e.target.value)}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Style</label>
                <input
                  type="text"
                  value={pickStyle}
                  onChange={e => setPickStyle(e.target.value)}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">ABV %</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={pickAbv}
                onChange={e => setPickAbv(e.target.value)}
                placeholder="optional"
                className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
              />
            </div>
            {pickError && <p className="text-xs text-red-400">{pickError}</p>}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={pickLoading}
                className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {pickLoading ? 'Checking…' : isEditing ? 'Update Pick' : 'Register Pick'}
              </button>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setRegisteringFor(null) }}
                className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    )
  }

  // ── Meeting CRUD helpers ───────────────────────────────────────────────────

  function handleShowForm() {
    const maxNum = Math.max(
      0,
      ...meetings
        .filter(m => m.counts_for_record && m.meeting_number)
        .map(m => m.meeting_number)
    )
    setMeetingNumber(String(maxNum + 1))
    setShowForm(true)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.rpc('create_meeting', {
      p_club_id:            club.id,
      p_held_at:            new Date(heldAt).toISOString(),
      p_title:              title || null,
      p_host_membership_id: hostId || null,
      p_meeting_number:     countsForRecord && meetingNumber ? parseInt(meetingNumber) : null,
      p_counts_for_record:  countsForRecord,
    })
    if (error) { setError(error.message); setLoading(false); return }
    setShowForm(false)
    setTitle('')
    setHostId('')
    await loadAll()
    setLoading(false)
  }

  async function handleStatusChange(e, meetingId, newStatus) {
    e.stopPropagation()  // don't navigate into the meeting when clicking Start/End
    const { error } = await supabase.rpc('update_meeting_status', {
      p_meeting_id: meetingId,
      p_status:     newStatus,
    })
    if (error) alert(error.message)
    else loadAll()
  }

  // ── Categorise meetings ────────────────────────────────────────────────────

  // There can only be one active meeting at a time
  const activeMeeting = meetings.find(m => m.status === 'active')

  // Upcoming sorted ascending so nearest is first
  const upcoming = meetings
    .filter(m => m.status === 'scheduled')
    .sort((a, b) => new Date(a.held_at) - new Date(b.held_at))
  const nextMeeting   = upcoming[0] ?? null
  const laterMeetings = upcoming.slice(1)

  // Completed sorted newest-first (from the DB query)
  const completed = meetings.filter(m => m.status === 'completed')

  const completedYears = [
    ...new Set(completed.map(m => new Date(m.held_at).getFullYear()))
  ].sort((a, b) => b - a)

  const filteredCompleted = selectedYear === 'all'
    ? completed
    : completed.filter(m => new Date(m.held_at).getFullYear() === parseInt(selectedYear))

  const visibleCompleted = filteredCompleted.slice(0, showCount)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* New meeting button + form (owners/admins only) */}
      {isOwnerOrAdmin && !showForm && (
        <div className="flex justify-end">
          <button
            onClick={handleShowForm}
            className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500"
          >
            + New Meeting
          </button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-gray-900 rounded-xl p-6 space-y-4">
          <h3 className="font-semibold text-white">New Meeting</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Date &amp; time</label>
              <input
                type="datetime-local"
                value={heldAt}
                onChange={e => setHeldAt(e.target.value)}
                required
                className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Title (optional)</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Holiday Special"
                className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Host</label>
              <select
                value={hostId}
                onChange={e => setHostId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
              >
                <option value="">— select host —</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.users?.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Meeting #</label>
              <input
                type="number"
                value={meetingNumber}
                onChange={e => setMeetingNumber(e.target.value)}
                disabled={!countsForRecord}
                className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-40"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={countsForRecord}
              onChange={e => setCountsForRecord(e.target.checked)}
              className="rounded"
            />
            Counts toward the record
          </label>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Creating…' : 'Create Meeting'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Active meeting — hero card ─────────────────────────────────────── */}
      {/* If a meeting is live right now, this is the most important thing on  */}
      {/* the screen. Bright green, full-width, impossible to miss.            */}
      {activeMeeting && (
        <div
          onClick={() => navigate(`/meeting/${activeMeeting.id}`)}
          className="bg-green-950 border-2 border-green-600 rounded-xl p-5 cursor-pointer hover:bg-green-900 transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-green-400 uppercase tracking-widest mb-1.5">
                ● Live Now
              </p>
              <h3 className="text-lg font-bold text-white leading-snug">
                {meetingLabel(activeMeeting)}
              </h3>
              <p className="text-sm text-green-300 mt-0.5">
                {DATE_FMT.format(new Date(activeMeeting.held_at))}
              </p>
              {activeMeeting.memberships?.users?.display_name && (
                <p className="text-xs text-green-400/70 mt-1">
                  Host: {activeMeeting.memberships.users.display_name}
                </p>
              )}
            </div>
            {isOwnerOrAdmin && (
              <button
                onClick={e => handleStatusChange(e, activeMeeting.id, 'completed')}
                className="shrink-0 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-medium"
              >
                End
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Next upcoming meeting ─────────────────────────────────────────── */}
      {/* Gets the indigo hero treatment plus the pre-registration section.   */}
      {nextMeeting && (
        <div
          onClick={() => navigate(`/meeting/${nextMeeting.id}`)}
          className="bg-indigo-950 border border-indigo-700 rounded-xl p-5 cursor-pointer hover:bg-indigo-900 transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-indigo-400 uppercase tracking-wide mb-1">
                Next Meeting
              </p>
              <h3 className="font-bold text-white">{meetingLabel(nextMeeting)}</h3>
              <p className="text-sm text-indigo-300 mt-0.5">
                {DATE_FMT.format(new Date(nextMeeting.held_at))}
              </p>
              {nextMeeting.memberships?.users?.display_name && (
                <p className="text-xs text-indigo-400/70 mt-1">
                  Host: {nextMeeting.memberships.users.display_name}
                </p>
              )}
            </div>
            {isOwnerOrAdmin && (
              <button
                onClick={e => handleStatusChange(e, nextMeeting.id, 'active')}
                className="shrink-0 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-medium"
              >
                Start
              </button>
            )}
          </div>

          {/* Pre-reg section — stop propagation so clicks here don't navigate */}
          <div onClick={e => e.stopPropagation()}>
            {renderPreRegSection(nextMeeting)}
          </div>
        </div>
      )}

      {/* ── Other upcoming meetings ───────────────────────────────────────── */}
      {laterMeetings.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide px-1">
            Upcoming
          </p>
          {laterMeetings.map(m => (
            <MeetingCard
              key={m.id}
              m={m}
              statsMap={statsMap}
              isOwnerOrAdmin={isOwnerOrAdmin}
              onStatusChange={handleStatusChange}
              onClick={() => navigate(`/meeting/${m.id}`)}
              preRegSection={renderPreRegSection(m)}
            />
          ))}
        </div>
      )}

      {/* ── Past meetings ─────────────────────────────────────────────────── */}
      {completed.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Past Meetings
            </p>
            <select
              value={selectedYear}
              onChange={e => setSelectedYear(e.target.value)}
              className="px-2 py-1 bg-gray-800 text-gray-300 rounded text-xs border border-gray-700 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">All Years</option>
              {completedYears.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          {visibleCompleted.map(m => (
            <MeetingCard
              key={m.id}
              m={m}
              statsMap={statsMap}
              isOwnerOrAdmin={isOwnerOrAdmin}
              onStatusChange={handleStatusChange}
              onClick={() => navigate(`/meeting/${m.id}`)}
            />
          ))}

          {filteredCompleted.length > showCount && (
            <button
              onClick={() => setShowCount(c => c + DEFAULT_PAGE_SIZE)}
              className="w-full py-2.5 text-xs text-gray-500 hover:text-gray-300 transition-colors bg-gray-900 rounded-xl"
            >
              Show more ({filteredCompleted.length - showCount} remaining)
            </button>
          )}
        </div>
      )}

      {meetings.length === 0 && !showForm && (
        <div className="bg-gray-900 rounded-xl p-8 text-center text-gray-500">
          No meetings yet.
        </div>
      )}

    </div>
  )
}
