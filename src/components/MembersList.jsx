import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const ASSIGNABLE_ROLES = ['admin', 'member', 'guest', 'alumni']

export default function MembersList({ club, session, myRole }) {
  const [members, setMembers] = useState([])
  const isOwner = myRole === 'owner'

  useEffect(() => { loadMembers() }, [club.id])

  async function loadMembers() {
    const { data } = await supabase
      .from('memberships')
      .select('id, role, joined_at, users(id, display_name)')
      .eq('club_id', club.id)
      .eq('status', 'active')
      .order('joined_at', { ascending: true })
    setMembers(data ?? [])
  }

  async function handleRoleChange(membershipId, newRole) {
    const { error } = await supabase.rpc('update_member_role', {
      p_membership_id: membershipId,
      p_new_role: newRole,
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

  return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">
        Members ({members.length})
      </h2>
      <ul className="divide-y divide-gray-800">
        {members.map((m) => {
          const isMe = m.users?.id === session.user.id
          const isTargetOwner = m.role === 'owner'
          const showControls = isOwner && !isTargetOwner && !isMe
          return (
            <li key={m.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  {m.users?.display_name ?? 'Unknown'}
                  {isMe && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                </p>
                {m.joined_at && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Joined {new Date(m.joined_at).toLocaleDateString()}
                  </p>
                )}
              </div>
              {showControls ? (
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.id, e.target.value)}
                    className="bg-gray-800 text-gray-300 text-sm rounded px-2 py-1 border border-gray-700 focus:outline-none focus:border-indigo-500"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRemove(m.id, m.users?.display_name)}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="text-xs text-gray-500 capitalize shrink-0">{m.role}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
