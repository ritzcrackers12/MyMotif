/** Must match names in GROQ_SYSTEM_PROMPT (ARTIST UNIVERSE) for resolveCuratorArtistPick. */
export const CURATOR_ARTISTS = [
    "Pz'",
    'Tezzus',
    'diamond*',
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
    'Summrs',
    'Teezus'
];

/** Appended to the user message for step 1 (journal → structured JSON). */
export function buildVibeStep1OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"primaryEmotion":"","feelingSummary":"","curatorArtistPick":"","spotifyMoodKeywords":"","philosophy":{"name":"","definition":"","exploreUrl":""},"interactive":{"siteName":"","experienceName":"","url":"","instruction":""},"searchTrails":[]}

Rules:
- \`curatorArtistPick\` must match **exactly** one artist name from the ARTIST UNIVERSE in the system prompt (exact spelling).
- \`philosophy\`: pick **one** design philosophy from the DESIGN PHILOSOPHY UNIVERSE in the system prompt — the one that best matches the **texture** of the entry, not the generic theme. \`name\` is the movement title; \`definition\` one line, under 15 words; \`exploreUrl\` must be \`https://www.google.com/search?q=\` plus an encoded query for that philosophy name.
- \`interactive\`: pick **one** of the five allowed sources (neal.fun, theuselessweb.com, patatap.com, itch.io, radio.garden). \`siteName\` is the human-readable site label; \`experienceName\` names the experience or how to use it; \`url\` must be **only** a URL format from the ALLOWED INTERACTIVE SOURCES section in the system prompt; \`instruction\` is one line telling the user what to do on the page (e.g. "press any key").
- \`searchTrails\`: optional array of extra Google-ready strings (0–3). Omit or use [] if none; do not pad with filler.`;
}

/** Appended to the user message for step 2 (explain Spotify/iTunes result + art picks). */
export function buildVibeStep2OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"artistReason":"","musicMatchScore":0,"refinedSpotifyQuery":null,"philosophyReason":"","philosophyMatchScore":0,"interactiveReason":"","interactiveMatchScore":0}`;
}

export function buildVibeReshuffleMusicContract() {
    return `OUTPUT: {"curatorArtistPick":"","spotifyMoodKeywords":""}`;
}

export function buildVibeReshufflePhilosophyContract() {
    return `OUTPUT: {"philosophy":{"name":"","definition":"","reason":"","exploreUrl":""},"philosophyMatchScore":0}`;
}

export function buildVibeReshuffleInteractiveContract() {
    return `OUTPUT: {"interactive":{"siteName":"","experienceName":"","reason":"","url":"","instruction":""},"interactiveMatchScore":0}`;
}
