import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import MembersList from '../components/MembersList'
import MeetingsList from '../components/MeetingsList'
import StatsView from '../components/StatsView'
import OfferingsView from '../components/OfferingsView'
import ClubSettings from './ClubSettings'

const BASE_TABS = ['Meetings', 'Stats', 'Past Offerings', 'Members', 'Overview']

// clubs = full list of the user's clubs; used to decide whether to show the
// "All Clubs" back button (only shown when the user belongs to more than one).
export default function ClubDashboard({ club, clubs = [], session, displayName, onSwitchClub, onSignOut, onClubUpdated }) {
  const [activeTab, setActiveTab] = useState('Meetings')
  const [myRole, setMyRole] = useState(null)
  const [copied, setCopied] = useState(false)
  const [currentClub, setCurrentClub] = useState(club)

  // Keep local club state in sync when the parent passes a new club object
  useEffect(() => { setCurrentClub(club) }, [club])

  function handleClubUpdated(updated) {
    setCurrentClub(updated)
    onClubUpdated?.(updated)
  }

  const isOwnerOrAdmin = myRole === 'owner' || myRole === 'admin'
  const TABS = isOwnerOrAdmin ? [...BASE_TABS, 'Settings'] : BASE_TABS

  const inviteLink = `${window.location.origin}/join/${club.slug}`

  useEffect(() => {
    async function loadMyRole() {
      const { data } = await supabase
        .from('memberships')
        .select('role')
        .eq('club_id', club.id)
        .eq('user_id', session.user.id)
        .eq('status', 'active')
        .single()
      setMyRole(data?.role ?? null)
    }
    loadMyRole()
  }, [club.id, session.user.id])

  function copyInviteLink() {
    navigator.clipboard.writeText(inviteLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto p-8">

        {/* Back link — only shown when the user belongs to more than one club */}
        {clubs.length > 1 && (
          <button
            onClick={onSwitchClub}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white mb-4 transition-colors"
          >
            ← All Clubs
          </button>
        )}

        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">{currentClub.name}</h1>
          <div className="flex items-center gap-3">
            {displayName && (
              <span className="text-sm text-gray-400">
                Signed in as <span className="text-white font-medium">{displayName}</span>
              </span>
            )}
            <button
              onClick={() => { supabase.auth.signOut().then(onSignOut) }}
              className="px-4 py-2 bg-gray-800 rounded-lg text-gray-400 hover:text-white text-sm"
            >
              Sign out
            </button>
          </div>
        </div>

        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'Meetings' && (
          <MeetingsList club={currentClub} session={session} myRole={myRole} />
        )}

        {activeTab === 'Stats' && (
          <StatsView club={currentClub} />
        )}

        {activeTab === 'Past Offerings' && (
          <OfferingsView clubId={currentClub.id} />
        )}

        {activeTab === 'Members' && (
          <MembersList club={currentClub} session={session} myRole={myRole} />
        )}

        {activeTab === 'Overview' && (
          <div className="bg-gray-900 rounded-xl p-6">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">Invite Link</h2>
            <div className="flex gap-3">
              <code className="flex-1 bg-gray-800 px-4 py-2 rounded-lg text-sm text-gray-300 truncate">
                {inviteLink}
              </code>
              <button
                onClick={copyInviteLink}
                className="px-4 py-2 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'Settings' && isOwnerOrAdmin && (
          <ClubSettings
            club={currentClub}
            session={session}
            myRole={myRole}
            onClubUpdated={handleClubUpdated}
          />
        )}

      </div>
    </div>
  )
}
