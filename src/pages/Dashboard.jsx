import { supabase } from '../lib/supabase'

export default function Dashboard({ session }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-2">Welcome to Book Club</h1>
        <p className="text-gray-400 mb-6">{session.user.email}</p>
        <button
          onClick={() => supabase.auth.signOut()}
          className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
