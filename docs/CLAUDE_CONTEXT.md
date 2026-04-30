# Book Club App — Claude Code Context

## What this is
A multi-tenant club management platform. The immediate customer is a 
15-year-old beer tasting club in Cincinnati called "Book Club" (long story).
The platform is built to serve any tasting/rating club type.

## Author
Matt Thomson

## Key decisions already made
- Offerings (not "beers") — category-agnostic by design
- Multi-tenant from day one — CLUBS table, everything hangs off it
- Feature flags on every non-core feature — gated by plan tier
- Rating input: 0.1 increment stepper UI, composite displays to 2dp
- Invitation approval: shared draft link + comments, not a formal workflow
- Duplicate check: silent, secret, configurable per club
- Self-votes: recorded always, excluded from composite, used for awards
- Wheel of Fate: real-time broadcast via Supabase Realtime
- PII separated into USER_PII table, restricted RLS, admin-blind

## Stack
- Frontend: React + Vite + Tailwind CSS
- Database/Auth/Realtime: Supabase
- Hosting: Vercel
- Email: Resend
- AI: Anthropic Claude API
- Reference data: Open Brewery DB

## Current phase
Phase 1 — Foundation. Goal: working deployed app the Beer Club 
can use for a real meeting.

## Phase 1 priorities in order
1. React + Vite project scaffold ✓
2. Supabase project connected
3. Auth (magic link + password)
4. Club creation and invite flow
5. Member management
6. Meeting creation
7. Offering logging with duplicate check
8. Basic meeting history
9. Data migration from Google Sheets
10. Deploy to Vercel

## Tone
This is a portfolio project and a learning exercise. Explain decisions.
Don't just write code — help the developer understand what you're doing and why.
