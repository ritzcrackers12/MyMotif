/** Closed universe for music — Spotify/iTunes search MUST stay inside this list (exact strings matter). */
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

/** Step 1 — journal → curator artist + mood keywords + specific art targets (no invented songs). */
export function buildVibeStep1SystemPrompt() {
    const allowedBlock = CURATOR_ARTISTS.map((a) => `- ${a}`).join('\n');
    return `You are the **first stage** of a journal discovery pipeline.

## MUSIC (hard rule)
- You MUST set \`curatorArtistPick\` to **exactly one** name from the ALLOWED list below — copy/paste the spelling **exactly** (including punctuation like * or ').
- You MUST NOT invent song titles. The app searches Spotify/iTunes using **that artist** plus your mood keywords.
- \`spotifyMoodKeywords\`: 3–12 words — texture, mood, era, situation, **no** artist names and **no** song titles.

ALLOWED ARTISTS (pick exactly one string from this list):
${allowedBlock}

## ART (hard rule — specificity over generic “vibes”)
Each art slot must name a **concrete** category and target — not a vague genre search:
- **interactive website** — a known or plausible **named** interactive / net-art / creative-code piece or tool (prefer direct URL if you know it).
- **short film / moving image** — a **specific** film/video title + director/collective (1-of-1 / festival / Vimeo legacy energy — not a random music promo).
- **writing** — a **specific** essay, poem, story, or publication **title** + author/editorial venue.
- **sculpture / painting / installation / photography** — **specific work title** + **specific artist** (museum/collection/gallery context).

Slots **must differ in medium**: e.g. one interactive web, one installation OR short film OR writing — never two vague “art aesthetic” searches.

For each slot fill:
- \`workTitle\` — the specific piece/publication/film/site **name** (not generic).
- \`creatorName\` — artist, director, writer, designer, or studio.
- \`medium\` — one of: interactive web | short film | writing | sculpture | painting | installation | photography | fashion film | other (pick precise labels).
- \`findUrl\` — **preferred** HTTPS link directly to that piece (museum object page, Vimeo video, journal article, artist project page, portfolio single-work page). If you are **not** confident the URL is real, set \`findUrl\` to "" and rely on \`fallbackSearchQuery\`.
- \`fallbackSearchQuery\` — a **tight** search string: quoted work title + creator + medium (for Google / YouTube results when no safe direct link).

Never output generic queries like "dark aesthetic abstract art". Always anchor **title + creator**.`;
}

export function buildVibeStep1OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"primaryEmotion":"","feelingSummary":"","curatorArtistPick":"","spotifyMoodKeywords":"","art1":{"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":""},"art2":{"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":""},"searchTrails":["","",""]}

Rules:
- \`curatorArtistPick\` must match **exactly** one entry from ALLOWED ARTISTS in the system prompt.
- \`art1.youtubeSearchQuery\` / \`art2.youtubeSearchQuery\` — optional; if set, must be **specific** (\`"Work Title" creator medium\`) for YouTube **search results**, not one-word vibes.
- \`searchTrails\`: 3 research queries; one mentions Genius or Reddit.`;
}

export function buildVibeStep1FullPrompt(userTaskText) {
    return `${buildVibeStep1SystemPrompt()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeStep1OutputContract()}`;
}

/** Step 2 — real track from API + journal → explanations and scores. */
export function buildVibeStep2SystemPrompt() {
    return `You are the **second stage**. You receive:
1. The user's journal (verbatim).
2. **Facts** about ONE real track returned by Spotify/iTunes search (JSON). The track is by an artist from the allowed curator list search — it exists.

Your job:
- \`artistReason\`: **2–4 sentences.** Why **this track** fits **their** journal. Short quotes from the journal OK (not the full entry).
- \`musicMatchScore\`: integer **1–10**.
- If \`musicMatchScore\` < 6, set \`refinedSpotifyQuery\` to **one** improved query: still **only** mood/texture words (no fake titles). The app will combine it with the same curator artist. Otherwise \`null\`.
- \`art1Reason\` / \`art2Reason\`: explain why **those specific works / creators / media** (named in step 1) connect to the journal — not generic “good art” or vague aesthetics.
- \`art1MatchScore\` / \`art2MatchScore\`: 1–10.

Forbidden: inventing songs, claiming you chose the Spotify result before the API, inventing URLs, or naming films/essays you did not verify exist.`;
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
    return `Output ONLY valid JSON. The user wants a **different** music direction while staying inside the **ALLOWED ARTISTS** list.

Pick a **different** \`curatorArtistPick\` (exact string from the list in USER TASK) and fresh \`spotifyMoodKeywords\` (no song titles).

Forbidden: invented track names; repeating the previous artist + keywords verbatim.`;
}

function buildVibeReshuffleMusicContract() {
    return `OUTPUT: {"curatorArtistPick":"","spotifyMoodKeywords":""}`;
}

export function buildVibeReshuffleArtFullPrompt(userTaskText) {
    return `${buildVibeReshuffleArtSystem()}\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeReshuffleArtContract()}`;
}

function buildVibeReshuffleArtSystem() {
    return `Output ONLY valid JSON. User reshuffled one art slot. Propose a **new specific** piece (new workTitle + creatorName + medium) — interactive web, short film, writing, sculpture, installation, etc. Prefer a real \`findUrl\` you trust; else "" and a sharp \`fallbackSearchQuery\`. Fresh \`label\`, \`reason\` (2–3 sentences, journal-specific).`;
}

function buildVibeReshuffleArtContract() {
    return `OUTPUT: {"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":"","reason":"","artMatchScore":0}`;
}

export function buildVibeStep2RetryFullPrompt(userTaskText) {
    return `${buildVibeStep2SystemPrompt()}\n\nNote: **Final** pass after refined search. Set \`refinedSpotifyQuery\` to null.\n\n=== USER TASK ===\n\n${userTaskText}\n\n${buildVibeStep2OutputContract()}`;
}
