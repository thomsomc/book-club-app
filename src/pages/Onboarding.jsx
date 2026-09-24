import { useState } from 'react'
import { supabase } from '../lib/supabase'

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export default function Onboarding({ session, onSuccess }) {
  const [step, setStep] = useState('name') // 'name' | 'club'
  const [tab, setTab] = useState('create')  // 'create' | 'join'

  // Display name step
  const [displayName, setDisplayName] = useState(session.user.email.split('@')[0])

  // Create club form
  const [clubName, setClubName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  // Join club form
  const [inviteInput, setInviteInput] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleNameSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.from('users').upsert(
      { id: session.user.id, display_name: displayName.trim() },
      { onConflict: 'id' }
    )
    if (error) setError(error.message)
    else setStep('club')
    setLoading(false)
  }

  function handleClubNameChange(e) {
    setClubName(e.target.value)
    if (!slugEdited) setSlug(slugify(e.target.value))
  }

  async function handleCreate(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.rpc('create_club', {
      p_name: clubName,
      p_slug: slug,
    })
    if (error) setError(error.message)
    else onSuccess(data)
    setLoading(false)
  }

  async function handleJoin(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const slug = inviteInput.split('/').pop().trim()
    const { data, error } = await supabase.rpc('join_club', { p_slug: slug })
    if (error) setError(error.message)
    else onSuccess(data)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-md p-8 bg-gray-900 rounded-xl">
        <h1 className="text-2xl font-bold text-white mb-6 text-center">Welcome to Book Club</h1>

        {step === 'name' && (
          <form onSubmit={handleNameSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                What should we call you?
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500"
              />
              <p className="text-xs text-gray-500 mt-2">
                This is how you'll appear to other club members. Use your real name,
                a nickname, or whatever you like — it's up to you.
              </p>
            </div>
            <button
              type="submit"
              disabled={loading || !displayName.trim()}
              className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Saving…' : 'Continue'}
            </button>
            {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          </form>
        )}

        {step === 'club' && (
          <>
            <div className="flex gap-2 mb-6">
              {['create', 'join'].map((t) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setError(null) }}
                  className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                    tab === t ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                  }`}
                >
                  {t === 'create' ? 'Create a Club' : 'Join a Club'}
                </button>
              ))}
            </div>

            {tab === 'create' && (
              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Club name</label>
                  <input
                    type="text"
                    value={clubName}
                    onChange={handleClubNameChange}
                    placeholder="e.g. Book Club Cincinnati"
                    required
                    className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">URL slug</label>
                  <input
                    type="text"
                    value={slug}
                    onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }}
                    placeholder="book-club-cincinnati"
                    required
                    className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Used in invite links. Letters, numbers, and dashes only.</p>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {loading ? 'Creating…' : 'Create Club'}
                </button>
              </form>
            )}

            {tab === 'join' && (
              <form onSubmit={handleJoin} className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Invite link or slug</label>
                  <input
                    type="text"
                    value={inviteInput}
                    onChange={(e) => setInviteInput(e.target.value)}
                    placeholder="Paste invite link here"
                    required
                    className="w-full px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {loading ? 'Joining…' : 'Join Club'}
                </button>
              </form>
            )}

            {error && <p className="mt-4 text-red-400 text-sm text-center">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
