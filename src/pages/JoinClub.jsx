import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function JoinClub({ onJoined }) {
  const { slug } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    async function join() {
      const { data, error } = await supabase.rpc('join_club', { p_slug: slug })
      if (error) setError(error.message)
      else { onJoined(data); navigate('/', { replace: true }) }
    }
    join()
  }, [slug])

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-white">
      {!error && <p className="text-gray-400">Joining club…</p>}
      {error && (
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button onClick={() => navigate('/')} className="text-indigo-400 hover:text-indigo-300">
            Go home
          </button>
        </div>
      )}
    </div>
  )
}
