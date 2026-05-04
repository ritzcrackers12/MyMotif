import {
    auth,
    db,
    provider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    onAuthStateChanged,
    signOut,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
    doc,
    setDoc,
    getDoc,
    collection,
    getDocs
} from './firebase.js';
import { buildCuratorSystemPrompt } from './curator-prompt.js';

/** Default Gemini key (restrict in Google Cloud via HTTP referrers). */
const MYMOTIF_DEFAULT_GEMINI_API_KEY = 'AIzaSyBIO_RbPR64ltwkTMlVovWXruem8wAsEe0';

const WORKSPACE_BOARD_ID = 'default';

function workspaceDoc(uid) {
    return doc(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID);
}

function frameEntryDoc(uid, frameId) {
    return doc(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'frames', frameId);
}

function framesCollection(uid) {
    return collection(db, 'users', uid, 'boards', WORKSPACE_BOARD_ID, 'frames');
}

async function ensureAuthPersistence() {
    const tiers = [
        ['local', browserLocalPersistence],
        ['session', browserSessionPersistence],
        ['memory', inMemoryPersistence]
    ];
    for (const [name, persistence] of tiers) {
        try {
            await setPersistence(auth, persistence);
            console.log('MyMotif: auth persistence →', name);
            return;
        } catch (e) {
            console.warn('MyMotif: persistence failed (' + name + '):', e && (e.code || e.message));
        }
    }
}

function stashJournalSnapshotsBeforeHistory() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    canvas.querySelectorAll('.motif-frame').forEach((fr) => {
        const ta = fr.querySelector('.journal-entry-textarea');
        if (ta) fr.setAttribute('data-journal-snapshot', encodeURIComponent(ta.value));
    });
}

function restoreJournalSnapshotsAfterInnerHtml() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    canvas.querySelectorAll('.motif-frame[data-journal-snapshot]').forEach((fr) => {
        const raw = fr.getAttribute('data-journal-snapshot');
        const ta = fr.querySelector('.journal-entry-textarea');
        if (ta && raw) {
            try {
                ta.value = decodeURIComponent(raw);
            } catch {
                /* ignore */
            }
        }
    });
}

function extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
        return parts
            .filter((p) => p && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
    }
    const alt = data?.content;
    if (Array.isArray(alt)) {
        return alt
            .filter((block) => block && block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('');
    }
    return '';
}

function parseGeminiJsonFromResponse(data) {
    const text = extractGeminiText(data);
    const clean = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
    try {
        return JSON.parse(clean);
    } catch (firstErr) {
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(clean.slice(start, end + 1));
        }
        throw firstErr;
    }
}

