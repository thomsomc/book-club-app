import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'

// Top-3 rank colors for the Hall of Fame (gold / silver / bronze)
const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600']

// Convert a number to its ordinal string — 1 → "1st", 2 → "2nd", etc.
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// Compact month+year formatter for the meeting column
const MTG_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

// Returns a Tailwind className for the "Nth of M" place-in-meeting label.
// Best tables celebrate the top finishers; worst tables call out the bottom.
function placeClass(rank, meetingSize, variant) {
  if (variant === 'best') {
    if (rank === 1) return 'font-bold text-yellow-400'   // gold
    if (rank === 2) return 'font-bold text-slate-300'    // silver
    if (rank === 3) return 'font-bold text-orange-500'   // bronze
  } else {
    if (rank === meetingSize)     return 'font-bold text-red-600'    // dead last — blood red
    if (rank === meetingSize - 1) return 'font-bold text-yellow-600' // 2nd to last — mustard
    if (rank === meetingSize - 2) return 'font-bold text-orange-800' // 3rd to last — brown-orange
  }
  return ''  // no special styling for mid-pack placements
}

// ── BeerTable ──────────────────────────────────────────────────────────────
// Renders one ranked list (best or worst). Shared between both sections so
// any future column additions only need to be made in one place.
function BeerTable({ beers, title, scoreColorClass, variant }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? beers : beers.slice(0, 3)

  if (!beers.length) {
    return (
      <div className="bg-gray-900 rounded-xl p-6">
        <h2 className="font-semibold mb-3">{title}</h2>
        <p className="text-sm text-gray-600">Not enough data for this period.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800">
        <h2 className="font-semibold">{title}</h2>
      </div>

      <div className="divide-y divide-gray-800/50">
        {visible.map((beer, i) => (
          <div key={beer.contribution_id} className="px-5 py-3 flex items-start gap-3">

            {/* Rank number */}
            <span className="w-5 text-center text-xs font-bold tabular-nums text-gray-600 shrink-0 mt-0.5">
              {i + 1}
            </span>

            {/* Beer name + producer + meta row */}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-white text-sm leading-snug">
                  {beer.offering_name}
                </span>
                {/* Score — prominent, color-coded */}
                <span className={`text-sm font-bold tabular-nums shrink-0 ${scoreColorClass}`}>
                  {Number(beer.composite_score).toFixed(2)}
                </span>
              </div>

              {/* Second line: producer · contributor · meeting · place */}
              <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-1.5">
                {beer.producer && (
                  <>
                    <span className="truncate max-w-[140px]">{beer.producer}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>by {beer.contributor_name}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">
                  Mtg #{beer.meeting_number} {MTG_DATE_FMT.format(new Date(beer.held_at))}
                </span>
                <span aria-hidden>·</span>
                {/* Place in meeting — accented for podium and cellar finishes */}
                <span className={`shrink-0 ${placeClass(Number(beer.meeting_rank), Number(beer.meeting_size), variant)}`}>
                  {ordinal(Number(beer.meeting_rank))} of {beer.meeting_size}
                </span>
              </p>
            </div>

          </div>
        ))}
      </div>

      {beers.length > 3 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full py-2.5 text-xs text-gray-500 hover:text-gray-300 transition-colors border-t border-gray-800"
        >
          {expanded ? 'Show less' : `Show all ${beers.length}`}
        </button>
      )}
    </div>
  )
}

// ── StatsView ──────────────────────────────────────────────────────────────
export default function StatsView({ club }) {
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  // Available years for the filter dropdown — loaded once on mount
  const [years, setYears]               = useState([])
  const [selectedYear, setSelectedYear] = useState('all')

  // Aggregated results from database RPCs
  const [memberStats, setMemberStats]           = useState([])
  const [nostradamusStats, setNostradamusStats] = useState([])
  const [bestBeers, setBestBeers]               = useState([])
  const [worstBeers, setWorstBeers]             = useState([])

  // Which leaderboard column to sort by
  const [sortBy, setSortBy] = useState('wins')

  // Three-stage expand: 0 = top 5, 1 = top 20, 2 = all
  const [leaderboardExpand, setLeaderboardExpand] = useState(0)

  useEffect(() => {
    loadYears()
    fetchStats(null)
  }, [club.id])

  // Load distinct years with completed meetings for the filter dropdown
  async function loadYears() {
    const { data } = await supabase
      .from('meetings')
      .select('held_at')
      .eq('club_id', club.id)
      .eq('status', 'completed')
      .is('deleted_at', null)
    const ys = [...new Set((data ?? []).map(m => new Date(m.held_at).getFullYear()))]
      .sort((a, b) => b - a)
    setYears(ys)
  }

  // Call all four RPCs in parallel. Postgres does all aggregation server-side;
  // the client receives only the final small result sets.
  async function fetchStats(year) {
    setLoading(true)
    setError(null)
    try {
      const [msRes, nsRes, bbRes, wbRes] = await Promise.all([
        supabase.rpc('get_member_stats',      { p_club_id: club.id, p_year: year }),
        supabase.rpc('get_nostradamus_stats', { p_club_id: club.id, p_year: year }),
        supabase.rpc('get_best_beers',        { p_club_id: club.id, p_year: year }),
        supabase.rpc('get_worst_beers',       { p_club_id: club.id, p_year: year }),
      ])
      if (msRes.error) throw msRes.error
      if (nsRes.error) throw nsRes.error
      if (bbRes.error) throw bbRes.error
      if (wbRes.error) throw wbRes.error
      setMemberStats(msRes.data ?? [])
      setNostradamusStats(nsRes.data ?? [])
      setBestBeers(bbRes.data ?? [])
      setWorstBeers(wbRes.data ?? [])
    } catch (err) {
      setError(err.message ?? String(err))
    }
    setLoading(false)
  }

  function handleYearChange(e) {
    const val = e.target.value
    setSelectedYear(val)
    fetchStats(val === 'all' ? null : parseInt(val))
  }

  // Client-side sort of the ~60-row leaderboard result set
  const sortedRows = useMemo(() => {
    const rows = [...memberStats]
    if (sortBy === 'wins') {
      return rows.sort((a, b) =>
        b.wins - a.wins || (b.avg_composite ?? 0) - (a.avg_composite ?? 0)
      )
    }
    if (sortBy === 'avg') {
      return rows.sort((a, b) => {
        if (a.avg_composite == null && b.avg_composite == null) return 0
        if (a.avg_composite == null) return 1
        if (b.avg_composite == null) return -1
        return b.avg_composite - a.avg_composite || b.wins - a.wins
      })
    }
    if (sortBy === 'beers') {
      return rows.sort((a, b) =>
        b.contribution_count - a.contribution_count || b.wins - a.wins
      )
    }
    return rows
  }, [memberStats, sortBy])

  // Nostradamus stats arrive sorted closest → furthest from DB
  const nostradamus   = nostradamusStats[0] ?? null
  const nostradumbass = nostradamusStats[nostradamusStats.length - 1] ?? null

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="text-center text-gray-500 py-16">Calculating stats…</div>
  }
  if (error) {
    return <div className="text-red-400 text-sm p-4">{error}</div>
  }
  if (!memberStats.length) {
    return <div className="text-center text-gray-500 py-16">No completed meetings yet.</div>
  }

  return (
    <div className="space-y-6">

      {/* Year filter */}
      <div className="flex justify-end">
        <select
          value={selectedYear}
          onChange={handleYearChange}
          className="px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500"
        >
          <option value="all">All Time</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Hall of Fame leaderboard */}
      <div className="bg-gray-900 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold">Hall of Fame</h2>
          <div className="flex gap-1">
            {[
              { key: 'wins',  label: 'Wins'     },
              { key: 'avg',   label: 'Avg Score' },
              { key: 'beers', label: 'Beers'     },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  sortBy === key
                    ? 'bg-emerald-700 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-gray-800/50">
          {(leaderboardExpand === 0 ? sortedRows.slice(0, 5)
          : leaderboardExpand === 1 ? sortedRows.slice(0, 20)
          : sortedRows).map((row, i) => (
            <div key={row.membership_id} className="px-5 py-3 flex items-center gap-3">
              <span className={`w-5 text-center text-sm font-bold tabular-nums shrink-0 ${RANK_COLORS[i] ?? 'text-gray-600'}`}>
                {i + 1}
              </span>
              <span className={`flex-1 text-sm font-medium truncate ${i < 3 ? 'text-white' : 'text-gray-400'}`}>
                {row.display_name}
              </span>
              <div className="flex gap-5 text-sm tabular-nums shrink-0">
                <span className={`w-8 text-center ${
                  row.wins > 0
                    ? (i < 3 ? 'text-white font-semibold' : 'text-gray-400')
                    : 'text-gray-700'
                }`}>
                  {row.wins > 0 ? row.wins : '—'}
                </span>
                <span className={`w-10 text-center ${
                  row.avg_composite != null
                    ? (i < 3 ? 'text-white' : 'text-gray-400')
                    : 'text-gray-700'
                }`}>
                  {row.avg_composite != null ? Number(row.avg_composite).toFixed(2) : '—'}
                </span>
                <span className={`w-8 text-center ${i < 3 ? 'text-white' : 'text-gray-400'}`}>
                  {row.contribution_count}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-2 border-t border-gray-800 flex items-center gap-3 text-xs text-gray-600">
          <span className="w-5 shrink-0" />
          {/* Expand / collapse trigger */}
          {sortedRows.length > 5 && (
            <button
              onClick={() => setLeaderboardExpand(e => e < 2 ? e + 1 : 0)}
              className="flex-1 text-left hover:text-gray-300 transition-colors"
            >
              {leaderboardExpand === 0 && `Show top 20`}
              {leaderboardExpand === 1 && `Show all ${sortedRows.length}`}
              {leaderboardExpand === 2 && 'Show less'}
            </button>
          )}
          {sortedRows.length <= 5 && <span className="flex-1" />}
          <div className="flex gap-5 shrink-0">
            <span className="w-8 text-center">Wins</span>
            <span className="w-10 text-center">Avg</span>
            <span className="w-8 text-center">Beers</span>
          </div>
        </div>
      </div>

      {/* Nostradamus / Nostradumbass */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-xl p-5">
          <p className="text-xs font-medium text-indigo-400 uppercase tracking-wide">Nostradamus</p>
          <p className="text-xs text-gray-600 mt-0.5 mb-3">Closest to the group consensus</p>
          {nostradamus ? (
            <>
              <p className="font-semibold text-white">{nostradamus.display_name}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                avg ±{Number(nostradamus.avg_delta).toFixed(3)} from group
              </p>
              <p className="text-xs text-gray-600">
                {Number(nostradamus.votes_cast).toLocaleString()} votes cast
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-600">Not enough data</p>
          )}
        </div>

        <div className="bg-gray-900 rounded-xl p-5">
          <p className="text-xs font-medium text-red-400 uppercase tracking-wide">Nostradumbass</p>
          <p className="text-xs text-gray-600 mt-0.5 mb-3">Furthest from the group consensus</p>
          {nostradumbass && nostradumbass.membership_id !== nostradamus?.membership_id ? (
            <>
              <p className="font-semibold text-white">{nostradumbass.display_name}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                avg ±{Number(nostradumbass.avg_delta).toFixed(3)} from group
              </p>
              <p className="text-xs text-gray-600">
                {Number(nostradumbass.votes_cast).toLocaleString()} votes cast
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-600">Not enough data</p>
          )}
        </div>
      </div>

      {/* Best and worst beer ranked tables */}
      <BeerTable
        beers={bestBeers}
        title={selectedYear === 'all' ? 'Best Beers — All Time' : `Best Beers of ${selectedYear}`}
        scoreColorClass="text-yellow-400"
        variant="best"
      />
      <BeerTable
        beers={worstBeers}
        title={selectedYear === 'all' ? 'Worst Beers — All Time' : `Worst Beers of ${selectedYear}`}
        scoreColorClass="text-red-400"
        variant="worst"
      />

    </div>
  )
}
