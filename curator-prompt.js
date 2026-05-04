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

{"primaryEmotion":"","feelingSummary":"","curatorArtistPick":"","spotifyMoodKeywords":"","art1":{"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":""},"art2":{"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":""},"searchTrails":["","",""]}

Rules:
- \`curatorArtistPick\` must match **exactly** one artist name from the ARTIST UNIVERSE in the system prompt (exact spelling).
- \`art1.youtubeSearchQuery\` / \`art2.youtubeSearchQuery\` — optional; if set, must be **specific** (\`"Work Title" creator medium\`) for YouTube **search results**.
- \`searchTrails\`: 3 research queries; one mentions Genius or Reddit.`;
}

/** Appended to the user message for step 2 (explain Spotify/iTunes result + art picks). */
export function buildVibeStep2OutputContract() {
    return `OUTPUT: Valid JSON only. No markdown or preamble.

{"artistReason":"","musicMatchScore":0,"refinedSpotifyQuery":null,"art1Reason":"","art2Reason":"","art1MatchScore":0,"art2MatchScore":0}`;
}

export function buildVibeReshuffleMusicContract() {
    return `OUTPUT: {"curatorArtistPick":"","spotifyMoodKeywords":""}`;
}

export function buildVibeReshuffleArtContract() {
    return `OUTPUT: {"label":"","type":"","medium":"","workTitle":"","creatorName":"","findUrl":"","fallbackSearchQuery":"","youtubeSearchQuery":"","reason":"","artMatchScore":0}`;
}
