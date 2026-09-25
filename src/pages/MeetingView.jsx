import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ScoreStepper from '../components/ScoreStepper'
import MeetingSettings from '../components/MeetingSettings'

const STATUS_STYLES = {
  scheduled: 'bg-blue-900 text-blue-300',
  active:    'bg-green-900 text-green-300',
  completed: 'bg-gray-800 text-gray-400',
}

function meetingLabel(m) {
  if (m.title) return m.title
  if (m.meeting_number) return `Meeting #${m.meeting_number}`
  return new Date(m.held_at).toLocaleDateString()
}

export default function MeetingView({ session, displayName, onBack }) {
  const { meetingId } = useParams()
  const navigate = useNavigate()

  const [meeting, setMeeting]           = useState(null)
  const [clubSettings, setClubSettings] = useState({})   // clubs.settings jsonb
  const [myMembership, setMyMembership] = useState(null)
  const [members, setMembers]           = useState([])
  const [contributions, setContributions] = useState([])
  const [votes, setVotes]               = useState([])
  const [loading, setLoading]           = useState(true)

  // Offer log form
  const [showForm, setShowForm]           = useState(false)
  const [offerName, setOfferName]         = useState('')
  const [offerProducer, setOfferProducer] = useState('')
  const [offerStyle, setOfferStyle]       = useState('')
  const [offerAbv, setOfferAbv]           = useState('')
  const [offerContributorId, setOfferContributorId] = useState(null)  // null = self
  const [formLoading, setFormLoading]     = useState(false)
  const [formError, setFormError]         = useState(null)

  // Pending score edits before submit: { [contributionId]: score }
  const [pendingScores, setPendingScores] = useState({})
  const [submittingId, setSubmittingId]   = useState(null)

  // Host controls
  const [editingId, setEditingId]           = useState(null)   // contribution currently being edited
  const [editFields, setEditFields]         = useState({})
  const [editSaving, setEditSaving]         = useState(false)
  const [proxyOpenIds, setProxyOpenIds]     = useState(new Set()) // expanded proxy panels
  const [proxyScores, setProxyScores]       = useState({})     // { "contribId_memberId": score }
  const [submittingProxy, setSubmittingProxy] = useState(null) // "contribId_memberId" key
  const [movingId, setMovingId]             = useState(null)   // contribution being reordered
  const [deletingId, setDeletingId]         = useState(null)   // contribution being deleted
  const [showSettings, setShowSettings]     = useState(false)  // meeting settings panel

  // When the club's settings row changes (e.g. admin toggles blind_voting mid-meeting),
  // update local state immediately so the UI enforces the new setting without a refresh.
  useEffect(() => {
    if (!meeting?.club_id) return
    const channel = supabase
      .channel(`club-${meeting.club_id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clubs', filter: `id=eq.${meeting.club_id}` },
        (payload) => setClubSettings(payload.new.settings ?? {})
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [meeting?.club_id])

  useEffect(() => {
    loadAll()

    const channel = supabase
      .channel(`meeting-${meetingId}`)
      // When the host starts or ends the meeting, update our local meeting state
      // immediately — this causes isActive to flip, which removes the voting
      // controls and shows the winner banner for everyone in the room at once.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'meetings', filter: `id=eq.${meetingId}` },
        (payload) => setMeeting(payload.new)
      )
      // When a new offering is logged, reload the contributions list
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contributions' }, loadContributions)
      // When any vote is submitted, reload votes so scores update live
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, () => loadVotesForCurrentContribs())
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [meetingId])

  async function loadAll() {
    setLoading(true)

    const { data: m } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meetingId)
      .single()

    if (!m) { navigate('/'); return }
    setMeeting(m)

    const [{ data: membership }, { data: memberList }, { data: clubRow }] = await Promise.all([
      supabase
        .from('memberships')
        .select('id, role')
        .eq('club_id', m.club_id)
        .eq('user_id', session.user.id)
        .single(),
      supabase
        .from('memberships')
        .select('id, users(id, display_name)')
        .eq('club_id', m.club_id)
        .eq('status', 'active'),
      supabase
        .from('clubs')
        .select('settings')
        .eq('id', m.club_id)
        .single(),
    ])
    setMyMembership(membership)
    setMembers(memberList ?? [])
    setClubSettings(clubRow?.settings ?? {})

    const contribs = await loadContributions()
    await loadVotes(contribs)
    setLoading(false)
  }

  async function loadContributions() {
    const { data } = await supabase
      .from('contributions')
      .select('id, composite_score, is_flagged_duplicate, contributor_id, presentation_order, created_at, offerings(name, producer, style, abv)')
      .eq('meeting_id', meetingId)
      .is('deleted_at', null)
      .order('presentation_order', { ascending: true, nullsFirst: false })
      .order('created_at')
    setContributions(data ?? [])
    return data ?? []
  }

  async function loadVotesForCurrentContribs() {
    setContributions((current) => {
      loadVotes(current)
      return current
    })
  }

  async function loadVotes(contribs) {
    if (!contribs?.length) { setVotes([]); return }
    const { data } = await supabase
      .from('votes')
      .select('contribution_id, voter_id, score, is_self_vote')
      .in('contribution_id', contribs.map((c) => c.id))
    setVotes(data ?? [])
  }

  async function handleLogOffering(e) {
    e.preventDefault()
    setFormLoading(true)
    setFormError(null)
    const { error } = await supabase.rpc('log_offering', {
      p_meeting_id:                meetingId,
      p_name:                      offerName.trim(),
      p_producer:                  offerProducer.trim() || null,
      p_style:                     offerStyle.trim() || null,
      p_abv:                       offerAbv ? parseFloat(offerAbv) : null,
      p_contributor_membership_id: offerContributorId || null,
    })
    if (error) { setFormError(error.message); setFormLoading(false); return }
    setOfferName(''); setOfferProducer(''); setOfferStyle(''); setOfferAbv('')
    setOfferContributorId(null)
    setShowForm(false)
    setFormLoading(false)
  }

  async function handleSubmitVote(contributionId, score) {
    setSubmittingId(contributionId)
    const { error } = await supabase.rpc('submit_vote', {
      p_contribution_id: contributionId,
      p_score:           score,
    })
    if (error) alert(error.message)
    else {
      // Clear pending once submitted so the display reflects the saved value
      setPendingScores((prev) => { const n = {...prev}; delete n[contributionId]; return n })
      await loadVotes(contributions)
    }
    setSubmittingId(null)
  }

  // ── Host control handlers ─────────────────────────────────────────────────

  function openEdit(c) {
    setEditingId(c.id)
    setEditFields({
      name:          c.offerings?.name ?? '',
      producer:      c.offerings?.producer ?? '',
      style:         c.offerings?.style ?? '',
      abv:           c.offerings?.abv != null ? String(c.offerings.abv) : '',
      contributorId: c.contributor_id,
    })
  }

  async function saveEdit() {
    setEditSaving(true)
    const original = contributions.find(c => c.id === editingId)

    // Update offering details (name/producer/style/abv)
    const { error: offerErr } = await supabase.rpc('edit_offering', {
      p_contribution_id: editingId,
      p_name:            editFields.name.trim(),
      p_producer:        editFields.producer.trim() || null,
      p_style:           editFields.style.trim() || null,
      p_abv:             editFields.abv ? parseFloat(editFields.abv) : null,
    })
    if (offerErr) { alert(offerErr.message); setEditSaving(false); return }

    // If the contributor changed, run the separate RPC which also recalculates
    // is_self_vote and composite_score for all existing votes on this contribution
    if (editFields.contributorId !== original?.contributor_id) {
      const { error: contribErr } = await supabase.rpc('change_contributor', {
        p_contribution_id:           editingId,
        p_contributor_membership_id: editFields.contributorId,
      })
      if (contribErr) { alert(contribErr.message); setEditSaving(false); return }
    }

    setEditingId(null)
    setEditSaving(false)
  }

  function toggleProxy(id) {
    setProxyOpenIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function getProxyScore(contribId, memberId) {
    const key = `${contribId}_${memberId}`
    if (proxyScores[key] !== undefined) return proxyScores[key]
    const existing = votes.find(v => v.contribution_id === contribId && v.voter_id === memberId)
    return existing ? Number(existing.score) : 3.0
  }

  async function handleProxyVote(contribId, membershipId) {
    const key = `${contribId}_${membershipId}`
    setSubmittingProxy(key)
    const { error } = await supabase.rpc('proxy_vote', {
      p_contribution_id:     contribId,
      p_voter_membership_id: membershipId,
      p_score:               getProxyScore(contribId, membershipId),
    })
    if (error) { alert(error.message) }
    else {
      setProxyScores(prev => { const n = {...prev}; delete n[key]; return n })
      await loadVotes(contributions)
    }
    setSubmittingProxy(null)
  }

  async function handleMove(id, direction) {
    setMovingId(id)
    const { error } = await supabase.rpc('move_contribution', {
      p_contribution_id: id,
      p_direction:       direction,
    })
    if (error) { alert(error.message) }
    else { await loadContributions() }
    setMovingId(null)
  }

  async function handleDelete(id) {
    if (!confirm('Remove this offering? This cannot be undone.')) return
    setDeletingId(id)
    const { error } = await supabase.rpc('delete_contribution', { p_contribution_id: id })
    if (error) { alert(error.message) }
    else { await loadContributions() }
    setDeletingId(null)
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">Loading…</div>
  )

  const memberMap = Object.fromEntries(members.map((m) => [m.id, m.users?.display_name ?? 'Unknown']))
  const myVoteMap = Object.fromEntries(
    votes
      .filter((v) => v.voter_id === myMembership?.id)
      .map((v) => [v.contribution_id, Number(v.score)])
  )
  const voteCountMap = votes.reduce((acc, v) => {
    acc[v.contribution_id] = (acc[v.contribution_id] ?? 0) + 1
    return acc
  }, {})

  const isActive       = meeting.status === 'active'
  const isOwnerOrAdmin = myMembership?.role === 'owner' || myMembership?.role === 'admin'
  // Host = the member designated as this meeting's host (may be any role)
  const isHost         = !!myMembership && myMembership.id === meeting.host_membership_id
  // Can manage = anyone who should see the ⚙ settings button and Start/End controls
  const canManageMeeting = isOwnerOrAdmin || isHost

  // Per-meeting settings (meetings.metadata.settings) override club defaults.
  // A null/missing key means "use club default".
  const meetingSettings = meeting.metadata?.settings ?? {}
  function effectiveSetting(key) {
    const meetingVal = meetingSettings[key]
    return (meetingVal !== null && meetingVal !== undefined) ? meetingVal : clubSettings[key]
  }

  // Blind voting: hide running scores while the meeting is live
  const isBlindVoting  = !!effectiveSetting('blind_voting') && isActive
  // Hide per-person breakdown on completed meetings when opted out
  const hideBreakdown  = !!effectiveSetting('hide_scores_after_meeting') && meeting.status === 'completed'

  // Pre-registration visibility: gates what non-managers see on scheduled meetings.
  // Managers (owner/admin/host) always see everything regardless of this setting.
  const preregVisibility  = effectiveSetting('prereg_visibility') ?? 'full'
  const applyPreregFilter = meeting.status === 'scheduled' && !canManageMeeting

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto p-8">

        <div className="flex justify-between items-center mb-6">
          <button
            onClick={() => { onBack?.(meeting?.club_id); navigate('/') }}
            className="text-sm text-gray-400 hover:text-white"
          >
            ← Back to club
          </button>
          {displayName && (
            <span className="text-sm text-gray-400">
              Signed in as <span className="text-white font-medium">{displayName}</span>
            </span>
          )}
        </div>

        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold">{meetingLabel(meeting)}</h1>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[meeting.status]}`}>
              {meeting.status.charAt(0).toUpperCase() + meeting.status.slice(1)}
            </span>
          </div>
          {/* Start / End + gear — visible to owner, admin, and the meeting's host */}
          {canManageMeeting && (
            <div className="flex items-center gap-2 shrink-0 pt-1">
              {meeting.status === 'scheduled' && (
                <button
                  onClick={async () => {
                    const { error } = await supabase.rpc('update_meeting_status', { p_meeting_id: meetingId, p_status: 'active' })
                    if (error) alert(error.message)
                  }}
                  className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-medium"
                >
                  Start Meeting
                </button>
              )}
              {meeting.status === 'active' && (
                <button
                  onClick={async () => {
                    if (!confirm('End this meeting? Voting will close for all members.')) return
                    const { error } = await supabase.rpc('update_meeting_status', { p_meeting_id: meetingId, p_status: 'completed' })
                    if (error) alert(error.message)
                  }}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-medium"
                >
                  End Meeting
                </button>
              )}
              {meeting.status === 'completed' && (
                <button
                  onClick={async () => {
                    if (!confirm('Reopen this meeting? Voting will resume for all members.')) return
                    const { error } = await supabase.rpc('update_meeting_status', { p_meeting_id: meetingId, p_status: 'active' })
                    if (error) alert(error.message)
                  }}
                  className="px-3 py-1.5 bg-yellow-800 hover:bg-yellow-700 rounded-lg text-xs font-medium text-yellow-200"
                >
                  Reopen Meeting
                </button>
              )}
              <button
                onClick={() => setShowSettings(s => !s)}
                title="Meeting settings"
                className={`px-2.5 py-1.5 rounded-lg text-sm transition-colors ${
                  showSettings ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                ⚙
              </button>
            </div>
          )}
        </div>
        <p className="text-gray-400 mb-6">
          {new Date(meeting.held_at).toLocaleDateString(undefined, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          })}
        </p>

        {/* Meeting settings panel — toggled by the ⚙ button */}
        {showSettings && canManageMeeting && (
          <MeetingSettings
            meeting={meeting}
            clubSettings={clubSettings}
            members={members}
            myMembership={myMembership}
            isOwnerOrAdmin={isOwnerOrAdmin}
            onSaved={(updated) => { setMeeting(updated); setShowSettings(false) }}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Log offering — visible to everyone during active, host-only during scheduled */}
        {(isActive || (meeting.status === 'scheduled' && canManageMeeting)) && (
          <div className="mb-6">
            {!showForm ? (
              <button
                onClick={() => setShowForm(true)}
                className="w-full py-3 border-2 border-dashed border-gray-700 rounded-xl text-gray-400 hover:border-indigo-500 hover:text-indigo-400 transition-colors text-sm font-medium"
              >
                + Log an Offering
              </button>
            ) : (
              <form onSubmit={handleLogOffering} className="bg-gray-900 rounded-xl p-6 space-y-4">
                <h3 className="font-semibold">Log an Offering</h3>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Name *</label>
                  <input
                    type="text"
                    value={offerName}
                    onChange={(e) => setOfferName(e.target.value)}
                    placeholder="e.g. Sierra Nevada Torpedo"
                    required
                    autoFocus
                    className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Producer</label>
                    <input
                      type="text"
                      value={offerProducer}
                      onChange={(e) => setOfferProducer(e.target.value)}
                      placeholder="e.g. Sierra Nevada"
                      className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Style</label>
                    <input
                      type="text"
                      value={offerStyle}
                      onChange={(e) => setOfferStyle(e.target.value)}
                      placeholder="e.g. IPA"
                      className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">ABV %</label>
                    <input
                      type="number"
                      value={offerAbv}
                      onChange={(e) => setOfferAbv(e.target.value)}
                      placeholder="e.g. 7.2"
                      step="0.1" min="0" max="100"
                      className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                    />
                  </div>
                </div>
                {/* Brought by — shown to owner/admin/host so they can log on behalf of someone */}
                {(isOwnerOrAdmin || isHost) && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Brought by</label>
                    <select
                      value={offerContributorId ?? myMembership?.id ?? ''}
                      onChange={e => setOfferContributorId(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                    >
                      {members.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.users?.display_name}{m.id === myMembership?.id ? ' (you)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {formError && <p className="text-red-400 text-sm">{formError}</p>}
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {formLoading ? 'Logging…' : 'Log Offering'}
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
          </div>
        )}

        {/* Winner banner — only shown when the meeting is completed and at least
            one offering received votes. Finds the highest-scoring offering. */}
        {meeting.status === 'completed' && (() => {
          const withScores = contributions.filter((c) => c.composite_score != null)
          if (!withScores.length) return null
          const winner = withScores.reduce((a, b) =>
            Number(a.composite_score) > Number(b.composite_score) ? a : b
          )
          return (
            <div className="bg-yellow-950 border border-yellow-700/50 rounded-xl p-4 mb-6">
              <p className="text-xs text-yellow-500 font-medium uppercase tracking-wide mb-1">
                Top Offering
              </p>
              <div className="flex justify-between items-baseline">
                <p className="font-bold text-white text-lg">{winner.offerings?.name}</p>
                <p className="text-yellow-400 font-mono font-bold text-xl">
                  {Number(winner.composite_score).toFixed(2)}
                </p>
              </div>
            </div>
          )
        })()}

        {/* Blind voting notice */}
        {isBlindVoting && (
          <div className="mb-4 px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg flex items-center gap-2 text-sm text-gray-400">
            {/* Eye-slash indicator */}
            <span>🔒</span>
            <span>Blind voting is on — scores are hidden until the meeting ends.</span>
          </div>
        )}

        {/* Contributions ─────────────────────────────────────────────────────────
            For scheduled meetings, prereg_visibility controls what non-managers
            see. Managers (owner/admin/host) always get the full view.           */}

        {/* hidden: show nothing at all about pre-registrations */}
        {applyPreregFilter && preregVisibility === 'hidden' ? (
          contributions.length > 0 ? (
            <div className="bg-gray-900 rounded-xl p-6 text-center text-sm text-gray-600">
              Pre-registration details are not shown until the meeting starts.
            </div>
          ) : null

        /* count_only: one summary line, no individual cards */
        ) : applyPreregFilter && preregVisibility === 'count_only' ? (
          <div className="bg-gray-900 rounded-xl px-5 py-4 text-sm text-gray-400">
            {contributions.length === 0
              ? 'No offerings registered yet.'
              : `${contributions.length} offering${contributions.length !== 1 ? 's' : ''} registered for this meeting.`}
          </div>

        /* full / attendees_only / unfiltered: render cards (details masked for attendees_only) */
        ) : contributions.length === 0 ? (
          <div className="bg-gray-900 rounded-xl p-8 text-center text-gray-500">
            {isActive ? 'No offerings logged yet — be the first!' : 'No offerings were logged for this meeting.'}
          </div>
        ) : (
          <div className="space-y-4">
            {contributions.map((c) => {
              const myVote     = myVoteMap[c.id]
              const pending    = pendingScores[c.id]
              const score      = pending !== undefined ? pending : (myVote ?? 0)
              const totalVotes = voteCountMap[c.id] ?? 0
              const hasVoted   = myVote !== undefined
              const isDirty    = pending !== undefined
              // attendees_only: show contributor name but hide the offering details
              const maskBeer   = applyPreregFilter && preregVisibility === 'attendees_only'

              return (
                <div key={c.id} className="bg-gray-900 rounded-xl p-5">

                  {/* ── Inline edit form (owner/admin only) ── */}
                  {editingId === c.id ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-gray-400">Edit offering</p>
                        <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 hover:text-white">Cancel</button>
                      </div>
                      <input
                        type="text"
                        value={editFields.name}
                        onChange={e => setEditFields(p => ({...p, name: e.target.value}))}
                        placeholder="Name"
                        autoFocus
                        className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          value={editFields.producer}
                          onChange={e => setEditFields(p => ({...p, producer: e.target.value}))}
                          placeholder="Producer"
                          className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                        />
                        <input
                          type="text"
                          value={editFields.style}
                          onChange={e => setEditFields(p => ({...p, style: e.target.value}))}
                          placeholder="Style"
                          className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                        />
                        <input
                          type="number"
                          value={editFields.abv}
                          onChange={e => setEditFields(p => ({...p, abv: e.target.value}))}
                          placeholder="ABV %"
                          step="0.1" min="0" max="100"
                          className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Brought by</label>
                        <select
                          value={editFields.contributorId ?? ''}
                          onChange={e => setEditFields(p => ({...p, contributorId: e.target.value}))}
                          className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                        >
                          {members.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.users?.display_name}{m.id === myMembership?.id ? ' (you)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        onClick={saveEdit}
                        disabled={editSaving || !editFields.name?.trim()}
                        className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {editSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* ── Normal card content ── */}
                      <div className="flex justify-between items-start mb-3">
                        <div className="flex-1 min-w-0 mr-4">
                          {/* maskBeer (attendees_only): show contributor but hide offering details */}
                          {maskBeer ? (
                            <p className="text-sm font-medium text-gray-300">Registered</p>
                          ) : (
                            <>
                              <h3 className="font-semibold text-lg leading-tight">{c.offerings?.name}</h3>
                              <p className="text-sm text-gray-400">
                                {[c.offerings?.producer, c.offerings?.style, c.offerings?.abv ? `${c.offerings.abv}%` : null]
                                  .filter(Boolean).join(' · ')}
                              </p>
                            </>
                          )}
                          <p className="text-xs text-gray-500 mt-0.5">
                            Brought by {memberMap[c.contributor_id]}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          {/* During blind voting, show vote count but not the score */}
                          {isBlindVoting ? (
                            <p className="text-xs text-gray-500">
                              {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
                            </p>
                          ) : c.composite_score != null ? (
                            <>
                              <p className="text-2xl font-bold tabular-nums">
                                {Number(c.composite_score).toFixed(2)}
                              </p>
                              <p className="text-xs text-gray-500">
                                {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
                              </p>
                            </>
                          ) : (
                            <p className="text-sm text-gray-500">No votes yet</p>
                          )}
                        </div>
                      </div>

                      {/* Own vote stepper — shown to all members during active meetings */}
                      {myMembership && isActive && (
                        <div className="border-t border-gray-800 pt-3 flex items-center justify-between">
                          <ScoreStepper
                            value={score}
                            onChange={(val) => setPendingScores((prev) => ({ ...prev, [c.id]: val }))}
                            disabled={false}
                          />
                          <div className="flex items-center gap-2">
                            {hasVoted && !isDirty && (
                              <span className="text-xs text-green-400">Submitted</span>
                            )}
                            <button
                              onClick={() => handleSubmitVote(c.id, score)}
                              disabled={submittingId === c.id || (!isDirty && hasVoted)}
                              className="px-3 py-1.5 bg-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-500 disabled:opacity-40"
                            >
                              {submittingId === c.id ? '…' : hasVoted ? 'Update' : 'Submit'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Vote breakdown for completed meetings */}
                      {meeting.status === 'completed' && !hideBreakdown && (
                        <div className="border-t border-gray-800 pt-3 space-y-1.5">
                          {votes
                            .filter((v) => v.contribution_id === c.id)
                            .sort((a, b) => Number(b.score) - Number(a.score))
                            .map((v, i) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className={v.is_self_vote ? 'text-gray-600' : 'text-gray-400'}>
                                  {memberMap[v.voter_id]}
                                  {v.is_self_vote && (
                                    <span className="ml-1 text-xs">(self · not counted)</span>
                                  )}
                                </span>
                                <span className={`font-mono ${v.is_self_vote ? 'text-gray-600' : 'text-white'}`}>
                                  {Number(v.score).toFixed(1)}
                                </span>
                              </div>
                            ))
                          }
                          {votes.filter((v) => v.contribution_id === c.id).length === 0 && (
                            <p className="text-xs text-gray-600">No votes recorded</p>
                          )}
                        </div>
                      )}

                      {/* ── Host/admin action bar (owner/admin/host, active or scheduled) ── */}
                      {(isOwnerOrAdmin || isHost) && (isActive || meeting.status === 'scheduled') && (
                        <div className="border-t border-gray-800 mt-3 pt-2 flex items-center gap-2">
                          {/* Reorder arrows */}
                          <button
                            onClick={() => handleMove(c.id, 'up')}
                            disabled={movingId === c.id}
                            title="Move up"
                            className="w-6 h-6 flex items-center justify-center text-gray-600 hover:text-white hover:bg-gray-800 rounded disabled:opacity-30 text-xs"
                          >↑</button>
                          <button
                            onClick={() => handleMove(c.id, 'down')}
                            disabled={movingId === c.id}
                            title="Move down"
                            className="w-6 h-6 flex items-center justify-center text-gray-600 hover:text-white hover:bg-gray-800 rounded disabled:opacity-30 text-xs"
                          >↓</button>
                          <button
                            onClick={() => openEdit(c)}
                            className="text-xs text-gray-500 hover:text-white px-1"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(c.id)}
                            disabled={deletingId === c.id}
                            title="Remove offering"
                            className="text-xs text-red-600 hover:text-red-400 px-1 disabled:opacity-40"
                          >
                            {deletingId === c.id ? '…' : 'Delete'}
                          </button>
                          {/* Votes button (proxy entry) — only during active meetings */}
                          {isActive && (
                            <button
                              onClick={() => toggleProxy(c.id)}
                              className={`text-xs px-1 ml-auto ${proxyOpenIds.has(c.id) ? 'text-indigo-400' : 'text-gray-500 hover:text-white'}`}
                            >
                              Votes ({totalVotes}/{members.length})
                            </button>
                          )}
                        </div>
                      )}

                      {/* ── Proxy vote entry panel ── */}
                      {(isOwnerOrAdmin || isHost) && isActive && proxyOpenIds.has(c.id) && (
                        <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
                          <p className="text-xs text-gray-600 uppercase tracking-wide font-medium">Enter votes on behalf of members</p>
                          {members.map(m => {
                            const existingVote = votes.find(v => v.contribution_id === c.id && v.voter_id === m.id)
                            const proxyKey = `${c.id}_${m.id}`
                            return (
                              <div key={m.id} className="flex items-center gap-2">
                                <span className="flex-1 text-sm text-gray-400 truncate min-w-0">
                                  {m.users?.display_name}
                                  {existingVote && <span className="ml-1 text-xs text-green-700">✓</span>}
                                </span>
                                <ScoreStepper
                                  value={getProxyScore(c.id, m.id)}
                                  onChange={v => setProxyScores(prev => ({...prev, [proxyKey]: v}))}
                                />
                                <button
                                  onClick={() => handleProxyVote(c.id, m.id)}
                                  disabled={submittingProxy === proxyKey}
                                  className="px-2 py-1 text-xs bg-indigo-700 hover:bg-indigo-600 rounded disabled:opacity-40 shrink-0"
                                >
                                  {submittingProxy === proxyKey ? '…' : existingVote ? 'Update' : 'Enter'}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

      </div>
    </div>
  )
}
