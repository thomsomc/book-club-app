import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import ClubDashboard from './pages/ClubDashboard'
import ClubPicker from './pages/ClubPicker'
import JoinClub from './pages/JoinClub'
import MeetingView from './pages/MeetingView'
import PublicOfferings from './pages/PublicOfferings'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [clubs, setClubs] = useState([])
  const [displayName, setDisplayName] = useState(null)
  // Which club the user has actively chosen to view. Null means "not yet chosen"
  // (or the user only has one club, in which case we auto-select it below).
  const [selectedClub, setSelectedClub] = useState(null)

  async function loadUserProfile(currentSession) {
    if (!currentSession) { setDisplayName(null); return }
    const { data } = await supabase
      .from('users')
      .select('display_name')
      .eq('id', currentSession.user.id)
      .single()
    setDisplayName(data?.display_name ?? currentSession.user.email)
  }

  async function loadClubs(currentSession) {
    if (!currentSession) { setClubs([]); return }
    const { data } = await supabase
      .from('memberships')
      .select('clubs(*)')
      .eq('user_id', currentSession.user.id)
      .eq('status', 'active')
    setClubs(data?.map((m) => m.clubs).filter(Boolean) ?? [])
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session)
      await Promise.all([loadClubs(session), loadUserProfile(session)])
      setLoading(false)
    }).catch(() => {
      // If Supabase is unreachable, stop the loading spinner so the user
      // sees the login page rather than a permanent blank screen.
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      loadClubs(session)
      loadUserProfile(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) return null

  return (
    <BrowserRouter>
      <Routes>
        {/* Public route — no auth required */}
        <Route path="/c/:slug/offerings" element={<PublicOfferings />} />

        <Route path="/login" element={
          session ? <Navigate to="/" replace /> : <Login />
        } />
        <Route path="/meeting/:meetingId" element={
          session ? (
            <MeetingView
              session={session}
              displayName={displayName}
              onBack={(clubId) => {
                const club = clubs.find(c => c.id === clubId)
                if (club) setSelectedClub(club)
              }}
            />
          ) : <Navigate to="/login" replace />
        } />
        <Route path="/join/:slug" element={
          session
            ? <JoinClub onJoined={(club) => setClubs((prev) => [...prev, club])} />
            : <Navigate to="/login" replace />
        } />
        <Route path="/*" element={
          !session
            ? <Navigate to="/login" replace />
            : clubs.length === 0
              // No clubs yet — walk the user through creating or joining one
              ? <Onboarding session={session} onSuccess={(club) => setClubs([club])} />
              // Determine which club to show:
              //   - selectedClub set → user already picked one, show its dashboard
              //   - exactly 1 club   → auto-select it (same UX as before for single-club users)
              //   - 2+ clubs, nothing selected → show the picker
              : (() => {
                  const club = selectedClub ?? (clubs.length === 1 ? clubs[0] : null)
                  return club
                    ? <ClubDashboard
                        club={club}
                        clubs={clubs}
                        session={session}
                        displayName={displayName}
                        onSwitchClub={() => setSelectedClub(null)}
                        onSignOut={() => { setClubs([]); setSelectedClub(null) }}
                        onClubUpdated={(updated) => {
                          setClubs(prev => prev.map(c => c.id === updated.id ? updated : c))
                          setSelectedClub(updated)
                        }}
                      />
                    : <ClubPicker
                        clubs={clubs}
                        displayName={displayName}
                        onSelect={setSelectedClub}
                        onSignOut={() => { setClubs([]); setSelectedClub(null) }}
                      />
                })()
        } />
      </Routes>
    </BrowserRouter>
  )
}
