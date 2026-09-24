import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Roles an owner can assign to other members
const ASSIGNABLE_ROLES = ['admin', 'member', 'guest', 'alumni']

// Status badge styles
const STATUS_STYLES = {
  active:   'bg-green-900 text-green-300',
  inactive: 'bg-gray-800 text-gray-500',
  alumni:   'bg-indigo-900 text-indigo-300',
  pending:  'bg-yellow-900 text-yellow-300',
}

// ── SaveButton ────────────────────────────────────────────────────────────────
// Small inline save button with saving/saved/error feedback states.
function SaveButton({ status, onClick, label = 'Save' }) {
  return (
    <button
      onClick={onClick}
      disabled={status === 'saving'}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
        status === 'saved'  ? 'bg-emerald-700 text-white' :
        status === 'error'  ? 'bg-red-700 text-white' :
        'bg-indigo-600 hover:bg-indigo-500 text-white'
      }`}
    >
      {status === 'saving' ? 'Saving…' :
       status === 'saved'  ? 'Saved!'  :
       status === 'error'  ? 'Error'   : label}
    </button>
  )
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <div className="mt-0.5 shrink-0">
        <div
          onClick={() => onChange(!checked)}
          className={`w-10 h-6 rounded-full transition-colors relative ${
            checked ? 'bg-indigo-600' : 'bg-gray-700'
          }`}
        >
          <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`} />
        </div>
      </div>
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
    </label>
  )
}

