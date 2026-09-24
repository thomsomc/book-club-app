import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import OfferingsView from '../components/OfferingsView'

// Public offerings page — no auth required.
// Accessible at /c/:slug/offerings when clubs.settings.allow_public_offerings = true.
// Used for grocery-store look-ups, sharing on social media, etc.
export default function PublicOfferings() {
  const { slug } = useParams()

  // Fetch just enough club info to render the page header — the OfferingsView
  // component fetches the actual offerings list via its own RPC call.
  const [club, setClub]       = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [restricted, setRestricted] = useState(false)

  useEffect(() => {
    async function loadClub() {
      const { data } = await supabase
        .from('clubs')
        .select('name, slug, settings')
        .eq('slug', slug)
        .single()

      if (!data) {
        setNotFound(true)
        return
      }

      if (!data.settings?.allow_public_offerings) {
        setRestricted(true)
        return
      }

      setClub(data)
    }
    loadClub()
  }, [slug])

  // ── Edge cases ─────────────────────────────────────────────────────────────

  if (notFound) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center space-y-2">
        <p className="text-white font-semibold">Club not found</p>
        <p className="text-sm text-gray-500">Check the link and try again.</p>
      </div>
    </div>
  )

  if (restricted) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center space-y-2">
        <p className="text-white font-semibold">This list is private</p>
        <p className="text-sm text-gray-500">The club hasn't enabled public access to their beer catalog.</p>
      </div>
    </div>
  )

  if (!club) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500 text-sm">
      Loading…
    </div>
  )

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-6 py-10">

        {/* Club header — minimal branding, no nav links */}
        <div className="mb-8">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Beer Catalog</p>
          <h1 className="text-2xl font-bold">{club.name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Search our history before you shop — find out if we've tried it before.
          </p>
        </div>

        {/* Offerings search — isPublic=true uses the anon-accessible RPC */}
        <OfferingsView slug={slug} isPublic />

        {/* Footer */}
        <p className="text-xs text-gray-700 text-center mt-10">
          Powered by Hop Log
        </p>

      </div>
    </div>
  )
}
