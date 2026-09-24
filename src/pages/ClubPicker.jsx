import { supabase } from '../lib/supabase'

// Shown when the logged-in user belongs to more than one club.
// Lets them pick which club to enter, or sign out.
export default function ClubPicker({ clubs, displayName, onSelect, onSignOut }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">

      {/* Header row: greeting + sign-out */}
      <div className="w-full max-w-md flex justify-between items-center mb-10">
        <div>
          <h1 className="text-2xl font-bold">Your Clubs</h1>
          {displayName && (
            <p className="text-sm text-gray-400 mt-0.5">
              Signed in as <span className="text-white font-medium">{displayName}</span>
            </p>
          )}
        </div>
        <button
          onClick={() => { supabase.auth.signOut(); onSignOut() }}
          className="px-4 py-2 bg-gray-800 rounded-lg text-gray-400 hover:text-white text-sm"
        >
          Sign out
        </button>
      </div>

      {/* Club cards — one per club the user belongs to */}
      <div className="w-full max-w-md space-y-3">
        {clubs.map((club) => (
          <button
            key={club.id}
            onClick={() => onSelect(club)}
            className="w-full text-left bg-gray-900 hover:bg-gray-800 rounded-xl p-5 transition-colors group"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-lg">{club.name}</p>
                {club.description && (
                  <p className="text-sm text-gray-400 mt-0.5">{club.description}</p>
                )}
              </div>
              {/* Arrow nudges right on hover to hint it's clickable */}
              <span className="text-gray-500 group-hover:text-white transition-colors text-xl">→</span>
            </div>
          </button>
        ))}
      </div>

    </div>
  )
}