// ── ClubSettings ──────────────────────────────────────────────────────────────
export default function ClubSettings({ club, session, myRole, onClubUpdated }) {
  const isOwner = myRole === 'owner'

  // ── Club info ────────────────────────────────────────────────────────────
  const [name, setName]           = useState(club.name)
  const [nameStatus, setNameStatus] = useState(null)

  async function saveName() {
    if (!name.trim() || name === club.name) return
    setNameStatus('saving')
    const { error } = await supabase.rpc('update_club_info', {
      p_club_id: club.id,
      p_name:    name.trim(),
    })
    if (error) { setNameStatus('error'); return }
    setNameStatus('saved')
    onClubUpdated({ ...club, name: name.trim() })
    setTimeout(() => setNameStatus(null), 2500)
  }

  // ── Meeting settings ─────────────────────────────────────────────────────
  const [settings, setSettings]         = useState({
    blind_voting:               false,
    hide_scores_after_meeting:  false,
    tiebreak_rule:              'none',
    prereg_visibility:          'full',  // 'full' | 'count_only' | 'hidden'
    ...(club.settings ?? {}),
  })
  const [settingsStatus, setSettingsStatus] = useState(null)

  function setSetting(key, value) {
    setSettings(s => ({ ...s, [key]: value }))
    setSettingsStatus(null)  // reset saved indicator when values change
  }

  async function saveSettings() {
    setSettingsStatus('saving')
    const { error } = await supabase.rpc('update_club_info', {
      p_club_id:  club.id,
      p_settings: settings,
    })
    if (error) { setSettingsStatus('error'); return }
    setSettingsStatus('saved')
    onClubUpdated({ ...club, settings })
    setTimeout(() => setSettingsStatus(null), 2500)
  }

  // ── Members ──────────────────────────────────────────────────────────────
  const [members, setMembers] = useState([])

  useEffect(() => { loadMembers() }, [club.id])

  async function loadMembers() {
    // Include all statuses (active, inactive, alumni, pending) so the owner
    // can see the full membership history, not just the active roster.
    const { data } = await supabase
      .from('memberships')
      .select('id, role, status, joined_at, users(id, display_name)')
      .eq('club_id', club.id)
      .is('deleted_at', null)
      .order('status')         // active members appear first
      .order('joined_at', { ascending: true })
    setMembers(data ?? [])
  }

  async function handleRoleChange(membershipId, newRole) {
    const { error } = await supabase.rpc('update_member_role', {
      p_membership_id: membershipId,
      p_new_role:      newRole,
    })
    if (error) alert(error.message)
    else loadMembers()
  }

  async function handleRemove(membershipId, displayName) {
    if (!confirm(`Remove ${displayName} from the club?`)) return
    const { error } = await supabase.rpc('remove_member', { p_membership_id: membershipId })
    if (error) alert(error.message)
    else loadMembers()
  }

  // Role display order — defines both sort priority and group labels
  const ROLE_GROUPS = [
    { role: 'owner',  label: 'Owner',    defaultCollapsed: false },
    { role: 'admin',  label: 'Admins',   defaultCollapsed: false },
    { role: 'member', label: 'Members',  defaultCollapsed: false },
    { role: 'guest',  label: 'Guests',   defaultCollapsed: false },
    { role: 'alumni', label: 'Alumni',   defaultCollapsed: true  },
  ]

  // Group active members by role; inactive/removed members go in their own bucket
  const activeMembersByRole = ROLE_GROUPS.map(g => ({
    ...g,
    members: members.filter(m => m.role === g.role && m.status === 'active'),
  })).filter(g => g.members.length > 0)

  const inactiveMembers = members.filter(m => m.status !== 'active')

  // Collapsed state keyed by role slug + 'inactive' for the bottom group
  const [collapsed, setCollapsed] = useState(() =>
    Object.fromEntries([
      ...ROLE_GROUPS.map(g => [g.role, g.defaultCollapsed]),
      ['inactive', true],
    ])
  )
  function toggleGroup(key) {
    setCollapsed(c => ({ ...c, [key]: !c[key] }))
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Club Info ──────────────────────────────────────────────────────── */}
      <section className="bg-gray-900 rounded-xl p-6 space-y-4">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Club Info</h2>

        <div>
          <label className="block text-sm text-gray-400 mb-1">Club name</label>
          <div className="flex gap-3">
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setNameStatus(null) }}
              onKeyDown={e => e.key === 'Enter' && saveName()}
              disabled={!isOwner}
              className="flex-1 px-3 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-50"
            />
            {isOwner && (
              <SaveButton status={nameStatus} onClick={saveName} />
            )}
          </div>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">Invite link</label>
          <code className="block w-full bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-300 truncate">
            {window.location.origin}/join/{club.slug}
          </code>
        </div>
      </section>

      {/* ── Meeting Settings ───────────────────────────────────────────────── */}
      <section className="bg-gray-900 rounded-xl p-6 space-y-5">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Meeting Settings</h2>

        <Toggle
          checked={settings.blind_voting}
          onChange={v => setSetting('blind_voting', v)}
          label="Blind voting"
          description="Members cannot see running scores while a meeting is active. Scores are revealed when the meeting ends."
        />

        <Toggle
          checked={settings.hide_scores_after_meeting}
          onChange={v => setSetting('hide_scores_after_meeting', v)}
          label="Hide individual vote breakdown after meeting"
          description="Once a meeting is complete, only composite scores are shown — not each person's individual vote."
        />

        <div>
          <p className="text-sm font-medium text-white mb-1">Tiebreak rule</p>
          <p className="text-xs text-gray-500 mb-2">
            How to resolve a tie for first place at a meeting.
          </p>
          <select
            value={settings.tiebreak_rule}
            onChange={e => setSetting('tiebreak_rule', e.target.value)}
            disabled={!isOwner}
            className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-50"
          >
            <option value="none">No tiebreaker — all tied beers share the win</option>
            <option value="self_vote">Include contributor's self-score as tiebreaker</option>
            <option value="host_decides">Host decides</option>
          </select>
        </div>

        <div>
          <p className="text-sm font-medium text-white mb-1">Pre-registration visibility</p>
          <p className="text-xs text-gray-500 mb-2">
            What members can see about upcoming-meeting pre-registrations.
          </p>
          <select
            value={settings.prereg_visibility}
            onChange={e => setSetting('prereg_visibility', e.target.value)}
            disabled={!isOwner}
            className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-50"
          >
            <option value="full">Full — clickable list showing who's bringing what</option>
            <option value="attendees_only">Attendees only — names shown, but not what they're bringing</option>
            <option value="count_only">Count only — number of registrations, no names</option>
            <option value="hidden">Hidden — members see nothing until the meeting starts</option>
          </select>
        </div>

        {isOwner && (
          <div className="flex items-center gap-3 pt-1">
            <SaveButton status={settingsStatus} onClick={saveSettings} label="Save Settings" />
            {settingsStatus === 'error' && (
              <p className="text-xs text-red-400">Something went wrong — try again.</p>
            )}
          </div>
        )}

        {!isOwner && (
          <p className="text-xs text-gray-600">Only the club owner can change these settings.</p>
        )}
      </section>

      {/* ── Public Offerings ──────────────────────────────────────────────── */}
      <section className="bg-gray-900 rounded-xl p-6 space-y-5">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Public Beer Catalog</h2>

        <Toggle
          checked={!!settings.allow_public_offerings}
          onChange={v => setSetting('allow_public_offerings', v)}
          label="Allow public access to the beer catalog"
          description="Anyone with the link can browse your club's offering history — no account required. Great for grocery store look-ups."
        />

        {settings.allow_public_offerings && (
          <>
            <div>
              <p className="text-sm font-medium text-white mb-1">Contributor names</p>
              <p className="text-xs text-gray-500 mb-2">
                How member names appear on the public catalog.
              </p>
              <select
                value={settings.offerings_name_mask ?? 'hidden'}
                onChange={e => setSetting('offerings_name_mask', e.target.value)}
                disabled={!isOwner}
                className="w-full px-3 py-2 bg-gray-800 text-gray-300 rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm disabled:opacity-50"
              >
                <option value="hidden">Hidden — no names shown</option>
                <option value="initials">Initials only (e.g. M.T.)</option>
                <option value="first_last_initial">First name + last initial (e.g. Matt T.)</option>
                <option value="full">Full names</option>
              </select>
            </div>

            {/* Public URL for sharing */}
            <div>
              <p className="text-sm text-gray-400 mb-1">Public link</p>
              <div className="flex gap-3">
                <code className="flex-1 bg-gray-800 px-3 py-2 rounded-lg text-sm text-gray-300 truncate">
                  {window.location.origin}/c/{club.slug}/offerings
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(`${window.location.origin}/c/${club.slug}/offerings`)}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-300"
                >
                  Copy
                </button>
              </div>
            </div>
          </>
        )}

        {isOwner && (
          <div className="flex items-center gap-3 pt-1">
            <SaveButton status={settingsStatus} onClick={saveSettings} label="Save Settings" />
            {settingsStatus === 'error' && (
              <p className="text-xs text-red-400">Something went wrong — try again.</p>
            )}
          </div>
        )}

        {!isOwner && (
          <p className="text-xs text-gray-600">Only the club owner can change these settings.</p>
        )}
      </section>

      {/* ── Members ────────────────────────────────────────────────────────── */}
      <section className="bg-gray-900 rounded-xl p-6 space-y-1">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">
          Members
        </h2>

        {/* One collapsible group per role, in priority order */}
        {activeMembersByRole.map(group => (
          <div key={group.role}>
            {/* Group header — click to collapse/expand */}
            <button
              onClick={() => toggleGroup(group.role)}
              className="w-full flex items-center justify-between py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-300 transition-colors"
            >
              <span>{group.label} ({group.members.length})</span>
              <span className="text-gray-600">{collapsed[group.role] ? '▸' : '▾'}</span>
            </button>

            {!collapsed[group.role] && (
              <ul className="divide-y divide-gray-800 mb-2">
                {group.members.map(m => {
                  const isMe          = m.users?.id === session.user.id
                  const isTargetOwner = m.role === 'owner'
                  const canEdit       = isOwner && !isTargetOwner && !isMe

                  return (
                    <li key={m.id} className="flex items-center gap-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm truncate">
                            {m.users?.display_name ?? 'Unknown'}
                          </p>
                          {isMe && <span className="text-xs text-gray-500">(you)</span>}
                        </div>
                        {m.joined_at && (
                          <p className="text-xs text-gray-600 mt-0.5">
                            Joined {new Date(m.joined_at).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {canEdit ? (
                          <>
                            <select
                              value={m.role}
                              onChange={e => handleRoleChange(m.id, e.target.value)}
                              className="bg-gray-800 text-gray-300 text-xs rounded px-2 py-1 border border-gray-700 focus:outline-none focus:border-indigo-500"
                            >
                              {ASSIGNABLE_ROLES.map(r => (
                                <option key={r} value={r}>
                                  {r.charAt(0).toUpperCase() + r.slice(1)}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => handleRemove(m.id, m.users?.display_name)}
                              className="text-xs text-red-400 hover:text-red-300 px-1"
                            >
                              Remove
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-gray-600 capitalize">{m.role}</span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}

        {/* Inactive / removed members — collapsed by default */}
        {inactiveMembers.length > 0 && (
          <div>
            <button
              onClick={() => toggleGroup('inactive')}
              className="w-full flex items-center justify-between py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide hover:text-gray-400 transition-colors"
            >
              <span>Inactive / Removed ({inactiveMembers.length})</span>
              <span>{collapsed['inactive'] ? '▸' : '▾'}</span>
            </button>

            {!collapsed['inactive'] && (
              <ul className="divide-y divide-gray-800 mb-2 opacity-50">
                {inactiveMembers.map(m => (
                  <li key={m.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {m.users?.display_name ?? 'Unknown'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[m.status] ?? STATUS_STYLES.inactive}`}>
                        {m.status}
                      </span>
                      <span className="text-xs text-gray-600 capitalize">{m.role}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

    </div>
  )
}
