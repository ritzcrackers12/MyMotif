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

{"primaryEmotion":"","feelingSummary":"","curatorArtistPick":"","spotifyMoodKeywords":"","art1":{"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":""},"styleExplore":{"styleLabel":"","traditionOrScene":"","whyThisFits":"","exploreSearchQuery":""},"searchTrails":["","",""]}

Rules:
- \`curatorArtistPick\` must match **exactly** one artist name from the ARTIST UNIVERSE in the system prompt (exact spelling).
- \`art1\`: exactly **one** concrete interactive or named work (same rules as before). No second art slot.
- \`styleExplore.styleLabel\`: a **named** aesthetic, movement, or cultural lens (e.g. wabi-sabi, cyber sigilism, Afrofuturism, Memphis Group, New Sincerity, brutalism in web design). Not a generic word like "sad" — a real style or scene someone can research.
- \`styleExplore.traditionOrScene\`: one short line — where it comes from (art history, internet culture, fashion, architecture, etc.).
- \`styleExplore.whyThisFits\`: must quote **specific phrases** from the journal and tie them to that style (mandatory close reading).
- \`styleExplore.exploreSearchQuery\`: one **specific** Google-ready query combining the style + something concrete from the entry (so results match *this* journal, not a generic wiki page).
- \`art1.youtubeSearchQuery\` — optional; if set, must be **specific** for YouTube **search results**.
- \`searchTrails\`: 3 research queries; one mentions Genius or Reddit; at least one should connect to \`styleExplore\` or the art pick.`;
}

/** Appended to the user message for step 2 (explain Spotify/iTunes result + art picks). */
export function buildVibeStep2OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"artistReason":"","musicMatchScore":0,"refinedSpotifyQuery":null,"art1Reason":"","art1MatchScore":0,"styleExploreReason":"","styleExploreMatchScore":0}`;
}

export function buildVibeReshuffleMusicContract() {
    return `OUTPUT: {"curatorArtistPick":"","spotifyMoodKeywords":""}`;
}

export function buildVibeReshuffleArtContract() {
    return `OUTPUT: {"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":"","reason":"","artMatchScore":0}`;
}

export function buildVibeReshuffleStyleContract() {
    return `OUTPUT: {"styleLabel":"","traditionOrScene":"","whyThisFits":"","exploreSearchQuery":"","reason":"","styleMatchScore":0}`;
}
