import { useState } from 'react'
import { supabase } from '../lib/supabase'

// ── TriToggle ─────────────────────────────────────────────────────────────────
// Three-way button group: "Default" (null) | "On" (true) | "Off" (false).
// Used to override club-level boolean settings on a per-meeting basis.
function TriToggle({ label, description, value, onChange }) {
  const options = [
    { val: null,  label: 'Default' },
    { val: true,  label: 'On'      },
    { val: false, label: 'Off'     },
  ]
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      <div className="flex shrink-0 rounded-lg overflow-hidden border border-gray-700">
        {options.map(opt => (
          <button
            key={String(opt.val)}
            type="button"
            onClick={() => onChange(opt.val)}
            className={`px-3 py-1 text-xs transition-colors ${
              value === opt.val
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── MeetingSettings ───────────────────────────────────────────────────────────
// Inline settings panel rendered in MeetingView when the ⚙ button is tapped.
// Props:
//   meeting        – the full meeting row
//   members        – active club memberships [{ id, users: { display_name } }]
//   myMembership   – caller's membership row
//   isOwnerOrAdmin – boolean
//   onSaved(updated) – called with the fresh meeting row after a successful save
//   onClose()        – called when the panel should be dismissed
export default function MeetingSettings({ meeting, members, myMembership, isOwnerOrAdmin, onSaved, onClose }) {
  // Flatten current meeting state into the form, including per-meeting settings
  // stored in meetings.metadata.settings.
  const existingSettings = meeting.metadata?.settings ?? {}

  const [form, setForm] = useState({
    title:              meeting.title ?? '',
    notes:              meeting.notes ?? '',
    // Admin-only fields
    held_at:            meeting.held_at
                          ? new Date(meeting.held_at).toISOString().slice(0, 16)
                          : '',
    host_membership_id: meeting.host_membership_id ?? '',
    meeting_number:     meeting.meeting_number != null ? String(meeting.meeting_number) : '',
    counts_for_record:  meeting.counts_for_record,
    // Per-meeting setting overrides (null = use club default)
    blind_voting:              existingSettings.blind_voting              ?? null,
    hide_scores_after_meeting: existingSettings.hide_scores_after_meeting ?? null,
    tiebreak_rule:             existingSettings.tiebreak_rule             ?? null,
    prereg_visibility:         existingSettings.prereg_visibility         ?? null,
  })

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function update(key, value) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)

    // Build the patch — only include the keys this caller is allowed to touch
    const patch = {
      title:    form.title,
      notes:    form.notes,
      settings: {
        blind_voting:              form.blind_voting,
        hide_scores_after_meeting: form.hide_scores_after_meeting,
        tiebreak_rule:             form.tiebreak_rule,
        prereg_visibility:         form.prereg_visibility,
      },
    }

    // Admin-only fields are only sent when the caller has permission
    if (isOwnerOrAdmin) {
      patch.held_at            = new Date(form.held_at).toISOString()
      patch.host_membership_id = form.host_membership_id || null
      patch.meeting_number     = form.meeting_number ? parseInt(form.meeting_number, 10) : null
      patch.counts_for_record  = form.counts_for_record
    }

    const { error: rpcError } = await supabase.rpc('update_meeting_details', {
      p_meeting_id: meeting.id,
      p_updates:    patch,
    })

    if (rpcError) {
      setError(rpcError.message)
      setSaving(false)
      return
    }

    // Reload the updated meeting row so the parent has fresh data
    const { data: updated } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meeting.id)
      .single()

    setSaving(false)
    onSaved(updated ?? meeting)
  }

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-6 mb-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Meeting Settings</h2>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-white">✕ Close</button>
      </div>

      {/* ── Meeting Details ─────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</h3>

        {/* Title and Notes — editable by host + owner/admin */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Title</label>
          <input
            type="text"
            value={form.title}
            onChange={e => update('title', e.target.value)}
            placeholder="e.g. Holiday Special (leave blank to use Meeting #)"
            className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">Notes</label>
          <textarea
            value={form.notes}
            onChange={e => update('notes', e.target.value)}
            placeholder="Any notes for this meeting…"
            rows={2}
            className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm resize-none"
          />
        </div>

        {/* Admin-only fields */}
        {isOwnerOrAdmin && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Date &amp; time</label>
                <input
                  type="datetime-local"
                  value={form.held_at}
                  onChange={e => update('held_at', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Host</label>
                <select
                  value={form.host_membership_id}
                  onChange={e => update('host_membership_id', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm"
                >
                  <option value="">— no host assigned —</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.users?.display_name}
                      {m.id === myMembership?.id ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 items-end">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Meeting #</label>
                <input
                  type="number"
                  value={form.meeting_number}
                  onChange={e => update('meeting_number', e.target.value)}
                  disabled={!form.counts_for_record}
                  placeholder="auto"
                  className="w-full px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-40"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={form.counts_for_record}
                  onChange={e => update('counts_for_record', e.target.checked)}
                  className="rounded"
                />
                Counts toward the record
              </label>
            </div>
          </>
        )}
      </section>

      {/* ── Per-meeting Settings ────────────────────────────────────────────── */}
      {/* These override the club-level defaults for this meeting only.         */}
      {/* "Default" means the club setting applies; On/Off forces the value.    */}
      <section className="space-y-4 border-t border-gray-800 pt-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          This Meeting's Settings
          <span className="ml-2 normal-case font-normal text-gray-600">overrides club defaults</span>
        </h3>

        <TriToggle
          label="Blind voting"
          description="Hide running scores until the meeting ends."
          value={form.blind_voting}
          onChange={v => update('blind_voting', v)}
        />

        <TriToggle
          label="Hide vote breakdown after meeting"
          description="Show composite scores only — not each person's individual vote."
          value={form.hide_scores_after_meeting}
          onChange={v => update('hide_scores_after_meeting', v)}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white">Tiebreak rule</p>
            <p className="text-xs text-gray-500 mt-0.5">How to resolve a tie for first place.</p>
          </div>
          <select
            value={form.tiebreak_rule ?? ''}
            onChange={e => update('tiebreak_rule', e.target.value || null)}
            className="shrink-0 px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-xs"
          >
            <option value="">Club default</option>
            <option value="none">No tiebreaker — all tied share the win</option>
            <option value="self_vote">Include contributor's self-score</option>
            <option value="host_decides">Host decides</option>
          </select>
        </div>

        {/* Pre-registration visibility override for this meeting */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white">Pre-registration visibility</p>
            <p className="text-xs text-gray-500 mt-0.5">Who can see the pre-reg list for this meeting.</p>
          </div>
          <select
            value={form.prereg_visibility ?? ''}
            onChange={e => update('prereg_visibility', e.target.value || null)}
            className="shrink-0 px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-xs"
          >
            <option value="">Club default</option>
            <option value="full">Full list</option>
            <option value="attendees_only">Attendees only</option>
            <option value="count_only">Count only</option>
            <option value="hidden">Hidden</option>
          </select>
        </div>
      </section>

      {/* ── Save / Cancel ───────────────────────────────────────────────────── */}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
