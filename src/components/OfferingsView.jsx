import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import Fuse from 'fuse.js'
import { supabase } from '../lib/supabase'

// ── Score pill ────────────────────────────────────────────────────────────────
// Color-coded by score band so quality is scannable at a glance.
function ScorePill({ score }) {
  if (score == null) return null
  const n = Number(score)
  const color =
    n >= 4.0 ? 'bg-emerald-900 text-emerald-300' :
    n >= 3.0 ? 'bg-indigo-900 text-indigo-300'   :
    n >= 2.0 ? 'bg-yellow-900 text-yellow-300'   :
               'bg-red-900 text-red-400'
  return (
    <span className={`text-xs font-mono font-semibold px-2 py-0.5 rounded-full ${color}`}>
      {n.toFixed(2)}
    </span>
  )
}

// ── OfferingCard ──────────────────────────────────────────────────────────────
function OfferingCard({ offering }) {
  const meta = [
    offering.style,
    offering.abv != null ? `${Number(offering.abv).toFixed(1)}%` : null,
  ].filter(Boolean).join(' · ')

  const lastDate = offering.last_brought_at
    ? new Date(offering.last_brought_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : null

  const contributors = offering.contributors?.filter(Boolean) ?? []

  return (
    <div className="bg-gray-900 rounded-xl px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Beer name — the thing you're scanning for on the shelf */}
          <p className="font-semibold text-white leading-snug">{offering.name}</p>
          {/* Brewery name — second most searchable field */}
          {offering.producer && (
            <p className="text-sm text-gray-400 mt-0.5 truncate">{offering.producer}</p>
          )}
          {/* Style + ABV */}
          {meta && <p className="text-xs text-gray-600 mt-0.5">{meta}</p>}
          {/* Contributors — shown only if the club exposes them */}
          {contributors.length > 0 && (
            <p className="text-xs text-gray-600 mt-1">
              Brought by {contributors.join(', ')}
            </p>
          )}
        </div>

        {/* Right column: score + stats */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <ScorePill score={offering.avg_score} />
          <p className="text-xs text-gray-600 whitespace-nowrap">
            {offering.times_brought}× brought
          </p>
          {lastDate && (
            <p className="text-xs text-gray-700 whitespace-nowrap">{lastDate}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── OfferingsView ─────────────────────────────────────────────────────────────
// Shared component used by the in-app "Beers" tab and the public offerings page.
//
// Props:
//   clubId   uuid   – pass for authenticated in-app view
//   slug     string – pass for public view (no auth)
//   isPublic bool   – true when rendering the public page (affects RPC choice)
export default function OfferingsView({ clubId, slug, isPublic = false }) {
  const [offerings, setOfferings] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  // Pre-fill search from ?q= URL param — barcode/photo apps redirect here
  // with the identified beer name already in the query string.
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')

  // Debounce: wait 150 ms after the user stops typing before filtering.
  // This keeps rendering smooth even on low-end phones.
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    loadOfferings()
  }, [clubId, slug])

  async function loadOfferings() {
    setLoading(true)
    setError(null)
    let result
    if (isPublic) {
      result = await supabase.rpc('get_public_offerings', { p_slug: slug })
    } else {
      result = await supabase.rpc('get_club_offerings', { p_club_id: clubId })
    }
    if (result.error) {
      setError(result.error.message)
    } else {
      // The RPC returns jsonb (a single value), so result.data is already the array.
      setOfferings(Array.isArray(result.data) ? result.data : [])
    }
    setLoading(false)
  }

  // Fuse.js instance — rebuilt only when the offerings list changes, not on
  // every keystroke.  Multi-field fuzzy search: name is weighted heaviest,
  // then producer (brewery), then style.  Threshold 0.4 allows mild typos and
  // partial word matches while filtering out clearly unrelated results.
  const fuse = useMemo(() => new Fuse(offerings, {
    keys: [
      { name: 'name',     weight: 0.5  },
      { name: 'producer', weight: 0.35 },
      { name: 'style',    weight: 0.15 },
    ],
    threshold:          0.4,
    includeScore:       true,
    minMatchCharLength: 2,
    ignoreLocation:     true,  // match anywhere in the string, not just the start
  }), [offerings])

  // Results: fuzzy matches when query is long enough, full list otherwise.
  const results = debouncedQuery.length >= 2
    ? fuse.search(debouncedQuery).map(r => r.item)
    : offerings

  // Keep ?q= in sync with the search box so links can be shared/bookmarked
  function handleQueryChange(val) {
    setQuery(val)
    if (val) {
      setSearchParams({ q: val }, { replace: true })
    } else {
      setSearchParams({}, { replace: true })
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="py-12 text-center text-gray-500 text-sm">Loading beers…</div>
  )

  if (error) return (
    <div className="py-12 text-center text-red-400 text-sm">{error}</div>
  )

  return (
    <div className="space-y-4">

      {/* ── Search bar ────────────────────────────────────────────────────── */}
      <div className="relative">
        {/* Search icon */}
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm pointer-events-none">
          🔍
        </span>
        <input
          type="text"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          placeholder="Search by beer name, brewery, or style…"
          autoComplete="off"
          // Large touch target — easy to use one-handed at a grocery store
          className="w-full pl-10 pr-10 py-3 bg-gray-900 text-white rounded-xl border border-gray-700 focus:outline-none focus:border-indigo-500 text-sm placeholder-gray-600"
        />
        {/* Clear button */}
        {query && (
          <button
            onClick={() => handleQueryChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-lg leading-none"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* ── Result count ──────────────────────────────────────────────────── */}
      <p className="text-xs text-gray-600 px-1">
        {debouncedQuery.length >= 2
          ? `${results.length} match${results.length !== 1 ? 'es' : ''} for "${debouncedQuery}"`
          : `${offerings.length} beer${offerings.length !== 1 ? 's' : ''} in the catalog`
        }
      </p>

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {results.length === 0 ? (
        <div className="bg-gray-900 rounded-xl p-8 text-center text-gray-500 text-sm">
          No beers found for "{debouncedQuery}". Try the brewery name or style.
        </div>
      ) : (
        <div className="space-y-2">
          {results.map(o => (
            <OfferingCard key={o.id} offering={o} />
          ))}
        </div>
      )}
    </div>
  )
}
