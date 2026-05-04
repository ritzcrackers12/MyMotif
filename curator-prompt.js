/** Mood vocabulary (optional context for search-query tone — do not use as track names in step 1). */
export const CURATOR_ARTISTS = [
    "Pz'",
    'Tezzus',
    'diamond*',
    'Diorvsyou',
    'Southsidesilhouette',
    'Playboi Carti',
    'Ken Carson',
    'Destroy Lonely',
    'Nettspend',
    'OsamaSon',
    'Boolymon',
    'Okaymar',
    '1oneam',
    'fakemink',
    'Munyun',
    'Sahbabii',
    'Goonew',
    'Nine Vicious',
    'SlimeGetEm',
    'Noid4l',
    '2slimey',
    'Young Bans',
    'Hariroc',
    'Raq Baby',
    'Rude Wick',
    'Izaya Tiji',
    'L5',
    '0bey0pe',
    'Kasherquan',
    'Young Thug',
    'Lil Keed',
    'Slimesito',
    'Lil Trendy700',
    'Autmn',
    'Ealuhri',
    'Lildre556',
    'PradaBagShawty',
    'LiL2Posh',
    'Che',
    'Subibabii',
    'B6',
    'Sk8star',
    'BIGBABYGUCCI',
    'D Savage',
    'Brennan Jones',
    'Thouxanbanfauni',
    '03 Greedo',
    'Rio Da Yung OG',
    'NBA YoungBoy',
    'Kodak Black',
    '9lokknine',
    'Migos',
    'Dragnutz',
    'Summrs'
];

/** Step 1 — journal → search queries only (no invented songs or videos). */
export function buildVibeStep1SystemPrompt() {
    const artistLine = CURATOR_ARTISTS.slice(0, 24).join(', ');
    return `You are the **first stage** of a journal discovery pipeline. You NEVER output song titles, artist names, album names, music video titles, or specific YouTube video names. Those will come from real APIs and search pages.

Your job: read the journal, infer emotion, and write **search queries** that other systems will run:
- **Spotify** will run \`spotifySearchQuery\` and return a **real** track (you do not choose which).
- **YouTube** will open **search results pages** from \`youtubeSearchQuery\` strings — the user sees real thumbnails/results (you do not name a video).

Mood / scene reference (vocabulary only, not for naming tracks): ${artistLine}

EMOTIONAL SCENE (align spotifySearchQuery + art direction, not specific songs):
1 LONGING / DISSOCIATION — soft distance, night, numb
2 PARANOIA / SURVIVAL — tense, loyal, pressure
3 IDENTITY / FASHION / DIASPORA — style, prove, seen
4 DARK / RAGE / DETACH — void, chaos, alone
5 INTERNET / ABSURD — weird, surreal, ironic
6 STREET / REGIONAL — city, block, pride
7 RAW / SOUTHERN GOTHIC — pain, spirit, unfiltered
8 FLEX / COME-UP — win, motion, celebration

ART YOUTUBE QUERIES (critical):
- \`art1\` and \`art2\` must be **visual** discovery paths: fashion runway, lookbook, sculpture, painting, photography, **niche interactive / design / portfolio** terms, museum, editorial.
- **Never** make art queries duplicate the music lane as an "official music video" for a track you are imagining. Art is **not** the same as the song's promo video.
- \`art1.type\` and \`art2.type\` must differ (e.g. "fashion runway" vs "interactive web" vs "painting" vs "sculpture").

searchTrails: 3 multi-word research queries; one should mention Genius or Reddit; they deepen context (not duplicate spotifySearchQuery verbatim).`;
}

export function buildVibeStep1OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"primaryEmotion":"","feelingSummary":"","spotifySearchQuery":"","art1":{"label":"","type":"","youtubeSearchQuery":""},"art2":{"label":"","type":"","youtubeSearchQuery":""},"searchTrails":["","",""]}

Rules:
- \`feelingSummary\`: one sentence (emotional read of the journal).
- \`spotifySearchQuery\`: 4–14 words, mood + texture + era + regional/underground rap **vibe** for Spotify search. **No** specific song or artist names.
- \`art1\` / \`art2\`: \`label\` = short card title (not a video title). \`youtubeSearchQuery\` = what to type into YouTube search (real results only). **Different** visual angles; never the same query as the other.`;
}

export function buildVibeStep1FullPrompt(userTaskText) {
    return `${buildVibeStep1SystemPrompt()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeStep1OutputContract()}`;
}

/** Step 2 — real track from API + journal → explanations and scores. */
export function buildVibeStep2SystemPrompt() {
    return `You are the **second stage**. You receive:
1. The user's journal (verbatim).
2. **Facts** about ONE real track returned by Spotify/iTunes search (JSON). You did NOT invent this track — it exists.

Your job:
- \`artistReason\`: **2–4 sentences.** Explain why **this specific track** fits **their** journal. Ground it in **their** words or situations (**direct quotes OK if short**, 1–2 fragments — never paste the entire journal back verbatim).
- \`musicMatchScore\`: integer **1–10** — how well the track matches the journal (be honest).
- If \`musicMatchScore\` is **below 6**, set \`refinedSpotifyQuery\` to **one** improved search query (different angle, still no fake song titles). Otherwise \`null\`.
- \`art1Reason\` / \`art2Reason\`: explain why those **YouTube search directions** (given below) are right for this journal — cite specifics; do **not** name a specific video title as if it exists.
- \`art1MatchScore\` / \`art2MatchScore\`: integers 1–10 for how well each search direction fits.

Forbidden: claiming you "picked" the track before the API, inventing different track names, or saying you searched YouTube.`;
}

export function buildVibeStep2OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"artistReason":"","musicMatchScore":0,"refinedSpotifyQuery":null,"art1Reason":"","art2Reason":"","art1MatchScore":0,"art2MatchScore":0}`;
}

export function buildVibeStep2FullPrompt(userTaskText) {
    return `${buildVibeStep2SystemPrompt()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeStep2OutputContract()}`;
}

export function buildVibeReshuffleMusicFullPrompt(userTaskText) {
    return `${buildVibeReshuffleMusicSystem()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeReshuffleMusicContract()}`;
}

function buildVibeReshuffleMusicSystem() {
    return `Output ONLY valid JSON. The user wants a **different musical angle** for the same journal.

You must output a NEW \`spotifySearchQuery\` — different vocabulary/direction from before — still **no invented song or artist names**. The app will run Spotify/iTunes search again.

Forbidden: repeating the previous query verbatim or choosing a specific track title.`;
}

function buildVibeReshuffleMusicContract() {
    return `OUTPUT: {"spotifySearchQuery":""}`;
}

export function buildVibeReshuffleArtFullPrompt(userTaskText) {
    return `${buildVibeReshuffleArtSystem()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeReshuffleArtContract()}`;
}

function buildVibeReshuffleArtSystem() {
    return `Output ONLY valid JSON. The user reshuffled **one** art card. Propose a **new** \`youtubeSearchQuery\` for that slot (visual / fashion / art / design — not a music video for the track). Also write a fresh \`label\` and \`reason\` (2–3 sentences) tied to the journal with **specific** language; do not dump the full journal.`;
}

function buildVibeReshuffleArtContract() {
    return `OUTPUT: {"label":"","type":"","youtubeSearchQuery":"","reason":"","artMatchScore":0}`;
}

export function buildVibeStep2RetryFullPrompt(userTaskText) {
    return `${buildVibeStep2SystemPrompt()}\n\nNote: This is the **final** pass after a refined Spotify search. Do not output refinedSpotifyQuery again (set it null). Be fair with the score.\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeStep2OutputContract()}`;
}