const initApp = async () => {
    try {
        console.log('My Motif: Starting journal build…');
        const boardContainer = document.getElementById('board-container');
        const canvas = document.getElementById('canvas');
        const landingPage = document.getElementById('landing-page');
        const userIconBtn = document.querySelector('.login-trigger');
        const saveCloudBtn = document.getElementById('save-cloud-btn');
        const signupBtn = document.getElementById('signup-google-btn');
        const loginBtn = document.getElementById('login-google-btn');

        if (!boardContainer || !canvas || !landingPage) {
            throw new Error('Missing board DOM (#board-container, #canvas, or #landing-page).');
        }

        await ensureAuthPersistence();
        try {
            await getRedirectResult(auth);
        } catch (err) {
            const c = err && err.code;
            if (c && c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
                console.warn('[MyMotif] getRedirectResult:', c, err.message || err);
            }
        }
        if (typeof auth.authStateReady === 'function') {
            await auth.authStateReady();
        }

        let cloudSaveTimer = null;

        async function persistFrameEntriesToCloud() {
            if (!auth.currentUser) return;
            const uid = auth.currentUser.uid;
            const frames = canvas.querySelectorAll('.motif-frame');
            for (const fr of frames) {
                const fid = fr.id;
                if (!fid) continue;
                const ta = fr.querySelector('.journal-entry-textarea');
                const entry = ta ? ta.value.trim() : '';
                await setDoc(frameEntryDoc(uid, fid), { entry, updatedAt: new Date() }, { merge: true });
            }
        }

        async function persistBoardToCloud({ silent = false } = {}) {
            if (!auth.currentUser) return;
            document.querySelectorAll('#canvas input').forEach((inp) => inp.setAttribute('value', inp.value));
            stashJournalSnapshotsBeforeHistory();
            let ghostHtml = '';
            const ghost = document.getElementById('ghost-frame');
            if (ghost && ghost.parentNode === canvas) {
                canvas.removeChild(ghost);
                ghostHtml = ghost.outerHTML;
            }
            try {
                await setDoc(
                    workspaceDoc(auth.currentUser.uid),
                    {
                        canvasHTML: canvas.innerHTML,
                        updatedAt: new Date()
                    },
                    { merge: true }
                );
                await persistFrameEntriesToCloud();
            } finally {
                if (ghostHtml) canvas.innerHTML = ghostHtml + canvas.innerHTML;
                restoreJournalSnapshotsAfterInnerHtml();
            }
        }

        async function hydrateFrameEntriesFromFirestore(uid) {
            try {
                const snap = await getDocs(framesCollection(uid));
                snap.forEach((d) => {
                    const fr = document.getElementById(d.id);
                    const ta = fr && fr.querySelector('.journal-entry-textarea');
                    if (ta && typeof d.data().entry === 'string') ta.value = d.data().entry;
                });
            } catch (e) {
                console.warn('MyMotif: could not load frame entries:', e && (e.code || e.message));
            }
        }

        async function loadWorkspaceForUser(uid) {
            let snap = await getDoc(workspaceDoc(uid));
            let exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
            let data = snap.data();
            if (!exists || !data?.canvasHTML) {
                try {
                    const legacy = await getDoc(doc(db, 'boards', uid));
                    const legEx = typeof legacy.exists === 'function' ? legacy.exists() : legacy.exists;
                    const legData = legacy.data();
                    if (legEx && legData?.canvasHTML) {
                        await setDoc(
                            workspaceDoc(uid),
                            { canvasHTML: legData.canvasHTML, updatedAt: new Date(), migratedFromLegacyBoardsDoc: true },
                            { merge: true }
                        );
                        snap = await getDoc(workspaceDoc(uid));
                        exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
                        data = snap.data();
                    }
                } catch {
                    /* legacy path may be denied by new rules */
                }
            }
            if (exists && data && data.canvasHTML) {
                const temp = document.createElement('div');
                temp.innerHTML = data.canvasHTML;
                const ghost = document.getElementById('ghost-frame');
                if (ghost) temp.prepend(ghost);
                canvas.innerHTML = temp.innerHTML;
                document.querySelectorAll('#canvas input').forEach((inp) => {
                    if (inp.hasAttribute('value')) inp.value = inp.getAttribute('value');
                });
                restoreJournalSnapshotsAfterInnerHtml();
                await hydrateFrameEntriesFromFirestore(uid);
                wireAllJournalFrames();
            }
        }

        function scheduleCloudSave() {
            if (!auth.currentUser) return;
            if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
            cloudSaveTimer = setTimeout(() => {
                cloudSaveTimer = null;
                persistBoardToCloud({ silent: true }).catch((err) => console.warn('Auto-save:', err));
            }, 2800);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && auth.currentUser) {
                if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
                persistBoardToCloud({ silent: true }).catch(() => {});
            }
        });

        onAuthStateChanged(auth, async (user) => {
            console.log('Auth State Changed:', user ? 'Logged In' : 'Logged Out');
            if (user) {
                landingPage.classList.add('hidden');
                landingPage.style.display = 'none';
                if (userIconBtn) {
                    const av = user.photoURL;
                    userIconBtn.innerHTML = av
                        ? `<img src="${av}" alt="" referrerpolicy="no-referrer" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">`
                        : `<i class="fa-solid fa-user-check" style="font-size:16px;"></i>`;
                    userIconBtn.title = `Logged in as ${user.displayName || user.email || 'Google'} (click to sign out)`;
                }
                if (saveCloudBtn) saveCloudBtn.style.display = 'block';
                try {
                    await setDoc(
                        workspaceDoc(user.uid),
                        {
                            userProfile: {
                                displayName: user.displayName || null,
                                email: user.email || null,
                                photoURL: user.photoURL || null,
                                lastLoginAt: new Date().toISOString()
                            },
                            updatedAt: new Date()
                        },
                        { merge: true }
                    );
                    await loadWorkspaceForUser(user.uid);
                } catch (e) {
                    console.error('Load Error:', e);
                }
            } else {
                landingPage.classList.remove('hidden');
                landingPage.style.display = 'flex';
                if (userIconBtn) {
                    userIconBtn.innerHTML = `<i class="fa-solid fa-user"></i>`;
                    userIconBtn.title = 'Log in';
                }
                if (saveCloudBtn) saveCloudBtn.style.display = 'none';
            }
        });

        let isSigningIn = false;
        async function doGoogleSignIn(e) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (isSigningIn) return;
            isSigningIn = true;
            try {
                await ensureAuthPersistence();
                const result = await signInWithPopup(auth, provider);
                if (result.user) {
                    landingPage.classList.add('hidden');
                    landingPage.style.display = 'none';
                }
            } catch (error) {
                const code = error && error.code;
                if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
                    try {
                        await ensureAuthPersistence();
                        await signInWithRedirect(auth, provider);
                    } catch (e2) {
                        alert('Login Error: ' + (e2.code || e2.message));
                    }
                } else {
                    alert('Login Error: ' + (code || error.message));
                }
            } finally {
                isSigningIn = false;
            }
        }

        if (signupBtn) signupBtn.addEventListener('click', doGoogleSignIn);
        if (loginBtn) loginBtn.addEventListener('click', doGoogleSignIn);
        if (userIconBtn) {
            userIconBtn.addEventListener('click', async (e) => {
                if (auth.currentUser) {
                    if (!confirm('Sign out? Your board will be saved to the cloud first.')) return;
                    try {
                        await persistBoardToCloud({ silent: true });
                    } catch (err) {
                        console.warn('Save before sign-out:', err);
                    }
                    await signOut(auth);
                    location.reload();
                } else {
                    doGoogleSignIn(e);
                }
            });
        }

        const winGeminiOverride =
            typeof window !== 'undefined' &&
            typeof window.MYMOTIF_GEMINI_API_KEY === 'string' &&
            window.MYMOTIF_GEMINI_API_KEY.trim();
        const GEMINI_API_KEY = winGeminiOverride || MYMOTIF_DEFAULT_GEMINI_API_KEY;
        const GEMINI_GENERATE_CONTENT_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

        const GEMINI_FETCH_TIMEOUT_MS = 75000;

        function geminiCandidateHasText(data) {
            const parts = data?.candidates?.[0]?.content?.parts;
            if (!Array.isArray(parts)) return false;
            return parts.some((p) => typeof p.text === 'string' && p.text.trim().length > 0);
        }

        async function geminiGenerateContent(requestBody) {
            let lastMessage = '';
            const maxAttempts = 4;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
                let response;
                try {
                    response = await fetch(GEMINI_GENERATE_CONTENT_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                        signal: controller.signal
                    });
                } catch (e) {
                    clearTimeout(timer);
                    lastMessage = e && e.name === 'AbortError' ? 'Request timed out.' : String(e.message || e);
                    break;
                }
                clearTimeout(timer);
                const data = await response.json().catch(() => ({}));
                if (data.promptFeedback?.blockReason) {
                    lastMessage = `Prompt blocked: ${data.promptFeedback.blockReason}`;
                    break;
                }
                const c0 = data.candidates?.[0];
                if (response.ok && c0 && geminiCandidateHasText(data)) return data;
                lastMessage = data.error?.message || `HTTP ${response.status}`;
                const is429 =
                    response.status === 429 ||
                    data.error?.status === 'RESOURCE_EXHAUSTED' ||
                    /quota|exceeded|Resource exhausted/i.test(lastMessage);
                if (is429 && attempt < maxAttempts - 1) {
                    await new Promise((r) => setTimeout(r, 12000));
                    continue;
                }
                break;
            }
            throw new Error(lastMessage || 'Gemini request failed.');
        }

        function escapeHtml(s) {
            if (s == null) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        /** --- Vibe panel (slide-in from right) --- */
        const vibeOverlay = document.createElement('div');
        vibeOverlay.id = 'vibe-panel-overlay';
        vibeOverlay.className = 'vibe-panel-overlay hidden';
        vibeOverlay.innerHTML = `
            <div class="vibe-panel-backdrop" data-vibe-close="1"></div>
            <aside class="vibe-panel-drawer" role="dialog" aria-modal="true" aria-label="Vibe finder">
                <div class="vibe-panel-header">
                    <h2 class="vibe-panel-title">Find your vibe</h2>
                    <button type="button" class="vibe-panel-close icon-btn" title="Close" data-vibe-close="1"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="vibe-panel-body" id="vibe-panel-stage"></div>
                <p class="vibe-panel-footer-note">Art lives everywhere. These are starting points.</p>
            </aside>`;
        document.body.appendChild(vibeOverlay);

        const vibeStage = vibeOverlay.querySelector('#vibe-panel-stage');
        vibeOverlay.addEventListener('click', (e) => {
            if (e.target.closest('[data-vibe-close="1"]')) closeVibePanel();
        });

        const vibeState = {
            frame: null,
            entry: '',
            primaryEmotion: '',
            questions: [],
            selected: [],
            rec: null,
            historyArtist: [],
            historyArt: [],
            historySearch: []
        };

        function openVibePanel() {
            vibeOverlay.classList.remove('hidden');
        }

        function closeVibePanel() {
            vibeOverlay.classList.add('hidden');
            vibeStage.innerHTML = '';
        }

        function setVibeStage(html) {
            vibeStage.innerHTML = html;
        }

        async function runGeminiStep1Questions(entryText) {
            const userPrompt = `Read this journal entry and identify the primary emotion. Then generate exactly 3 follow-up questions to sharpen your understanding of the emotional and aesthetic vibe. Questions should feel visceral and instinctive, not clinical — like a friend asking, not a therapist.
Each question has exactly 3 short answer options.

Return ONLY this JSON, nothing else:
{
  "primaryEmotion": string,
  "questions": [
    { "question": string, "options": [string, string, string] }
  ]
}

Journal entry: ${entryText}`;

            const body = {
                systemInstruction: { parts: [{ text: buildCuratorSystemPrompt() }] },
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: {
                    temperature: 0.9,
                    maxOutputTokens: 2048,
                    responseMimeType: 'application/json'
                }
            };
            const data = await geminiGenerateContent(body);
            const parsed = parseGeminiJsonFromResponse(data);
            return parsed;
        }

        function normalizeRecommendationUrls(rec) {
            if (!rec || typeof rec !== 'object') return rec;
            if (rec.artist && rec.artist.name && !String(rec.artist.searchUrl || '').includes('spotify')) {
                rec.artist.searchUrl = `https://open.spotify.com/search/${encodeURIComponent(rec.artist.name)}`;
            }
            if (rec.searchQuery && rec.searchQuery.text && !String(rec.searchQuery.url || '').includes('google')) {
                rec.searchQuery.url = `https://www.google.com/search?q=${encodeURIComponent(rec.searchQuery.text)}`;
            }
            return rec;
        }

        async function runGeminiStep2Recommendations(entryText, emotion, vibeAnswersText) {
            const userPrompt = `Based on this journal entry, identified emotion, and vibe answers, give exactly ONE of each. Route using the emotional scene map.

ARTIST: One specific artist or song from your taste universe that matches the emotional register of this entry. Explain in 2 sentences why THIS specific emotional world fits. Include artist name and a specific song.

ART: One piece of art from ANYWHERE — a famous painting, a YouTube video, an interactive website, a SoundCloud track, a film scene, a mural, a creative director's portfolio, a music video, a documentary short. Prioritize obscure and hard-to-find. Name the SPECIFIC work. Explain in 2 sentences why this emotional world matches.

SEARCH: One specific search query to find more like this.

Return ONLY this JSON, nothing else:
{
  "artist": {
    "name": string,
    "song": string | null,
    "reason": string,
    "searchUrl": string
  },
  "art": {
    "name": string,
    "type": string,
    "reason": string,
    "findUrl": string
  },
  "searchQuery": {
    "text": string,
    "url": string
  }
}

For searchUrl: https://open.spotify.com/search/[encoded artist name]
For findUrl: most specific URL possible — direct link, YouTube search, or Google search as last resort
For searchQuery url: https://www.google.com/search?q=[encoded query]

Journal entry: ${entryText}
Identified emotion: ${emotion}
Vibe answers: ${vibeAnswersText}`;

            const body = {
                systemInstruction: { parts: [{ text: buildCuratorSystemPrompt() }] },
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: {
                    temperature: 0.85,
                    maxOutputTokens: 3072,
                    responseMimeType: 'application/json'
                }
            };
            const data = await geminiGenerateContent(body);
            return normalizeRecommendationUrls(parseGeminiJsonFromResponse(data));
        }

        async function runGeminiReshuffle(kind, avoidName) {
            const entryText = vibeState.entry;
            const emotion = vibeState.primaryEmotion;
            const vibeAnswersText = JSON.stringify(vibeState.selected);
            const slot = kind === 'artist' ? 'artist / song' : kind === 'art' ? 'art piece' : 'search query';
            const currentJson = JSON.stringify(vibeState.rec);
            const userPrompt = `Give a completely different ${slot} recommendation. Do not repeat this name/title: "${avoidName}". Use the same emotional routing.

Journal entry: ${entryText}
Emotion: ${emotion}
Vibe answers: ${vibeAnswersText}

CURRENT full JSON (replace ONLY the "${kind}" branch; the other two branches must stay identical):
${currentJson}

Return ONLY valid JSON with keys "artist", "art", "searchQuery" (same shape as CURRENT).`;

            const body = {
                systemInstruction: { parts: [{ text: buildCuratorSystemPrompt() }] },
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: {
                    temperature: 0.95,
                    maxOutputTokens: 3072,
                    responseMimeType: 'application/json'
                }
            };
            const data = await geminiGenerateContent(body);
            const parsed = normalizeRecommendationUrls(parseGeminiJsonFromResponse(data));
            if (parsed && typeof parsed === 'object') {
                vibeState.rec = {
                    artist: parsed.artist || vibeState.rec.artist,
                    art: parsed.art || vibeState.rec.art,
                    searchQuery: parsed.searchQuery || vibeState.rec.searchQuery
                };
            }
        }

        function renderQuestionsStep() {
            const em = escapeHtml(vibeState.primaryEmotion || '');
            let qHtml = '';
            (vibeState.questions || []).forEach((q, qi) => {
                const opts = (q.options || []).slice(0, 3);
                const optBtns = opts
                    .map(
                        (o, oi) =>
                            `<button type="button" class="vibe-option-btn" data-qix="${qi}" data-oix="${oi}">${escapeHtml(o)}</button>`
                    )
                    .join('');
                qHtml += `<div class="vibe-q-block"><p class="vibe-q-text">${escapeHtml(q.question || '')}</p><div class="vibe-option-row">${optBtns}</div></div>`;
            });
            setVibeStage(`
                <p class="vibe-emotion-label"><em>${em}</em></p>
                ${qHtml}
                <p class="vibe-error hidden" id="vibe-step1-err"></p>
                <button type="button" class="primary-btn vibe-continue-btn" id="vibe-continue-btn">Continue</button>`);

            vibeStage.querySelectorAll('.vibe-option-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const qi = parseInt(btn.getAttribute('data-qix'), 10);
                    const oi = parseInt(btn.getAttribute('data-oix'), 10);
                    if (!vibeState.selected) vibeState.selected = [];
                    vibeState.selected[qi] = (vibeState.questions[qi].options || [])[oi] || '';
                    btn.parentElement.querySelectorAll('.vibe-option-btn').forEach((b) => b.classList.remove('selected'));
                    btn.classList.add('selected');
                });
            });

            document.getElementById('vibe-continue-btn').addEventListener('click', async () => {
                const errEl = document.getElementById('vibe-step1-err');
                const nq = (vibeState.questions || []).length;
                if (nq < 2 || vibeState.selected.filter(Boolean).length < nq) {
                    errEl.textContent = 'Pick one answer for each question.';
                    errEl.classList.remove('hidden');
                    return;
                }
                errEl.classList.add('hidden');
                const btn = document.getElementById('vibe-continue-btn');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Finding recommendations…';
                try {
                    const rec = await runGeminiStep2Recommendations(
                        vibeState.entry,
                        vibeState.primaryEmotion,
                        JSON.stringify(vibeState.selected)
                    );
                    vibeState.rec = rec;
                    vibeState.historyArtist = [String(rec?.artist?.name || '')];
                    vibeState.historyArt = [String(rec?.art?.name || '')];
                    vibeState.historySearch = [String(rec?.searchQuery?.text || '')];
                    renderResultsStep();
                } catch (e) {
                    errEl.textContent = e.message || String(e);
                    errEl.classList.remove('hidden');
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Continue';
                }
            });
        }

        function cardSpinner() {
            return '<div class="vibe-card-spinner"><i class="fa-solid fa-spinner fa-spin"></i></div>';
        }

        function renderResultsStep() {
            const r = vibeState.rec || {};
            const a = r.artist || {};
            const art = r.art || {};
            const sq = r.searchQuery || {};
            setVibeStage(`
                <div class="vibe-results-stack">
                    <div class="vibe-rec-card" data-card="artist">
                        <button type="button" class="vibe-reshuffle" data-reshuffle="artist" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-artist-inner">
                            <p class="vibe-card-kicker">Artist</p>
                            <p class="vibe-card-title">${escapeHtml(a.name || '—')}${a.song ? ` — <span class="vibe-song">${escapeHtml(a.song)}</span>` : ''}</p>
                            <p class="vibe-card-body">${escapeHtml(a.reason || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="listen">Listen</button>
                        </div>
                    </div>
                    <div class="vibe-rec-card" data-card="art">
                        <button type="button" class="vibe-reshuffle" data-reshuffle="art" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-art-inner">
                            <p class="vibe-card-kicker">Art <span class="vibe-type-tag">${escapeHtml(art.type || '')}</span></p>
                            <p class="vibe-card-title">${escapeHtml(art.name || '—')}</p>
                            <p class="vibe-card-body">${escapeHtml(art.reason || '')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="art">Find it</button>
                        </div>
                    </div>
                    <div class="vibe-rec-card" data-card="search">
                        <button type="button" class="vibe-reshuffle" data-reshuffle="search" title="Reshuffle">🔀</button>
                        <div class="vibe-card-inner" id="vibe-card-search-inner">
                            <p class="vibe-card-kicker">Search</p>
                            <p class="vibe-card-title vibe-search-query">${escapeHtml(sq.text || '—')}</p>
                            <button type="button" class="secondary-btn vibe-open-btn" data-vibe-link="search">Go deeper</button>
                        </div>
                    </div>
                </div>
                <p class="vibe-error hidden" id="vibe-step2-err"></p>`);

            const listenUrl = (vibeState.rec && vibeState.rec.artist && vibeState.rec.artist.searchUrl) || '';
            const artUrl = (vibeState.rec && vibeState.rec.art && vibeState.rec.art.findUrl) || '';
            const searchUrl = (vibeState.rec && vibeState.rec.searchQuery && vibeState.rec.searchQuery.url) || '';

            vibeStage.querySelector('[data-vibe-link="listen"]')?.addEventListener('click', () => {
                if (listenUrl) window.open(listenUrl, '_blank', 'noopener,noreferrer');
            });
            vibeStage.querySelector('[data-vibe-link="art"]')?.addEventListener('click', () => {
                if (artUrl) window.open(artUrl, '_blank', 'noopener,noreferrer');
            });
            vibeStage.querySelector('[data-vibe-link="search"]')?.addEventListener('click', () => {
                if (searchUrl) window.open(searchUrl, '_blank', 'noopener,noreferrer');
            });

            vibeStage.querySelectorAll('.vibe-reshuffle').forEach((b) => {
                b.addEventListener('click', async () => {
                    const kind = b.getAttribute('data-reshuffle');
                    const card = b.closest('.vibe-rec-card');
                    const inner = card.querySelector('.vibe-card-inner');
                    const prevName =
                        kind === 'artist'
                            ? String(vibeState.rec?.artist?.name || '')
                            : kind === 'art'
                              ? String(vibeState.rec?.art?.name || '')
                              : String(vibeState.rec?.searchQuery?.text || '');
                    inner.innerHTML = cardSpinner();
                    const errEl = document.getElementById('vibe-step2-err');
                    if (errEl) errEl.classList.add('hidden');
                    try {
                        await runGeminiReshuffle(kind, prevName);
                        const nextName =
                            kind === 'artist'
                                ? String(vibeState.rec?.artist?.name || '')
                                : kind === 'art'
                                  ? String(vibeState.rec?.art?.name || '')
                                  : String(vibeState.rec?.searchQuery?.text || '');
                        const hist = kind === 'artist' ? vibeState.historyArtist : kind === 'art' ? vibeState.historyArt : vibeState.historySearch;
                        if (hist.includes(nextName) || nextName === prevName) {
                            if (errEl) {
                                errEl.textContent = 'Got a duplicate suggestion — try reshuffle again.';
                                errEl.classList.remove('hidden');
                            }
                        } else {
                            if (kind === 'artist') vibeState.historyArtist.push(nextName);
                            else if (kind === 'art') vibeState.historyArt.push(nextName);
                            else vibeState.historySearch.push(nextName);
                        }
                        renderResultsStep();
                    } catch (e) {
                        if (errEl) {
                            errEl.textContent = e.message || String(e);
                            errEl.classList.remove('hidden');
                        }
                        renderResultsStep();
                    }
                });
            });
        }

        async function startFindMyVibe(frameEl) {
            if (!auth.currentUser) {
                alert('Sign in to save your journal and run vibe finder.');
                return;
            }
            const ta = frameEl.querySelector('.journal-entry-textarea');
            const entry = (ta && ta.value.trim()) || '';
            if (!entry) {
                alert('Write something in your journal first.');
                return;
            }
            vibeState.frame = frameEl;
            vibeState.entry = entry.slice(0, 500);
            vibeState.selected = [];
            vibeState.rec = null;
            vibeState.historyArtist = [];
            vibeState.historyArt = [];
            vibeState.historySearch = [];
            openVibePanel();
            setVibeStage('<div class="vibe-loading"><i class="fa-solid fa-spinner fa-spin"></i><p>Reading your entry…</p></div>');
            try {
                const step1 = await runGeminiStep1Questions(vibeState.entry);
                vibeState.primaryEmotion = step1.primaryEmotion || '';
                vibeState.questions = Array.isArray(step1.questions) ? step1.questions.slice(0, 3) : [];
                if (vibeState.questions.length < 2) throw new Error('Model returned too few questions. Try again.');
                renderQuestionsStep();
            } catch (e) {
                setVibeStage(
                    `<div class="vibe-error-panel"><p>${escapeHtml(e.message || String(e))}</p><button type="button" class="primary-btn" id="vibe-retry">Try again</button></div>`
                );
                document.getElementById('vibe-retry').addEventListener('click', () => startFindMyVibe(frameEl));
            }
        }

        function bindJournalFrame(frameEl) {
            const ta = frameEl.querySelector('.journal-entry-textarea');
            const cnt = frameEl.querySelector('.journal-char-count');
            const btn = frameEl.querySelector('.find-vibe-btn');
            if (!ta || !cnt || !btn) return;
            const syncCount = () => {
                const n = ta.value.length;
                cnt.textContent = n + ' / 500';
                if (n > 500) ta.value = ta.value.slice(0, 500);
            };
            ta.addEventListener('input', () => {
                syncCount();
                scheduleCloudSave();
            });
            syncCount();
            btn.addEventListener('click', () => void startFindMyVibe(frameEl));
        }

        function wireAllJournalFrames() {
            canvas.querySelectorAll('.motif-frame').forEach(bindJournalFrame);
        }

        let currentTool = 'select';
        let scale = 1;
        let panX = window.innerWidth / 2;
        let panY = window.innerHeight / 2;

        function updateCanvasTransform() {
            canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        }
        updateCanvasTransform();

        const toolBtns = document.querySelectorAll('.tool-btn');
        toolBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                toolBtns.forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                currentTool = btn.dataset.tool;
                if (currentTool === 'frame' || currentTool === 'board') boardContainer.style.cursor = 'crosshair';
                else if (currentTool === 'pan') boardContainer.style.cursor = 'grab';
                else boardContainer.style.cursor = 'default';
            });
        });

        function setTool(toolName) {
            toolBtns.forEach((btn) => {
                if (btn.dataset.tool === toolName) btn.click();
            });
        }

        boardContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey || e.deltaY % 1 !== 0) {
                const zoomSensitivity = 0.005;
                const delta = -e.deltaY * zoomSensitivity;
                const newScale = Math.min(Math.max(0.1, scale + delta), 5);
                const mouseX = e.clientX;
                const mouseY = e.clientY;
                panX = mouseX - (mouseX - panX) * (newScale / scale);
                panY = mouseY - (mouseY - panY) * (newScale / scale);
                scale = newScale;
            } else {
                panX -= e.deltaX;
                panY -= e.deltaY;
            }
            updateCanvasTransform();
        }, { passive: false });

        const historyStack = [];
        const getGhostFrame = () => document.getElementById('ghost-frame');

        function saveStateSafe() {
            stashJournalSnapshotsBeforeHistory();
            const ghost = getGhostFrame();
            document.querySelectorAll('#canvas input').forEach((inp) => inp.setAttribute('value', inp.value));
            if (ghost && ghost.parentNode === canvas) canvas.removeChild(ghost);
            historyStack.push(canvas.innerHTML);
            if (historyStack.length > 30) historyStack.shift();
            if (ghost) canvas.prepend(ghost);
            restoreJournalSnapshotsAfterInnerHtml();
            scheduleCloudSave();
        }

        function undoSafe() {
            const ghost = getGhostFrame();
            if (historyStack.length > 0) {
                if (ghost && ghost.parentNode === canvas) canvas.removeChild(ghost);
                canvas.innerHTML = historyStack.pop();
                if (ghost) canvas.prepend(ghost);
                deselectAll();
                restoreJournalSnapshotsAfterInnerHtml();
                wireAllJournalFrames();
            }
            scheduleCloudSave();
        }

        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                undoSafe();
                return;
            }
            if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                if (e.key.toLowerCase() === 'v') setTool('select');
                if (e.key.toLowerCase() === 'b') setTool('board');
                if (e.key.toLowerCase() === 'f') setTool('frame');
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
                const selectedElements = document.querySelectorAll('.selected');
                if (selectedElements.length > 0) {
                    saveStateSafe();
                    selectedElements.forEach((el) => el.remove());
                }
            }
        });

        boardContainer.addEventListener('input', (e) => {
            if (e.target.tagName === 'INPUT') e.target.setAttribute('value', e.target.value);
            if (e.target.classList.contains('journal-entry-textarea')) {
                const fr = e.target.closest('.motif-frame');
                if (fr) fr.setAttribute('data-journal-snapshot', encodeURIComponent(e.target.value));
            }
        });

        let isPanning = false;
        let isDrawing = false;
        let dragType = null;
        let draggingElement = null;
        let dragStartX, dragStartY;
        let initialLeft, initialTop, initialWidth, initialHeight;
        let stateSavedForDrag = false;
        let containedElementsToMove = [];
        let lastMousedownTime = 0;

        boardContainer.addEventListener('mousedown', (e) => {
            if (e.target.closest('.top-toolbar')) return;
            if (e.target.closest('#vibe-panel-overlay')) return;

            const rect = canvas.getBoundingClientRect();
            const pointerX = (e.clientX - rect.left) / scale;
            const pointerY = (e.clientY - rect.top) / scale;
            const now = Date.now();
            const isDoubleClick = now - lastMousedownTime < 300;
            lastMousedownTime = now;
            const individualDragHandle = e.target.closest('.individual-drag-handle');
            let executeIndividualMove = (currentTool === 'pan' && isDoubleClick) || !!individualDragHandle;

            if ((currentTool === 'pan' && !isDoubleClick) || e.button === 1 || e.code === 'Space') {
                isPanning = true;
                dragStartX = e.clientX - panX;
                dragStartY = e.clientY - panY;
                boardContainer.style.cursor = 'grabbing';
                return;
            }

            if (currentTool === 'frame' || currentTool === 'board') {
                isDrawing = true;
                dragStartX = pointerX;
                dragStartY = pointerY;
                const ghost = getGhostFrame();
                ghost.style.display = 'block';
                ghost.style.left = dragStartX + 'px';
                ghost.style.top = dragStartY + 'px';
                ghost.style.width = '0px';
                ghost.style.height = '0px';
                if (currentTool === 'board') {
                    ghost.style.borderStyle = 'dashed';
                    ghost.style.background = 'rgba(243, 244, 246, 0.4)';
                } else {
                    ghost.style.borderStyle = 'solid';
                    ghost.style.background = 'rgba(107, 92, 231, 0.1)';
                }
                deselectAll();
                return;
            }

            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                const parentEl = deleteBtn.closest('.motif-frame, .motif-board');
                if (parentEl) {
                    saveStateSafe();
                    parentEl.remove();
                }
                return;
            }

            const frameResizeHandle = e.target.closest('.frame-resize-handle');
            const frameHeader = e.target.closest('.frame-header');
            const frameBody = e.target.closest('.frame-body');
            const frame = e.target.closest('.motif-frame');
            const boardResizeHandle = e.target.closest('.board-resize-handle');
            const boardHeader = e.target.closest('.board-header');
            const board = e.target.closest('.motif-board');

            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.closest('.journal-entry-textarea')) {
                if (frame) selectElement(frame, 'frame');
                if (board) selectElement(board, 'board');
                return;
            }

            if (individualDragHandle) {
                const parentElement = individualDragHandle.closest('.motif-frame, .motif-board');
                if (parentElement) {
                    startDrag(e, parentElement, 'move', pointerX, pointerY, true);
                    selectElement(parentElement, parentElement.classList.contains('motif-frame') ? 'frame' : 'board');
                }
            } else if (frameResizeHandle) {
                startDrag(e, frame, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (frameHeader) {
                startDrag(e, frame, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(frame, 'frame');
            } else if (frameBody && frame) {
                selectElement(frame, 'frame');
            } else if (frame) {
                selectElement(frame, 'frame');
            } else if (boardResizeHandle) {
                startDrag(e, board, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (boardHeader) {
                startDrag(e, board, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(board, 'board');
            } else if (board && !e.target.closest('.motif-frame')) {
                startDrag(e, board, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(board, 'board');
            } else deselectAll();
        });

        function getContainedNodes(boardEl) {
            const contained = [];
            const bx = parseFloat(boardEl.style.left);
            const by = parseFloat(boardEl.style.top);
            const bw = parseFloat(boardEl.style.width);
            const bh = parseFloat(boardEl.style.height);
            document.querySelectorAll('.motif-frame').forEach((node) => {
                const nx = parseFloat(node.style.left);
                const ny = parseFloat(node.style.top);
                const nw = parseFloat(node.style.width) || node.offsetWidth;
                const nh = parseFloat(node.style.height) || node.offsetHeight;
                const cx = nx + nw / 2;
                const cy = ny + nh / 2;
                if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) contained.push(node);
            });
            return contained;
        }

        function startDrag(e, element, type, px, py, isDoubleClickDrag = false) {
            draggingElement = element;
            dragType = type;
            dragStartX = px;
            dragStartY = py;
            stateSavedForDrag = false;
            initialLeft = parseFloat(element.style.left) || 0;
            initialTop = parseFloat(element.style.top) || 0;
            initialWidth = parseFloat(element.style.width) || element.offsetWidth;
            initialHeight = parseFloat(element.style.height) || element.offsetHeight;
            containedElementsToMove = [];
            if (type === 'move' && !isDoubleClickDrag) {
                let boardContext = null;
                if (element.classList.contains('motif-board')) boardContext = element;
                else if (element.classList.contains('motif-frame')) {
                    const cx = initialLeft + initialWidth / 2;
                    const cy = initialTop + initialHeight / 2;
                    document.querySelectorAll('.motif-board').forEach((b) => {
                        const bx = parseFloat(b.style.left);
                        const by = parseFloat(b.style.top);
                        const bw = parseFloat(b.style.width) || b.offsetWidth;
                        const bh = parseFloat(b.style.height) || b.offsetHeight;
                        if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) boardContext = b;
                    });
                }
                if (boardContext) {
                    draggingElement = boardContext;
                    initialLeft = parseFloat(boardContext.style.left) || 0;
                    initialTop = parseFloat(boardContext.style.top) || 0;
                    initialWidth = parseFloat(boardContext.style.width) || boardContext.offsetWidth;
                    initialHeight = parseFloat(boardContext.style.height) || boardContext.offsetHeight;
                    containedElementsToMove = getContainedNodes(boardContext).map((el) => ({
                        el,
                        left: parseFloat(el.style.left),
                        top: parseFloat(el.style.top)
                    }));
                    selectElement(boardContext, 'board');
                }
            }
            e.stopPropagation();
        }

        window.addEventListener('mousemove', (e) => {
            if (isPanning) {
                panX = e.clientX - dragStartX;
                panY = e.clientY - dragStartY;
                updateCanvasTransform();
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const pointerX = (e.clientX - rect.left) / scale;
            const pointerY = (e.clientY - rect.top) / scale;
            if (isDrawing) {
                const ghost = getGhostFrame();
                const width = Math.abs(pointerX - dragStartX);
                const height = Math.abs(pointerY - dragStartY);
                const left = Math.min(pointerX, dragStartX);
                const top = Math.min(pointerY, dragStartY);
                ghost.style.left = left + 'px';
                ghost.style.top = top + 'px';
                ghost.style.width = width + 'px';
                ghost.style.height = height + 'px';
                return;
            }
            if (draggingElement && dragType) {
                const dx = pointerX - dragStartX;
                const dy = pointerY - dragStartY;
                if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                    if (!stateSavedForDrag) {
                        saveStateSafe();
                        stateSavedForDrag = true;
                    }
                }
                if (dragType === 'move') {
                    draggingElement.style.left = initialLeft + dx + 'px';
                    draggingElement.style.top = initialTop + dy + 'px';
                    containedElementsToMove.forEach((item) => {
                        item.el.style.left = item.left + dx + 'px';
                        item.el.style.top = item.top + dy + 'px';
                    });
                } else if (dragType === 'resize') {
                    draggingElement.style.width = Math.max(50, initialWidth + dx) + 'px';
                    draggingElement.style.height = Math.max(50, initialHeight + dy) + 'px';
                }
            }
        });

        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                boardContainer.style.cursor = currentTool === 'pan' ? 'grab' : 'default';
            }
            if (isDrawing) {
                isDrawing = false;
                const ghost = getGhostFrame();
                ghost.style.display = 'none';
                const width = parseFloat(ghost.style.width);
                const height = parseFloat(ghost.style.height);
                const left = parseFloat(ghost.style.left);
                const top = parseFloat(ghost.style.top);
                if (width > 50 && height > 50) {
                    saveStateSafe();
                    if (currentTool === 'board') createBoardAt(left, top, width, height);
                    else if (currentTool === 'frame') createFrameAt(left, top, width, height);
                }
                setTool('select');
            }
            draggingElement = null;
            dragType = null;
            containedElementsToMove = [];
        });

        function createBoardAt(x, y, w, h) {
            const boardId = 'board-' + Date.now();
            const board = document.createElement('div');
            board.className = 'motif-board';
            board.id = boardId;
            board.style.left = x + 'px';
            board.style.top = y + 'px';
            board.style.width = w + 'px';
            board.style.height = h + 'px';
            board.style.zIndex = '0';
            board.innerHTML = `
            <div class="board-header">
                <input type="text" class="board-title" value="New Board">
                <button type="button" class="delete-btn"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="board-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>`;
            canvas.appendChild(board);
            selectElement(board, 'board');
            scheduleCloudSave();
        }

        function createFrameAt(x, y, w, h) {
            const frameId = 'frame-' + Date.now();
            const frame = document.createElement('div');
            frame.className = 'motif-frame';
            frame.id = frameId;
            frame.style.left = x + 'px';
            frame.style.top = y + 'px';
            frame.style.width = w + 'px';
            frame.style.height = h + 'px';
            frame.style.zIndex = '1';
            frame.innerHTML = `
            <div class="frame-header">
                <input type="text" class="frame-title" placeholder="Frame" value="New journal">
                <button type="button" class="delete-btn" title="Delete frame"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="frame-body journal-frame-body">
                <textarea class="journal-entry-textarea" maxlength="500" rows="6" placeholder="What's on your mind?"></textarea>
                <div class="journal-toolbar">
                    <span class="journal-char-count">0 / 500</span>
                    <button type="button" class="primary-btn find-vibe-btn">Find My Vibe</button>
                </div>
            </div>
            <div class="frame-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>`;
            canvas.appendChild(frame);
            bindJournalFrame(frame);
            selectElement(frame, 'frame');
            scheduleCloudSave();
        }

        function selectElement(el, type) {
            deselectAll();
            el.classList.add('selected');
            if (type === 'frame') el.style.zIndex = '10';
            else if (type === 'board') el.style.zIndex = '0';
        }

        function deselectAll() {
            document.querySelectorAll('.motif-frame').forEach((f) => {
                f.classList.remove('selected');
                f.style.zIndex = '1';
            });
            document.querySelectorAll('.motif-board').forEach((b) => {
                b.classList.remove('selected');
                b.style.zIndex = '0';
            });
        }

        if (saveCloudBtn) {
            saveCloudBtn.addEventListener('click', async () => {
                if (!auth.currentUser) return;
                saveCloudBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    await persistBoardToCloud({ silent: false });
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10B981;"></i>';
                    setTimeout(() => {
                        saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                    }, 2000);
                } catch (error) {
                    console.error('Save error:', error);
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #EF4444;"></i>';
                    setTimeout(() => {
                        saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                    }, 2000);
                    alert('Failed to save. Check Firestore rules for users/{yourUid}/**');
                }
            });
        }

        wireAllJournalFrames();

        console.log('My Motif: journal app ready.');
    } catch (e) {
        alert('Fatal error during app boot: ' + (e.message || String(e)));
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initApp());
} else {
    void initApp();
}
