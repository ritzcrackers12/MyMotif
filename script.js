import {
    auth,
    db,
    storage,
    ref,
    uploadBytes,
    getBytes,
    getMetadata,
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
    getDoc
} from './firebase.js';

/** Default Gemini key for this app (public in client; restrict in Google Cloud via HTTP referrers). */
const MYMOTIF_DEFAULT_GEMINI_API_KEY = 'AIzaSyBIO_RbPR64ltwkTMlVovWXruem8wAsEe0';

/** Private / strict browsers often reject IndexedDB "local" persistence; fall back so sign-in still sticks for the tab. */
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

const initApp = async () => {
    try {
        console.log("My Motif: Starting Robust Boot...");
        const boardContainer = document.getElementById('board-container');
        const canvas = document.getElementById('canvas');
        const ghostFrame = document.getElementById('ghost-frame');
        const globalFileInput = document.getElementById('global-file-input');
        const landingPage = document.getElementById('landing-page');
        const userIconBtn = document.querySelector('.login-trigger');
        const saveCloudBtn = document.getElementById('save-cloud-btn');
        const signupBtn = document.getElementById('signup-google-btn');
        const loginBtn = document.getElementById('login-google-btn');

        if (!boardContainer || !canvas || !landingPage) {
            throw new Error("Missing board DOM (#board-container, #canvas, or #landing-page).");
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

        /** Each signed-in user only reads/writes Firestore `boards/{theirUid}` (see firestore.rules in repo). */
        async function persistBoardToCloud({ silent = false } = {}) {
            if (!auth.currentUser) return;
            document.querySelectorAll("#canvas input").forEach((inp) => inp.setAttribute("value", inp.value));
            let ghostHtml = "";
            const ghost = document.getElementById("ghost-frame");
            if (ghost && ghost.parentNode === canvas) {
                canvas.removeChild(ghost);
                ghostHtml = ghost.outerHTML;
            }
            try {
                await setDoc(
                    doc(db, "boards", auth.currentUser.uid),
                    {
                        canvasHTML: canvas.innerHTML,
                        updatedAt: new Date()
                    },
                    { merge: true }
                );
            } finally {
                if (ghostHtml) canvas.innerHTML = ghostHtml + canvas.innerHTML;
            }
        }

        function scheduleCloudSave() {
            if (!auth.currentUser) return;
            if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
            cloudSaveTimer = setTimeout(() => {
                cloudSaveTimer = null;
                persistBoardToCloud({ silent: true }).catch((err) => console.warn("Auto-save:", err));
            }, 2800);
        }

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden" && auth.currentUser) {
                if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
                persistBoardToCloud({ silent: true }).catch(() => {});
            }
        });

        // --- AUTH STATE OBSERVER (single listener) ---
        onAuthStateChanged(auth, async (user) => {
            console.log("Auth State Changed:", user ? "Logged In" : "Logged Out");
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
                        doc(db, "boards", user.uid),
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

                    const docSnap = await getDoc(doc(db, "boards", user.uid));
                    const snapExists =
                        typeof docSnap.exists === "function" ? docSnap.exists() : docSnap.exists;
                    const data = docSnap.data();
                    if (snapExists && data && data.canvasHTML) {
                        const temp = document.createElement("div");
                        temp.innerHTML = data.canvasHTML;
                        const ghost = document.getElementById("ghost-frame");
                        if (ghost) temp.prepend(ghost);
                        canvas.innerHTML = temp.innerHTML;
                        document.querySelectorAll("#canvas input").forEach((inp) => {
                            if (inp.hasAttribute("value")) inp.value = inp.getAttribute("value");
                        });
                        rehydrateAnalysisCardsFromDom();
                        canvas.querySelectorAll('.frame-body').forEach(ensureFrameUploadLabel);
                    }
                } catch (e) {
                    console.error("Load Error:", e);
                    const msg = String(e && e.message || e);
                    if (e?.code === "permission-denied") {
                        console.warn(
                            "MyMotif: Firestore permission denied. Deploy rules in firestore.rules (boards/{userId} read/write only for request.auth.uid == userId)."
                        );
                    }
                    if (e?.code === "unavailable" || e?.code === "not-found" || msg.includes("not-found") || msg.includes("offline")) {
                        console.warn(
                            "MyMotif: Cloud Firestore is not reachable. In Firebase Console open project \"mymotiffinal\" → Build → Firestore Database → Create database (if you have not). Then publish rules that allow signed-in users to read/write documents under boards/{theirUid}."
                        );
                    }
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
            if (e) { e.preventDefault(); e.stopPropagation(); }
            if (isSigningIn) return;
            isSigningIn = true;
            
            try {
                console.log("Initiating Popup Auth...");
                await ensureAuthPersistence();
                const result = await signInWithPopup(auth, provider);
                if (result.user) {
                    console.log("Login Success!");
                    landingPage.classList.add('hidden');
                    landingPage.style.display = 'none';
                }
            } catch (error) {
                console.error("Auth Error:", error);
                const code = error && error.code;
                if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
                    try {
                        await ensureAuthPersistence();
                        await signInWithRedirect(auth, provider);
                    } catch (e2) {
                        alert("Login Error: " + (e2.code || e2.message));
                    }
                } else {
                    alert("Login Error: " + (code || error.message));
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
                    if (!confirm("Sign out? Your board will be saved to the cloud first.")) return;
                    try {
                        await persistBoardToCloud({ silent: true });
                    } catch (err) {
                        console.warn("Save before sign-out:", err);
                    }
                    await signOut(auth);
                    location.reload();
                } else {
                    doGoogleSignIn(e);
                }
            });
        }


    
    let currentTool = 'select'; // 'select', 'pan', 'frame', 'board'

    let scale = 1;
    let panX = window.innerWidth / 2;
    let panY = window.innerHeight / 2;

    updateCanvasTransform();

    // Toolbar Logic
    const toolBtns = document.querySelectorAll('.tool-btn');
    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
            
            if (currentTool === 'frame' || currentTool === 'board') {
                boardContainer.style.cursor = 'crosshair';
            } else if (currentTool === 'pan') {
                boardContainer.style.cursor = 'grab';
            } else if (currentTool === 'comment') {
                boardContainer.style.cursor = 'crosshair';
            } else if (currentTool === 'context') {
                boardContainer.style.cursor = 'crosshair';
            } else {
                boardContainer.style.cursor = 'default';
            }
        });
    });

    function setTool(toolName) {
        toolBtns.forEach(btn => {
            if(btn.dataset.tool === toolName) btn.click();
        });
    }

    // Zooming
    boardContainer.addEventListener('wheel', (e) => {
        if(e.target.closest('.analysis-card')) return;
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

    function updateCanvasTransform() {
        canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    const historyStack = [];

    const getGhostFrame = () => document.getElementById('ghost-frame');
    const getGlobalFileInput = () => document.getElementById('global-file-input');

    function saveStateSafe() {
        const ghost = getGhostFrame();
        document.querySelectorAll('#canvas input').forEach(inp => {
            inp.setAttribute('value', inp.value);
        });
        
        if (ghost && ghost.parentNode === canvas) {
            canvas.removeChild(ghost);
        }
        
        historyStack.push(canvas.innerHTML);
        if (historyStack.length > 30) historyStack.shift();
        
        if (ghost) canvas.prepend(ghost);
        scheduleCloudSave();
    }

    function undoSafe() {
        const ghost = getGhostFrame();
        if (historyStack.length > 0) {
            if (ghost && ghost.parentNode === canvas) {
                canvas.removeChild(ghost);
            }
            canvas.innerHTML = historyStack.pop();
            if (ghost) canvas.prepend(ghost);
            deselectAll();
        }
        scheduleCloudSave();
    }


    // Keyboard Shortcuts (Delete & Undo)
    document.addEventListener('keydown', (e) => {
        // Undo: Cmd+Z or Ctrl+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault();
            undoSafe();
            return;
        }

        // Tool Shortcuts (only if not typing)
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
            if (e.key.toLowerCase() === 'v') setTool('select');
            if (e.key.toLowerCase() === 'b') setTool('board');
            if (e.key.toLowerCase() === 'f') setTool('frame');
            if (e.key.toLowerCase() === 'c') setTool('comment');
        }


        // Delete / Backspace
        if (e.key === 'Backspace' || e.key === 'Delete') {
            // Don't delete if we are typing in an input
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
                return;
            }
            
            const selectedElements = document.querySelectorAll('.selected');
            if (selectedElements.length > 0) {
                saveStateSafe();
                selectedElements.forEach(el => el.remove());
            }
        }
    });

    // Ensure input changes are tracked
    boardContainer.addEventListener('input', e => {
        if (e.target.tagName === 'INPUT') {
            e.target.setAttribute('value', e.target.value);
        }
    });


    // --- UNIFIED DRAG / DRAW STATE ---
    let isPanning = false;
    let isDrawing = false;
    let dragType = null; // 'move' or 'resize'
    let draggingElement = null; 
    let dragStartX, dragStartY;
    let initialLeft, initialTop, initialWidth, initialHeight;
    let activeFrameForUpload = null;
    let stateSavedForDrag = false;
    let containedElementsToMove = []; // Re-added for grouped board dragging
    let lastMousedownTime = 0;

    boardContainer.addEventListener(
        'pointerdown',
        (e) => {
            if (e.target.closest('.top-toolbar')) return;
            const lab = e.target.closest('.frame-upload-label');
            if (lab) {
                activeFrameForUpload = lab.closest('.motif-frame');
            }
        },
        true
    );

    boardContainer.addEventListener('mousedown', (e) => {
        if (e.target.closest('.top-toolbar')) return;

        const rect = canvas.getBoundingClientRect();
        const pointerX = (e.clientX - rect.left) / scale;
        const pointerY = (e.clientY - rect.top) / scale;

        const now = Date.now();
        const isDoubleClick = (now - lastMousedownTime < 300);
        lastMousedownTime = now;

        const individualDragHandle = e.target.closest('.individual-drag-handle');

        // If the hand (pan) tool is active, double click triggers an individual move. 
        // OR if they grabbed the explicit drag dot.
        let executeIndividualMove = (currentTool === 'pan' && isDoubleClick) || !!individualDragHandle;

        // Standard pan logic (only if we aren't doing the double-click individual move)
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
            const parentEl = deleteBtn.closest('.motif-frame, .motif-board, .analysis-card');
            if (parentEl) {
                saveStateSafe();
                parentEl.remove();
            }
            return;
        }

        const runBtn = e.target.closest('.run-btn');
        if (runBtn) {
            const parentNode = runBtn.closest('.motif-frame, .motif-board');
            if (parentNode) runAnalysis(parentNode);
            return;
        }

        if (currentTool === 'comment') {
            const imgNode = e.target.closest('.motif-image-node');
            if (imgNode) {
                openCommentModal(imgNode);
                return;
            }
        }

        if (currentTool === 'context') {
            const ctxFrame = e.target.closest('.motif-frame');
            if (ctxFrame) openContextModal(ctxFrame);
            return;
        }

        if (currentTool === 'select' || currentTool === 'comment' || executeIndividualMove) {
            const imageResizeHandle = e.target.closest('.image-resize-handle');
            const imageNode = e.target.closest('.motif-image-node');
            
            const frameResizeHandle = e.target.closest('.frame-resize-handle');
            const frameHeader = e.target.closest('.frame-header');
            const frameBody = e.target.closest('.frame-body');
            const frame = e.target.closest('.motif-frame');
            
            const boardResizeHandle = e.target.closest('.board-resize-handle');
            const boardHeader = e.target.closest('.board-header');
            const board = e.target.closest('.motif-board');
            
            const cardHeader = e.target.closest('.card-header');
            const analysisCard = e.target.closest('.analysis-card');

            if (e.target.tagName === 'INPUT') {
                if (frame) selectElement(frame, 'frame');
                if (board) selectElement(board, 'board');
                return;
            }

            if (individualDragHandle) {
                const parentElement = individualDragHandle.closest('.motif-frame, .motif-board, .analysis-card, .motif-image-node');
                if (parentElement) {
                    startDrag(e, parentElement, 'move', pointerX, pointerY, true);
                    selectElement(parentElement, parentElement.className.split(' ')[0].replace('motif-', ''));
                }
            } else if (imageResizeHandle) {
                startDrag(e, imageNode, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (imageNode) {
                startDrag(e, imageNode, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(imageNode, 'image');
            } else if (frameResizeHandle) {
                startDrag(e, frame, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (frameHeader) {
                startDrag(e, frame, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(frame, 'frame');
            } else if (
                frameBody &&
                frame &&
                !imageNode &&
                !e.target.closest('.motif-image-node') &&
                !e.target.closest('.frame-upload-label')
            ) {
                selectElement(frame, 'frame');
                activeFrameForUpload = frame;
                globalFileInput.click();
            } else if (frame) {
                selectElement(frame, 'frame');
            } else if (boardResizeHandle) {
                startDrag(e, board, 'resize', pointerX, pointerY, executeIndividualMove);
            } else if (boardHeader) {
                startDrag(e, board, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(board, 'board');
            } else if (board && !e.target.closest('.motif-frame') && !e.target.closest('.analysis-card')) {
                startDrag(e, board, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(board, 'board');
            } else if (cardHeader) {
                startDrag(e, analysisCard, 'move', pointerX, pointerY, executeIndividualMove);
                selectElement(analysisCard, 'card');
            } else if (analysisCard) {
                selectElement(analysisCard, 'card');
            } else {
                deselectAll();
            }
        }
    });

    function startDrag(e, element, type, px, py, isDoubleClickDrag = false) {
        draggingElement = element;
        dragType = type;
        dragStartX = px;
        dragStartY = py;
        stateSavedForDrag = false; // Will save on first pixel moved
        
        initialLeft = parseFloat(element.style.left) || 0;
        initialTop = parseFloat(element.style.top) || 0;
        initialWidth = parseFloat(element.style.width) || element.offsetWidth;
        initialHeight = parseFloat(element.style.height) || element.offsetHeight;
        
        containedElementsToMove = [];
        
        // Group Logic: Single click moves all, Double click moves individually
        if (type === 'move' && !isDoubleClickDrag) {
            let boardContext = null;
            
            if (element.classList.contains('motif-board')) {
                boardContext = element;
            } else if (element.classList.contains('motif-frame') || element.classList.contains('analysis-card')) {
                // If a frame/card was clicked, check if it is sitting on a board
                const cx = initialLeft + initialWidth / 2;
                const cy = initialTop + initialHeight / 2;
                
                document.querySelectorAll('.motif-board').forEach(b => {
                    const bx = parseFloat(b.style.left);
                    const by = parseFloat(b.style.top);
                    const bw = parseFloat(b.style.width) || b.offsetWidth;
                    const bh = parseFloat(b.style.height) || b.offsetHeight;
                    if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) {
                        boardContext = b;
                    }
                });
            }

            if (boardContext) {
                // Override the drag to move the entire board and its contents
                draggingElement = boardContext;
                initialLeft = parseFloat(boardContext.style.left) || 0;
                initialTop = parseFloat(boardContext.style.top) || 0;
                initialWidth = parseFloat(boardContext.style.width) || boardContext.offsetWidth;
                initialHeight = parseFloat(boardContext.style.height) || boardContext.offsetHeight;
                
                containedElementsToMove = getContainedNodes(boardContext).map(el => {
                    return { el, left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
                });
                
                // Visually show the board is selected to indicate grouped drag
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
            const width = Math.abs(pointerX - dragStartX);
            const height = Math.abs(pointerY - dragStartY);
            const left = Math.min(pointerX, dragStartX);
            const top = Math.min(pointerY, dragStartY);
            
            const ghost = getGhostFrame();
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
                draggingElement.style.left = (initialLeft + dx) + 'px';
                draggingElement.style.top = (initialTop + dy) + 'px';
                
                // Move contained elements together with the board
                containedElementsToMove.forEach(item => {
                    item.el.style.left = (item.left + dx) + 'px';
                    item.el.style.top = (item.top + dy) + 'px';
                });
            } else if (dragType === 'resize') {
                if (draggingElement.classList.contains('motif-image-node')) {
                    const ratio = initialWidth / initialHeight;
                    const newWidth = Math.max(50, initialWidth + dx);
                    draggingElement.style.width = newWidth + 'px';
                    draggingElement.style.height = (newWidth / ratio) + 'px';
                } else {
                    draggingElement.style.width = Math.max(50, initialWidth + dx) + 'px';
                    draggingElement.style.height = Math.max(50, initialHeight + dy) + 'px';
                }
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
                saveStateSafe(); // Save before creating
                if (currentTool === 'board') {
                    createBoardAt(left, top, width, height);
                } else if (currentTool === 'frame') {
                    createFrameAt(left, top, width, height);
                }
            }
            setTool('select');
        }

        draggingElement = null;
        dragType = null;
        containedElementsToMove = [];
    });

    function ensureFrameUploadLabel(frameBody) {
        if (!frameBody || frameBody.querySelector('.frame-upload-label')) return;
        const lab = document.createElement('label');
        lab.className = 'frame-upload-label';
        lab.setAttribute('for', 'global-file-input');
        lab.setAttribute('aria-label', 'Add images to this frame');
        frameBody.insertBefore(lab, frameBody.firstChild);
    }

    function createBoardAt(x, y, w, h) {
        const boardId = 'board-' + Date.now();
        const board = document.createElement('div');
        board.className = 'motif-board';
        board.id = boardId;
        board.style.left = x + 'px';
        board.style.top = y + 'px';
        board.style.width = w + 'px';
        board.style.height = h + 'px';
        board.style.zIndex = 0; 

        board.innerHTML = `
            <div class="board-header">
                <input type="text" class="board-title" value="New Board">
                <button class="delete-btn"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="board-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>
            <button class="run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Run Analysis</button>
        `;
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
        frame.style.zIndex = 1;

        frame.innerHTML = `
            <div class="frame-header">
                <input type="text" class="frame-title" placeholder="Frame" value="New Motif">
                <button class="delete-btn" title="Delete Frame"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="frame-body">
                <label class="frame-upload-label" for="global-file-input" aria-label="Add images to this frame"></label>
                <div class="empty-prompt">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    Click to add images
                </div>
            </div>
            <div class="frame-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>
            <button class="run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Run Analysis</button>
        `;

        canvas.appendChild(frame);
        selectElement(frame, 'frame');
        scheduleCloudSave();
    }

    function selectElement(el, type) {
        deselectAll();
        el.classList.add('selected');
        if (type === 'frame' || type === 'card') {
            el.style.zIndex = 10;
        } else if (type === 'board') {
            el.style.zIndex = 0;
        }
    }

    function deselectAll() {
        document.querySelectorAll('.motif-frame').forEach(f => { f.classList.remove('selected'); f.style.zIndex = 1; });
        document.querySelectorAll('.motif-board').forEach(b => { b.classList.remove('selected'); b.style.zIndex = 0; });
        document.querySelectorAll('.analysis-card').forEach(c => { c.classList.remove('selected'); c.style.zIndex = 5; });
        document.querySelectorAll('.motif-image-node').forEach(i => i.classList.remove('selected'));
    }

    // --- DELEGATED DRAG & DROP FOR IMAGES ---
    boardContainer.addEventListener('dragover', e => {
        const frameBody = e.target.closest('.frame-body');
        if (frameBody) {
            e.preventDefault();
            frameBody.style.background = 'rgba(107, 92, 231, 0.05)';
        }
    });

    boardContainer.addEventListener('dragleave', e => {
        const frameBody = e.target.closest('.frame-body');
        if (frameBody) {
            frameBody.style.background = 'transparent';
        }
    });

    boardContainer.addEventListener('drop', e => {
        const frameBody = e.target.closest('.frame-body');
        if (frameBody) {
            e.preventDefault();
            frameBody.style.background = 'transparent';
            activeFrameForUpload = frameBody.closest('.motif-frame');
            handleFiles(e.dataTransfer.files);
        }
    });

    globalFileInput.addEventListener('change', (e) => {
        if (activeFrameForUpload) handleFiles(e.target.files);
        globalFileInput.value = '';
    });

    const IMAGE_FILENAME_EXT_RE =
        /\.(png|jpe?g|jfif|pjpeg|gif|webp|bmp|tif|tiff|heic|heif|avif|ico|svg)$/i;

    function isLikelyImageFile(file) {
        const t = (file.type || '').toLowerCase().trim();
        if (t.startsWith('image/')) return true;
        const name = (file.name || '').toLowerCase();
        if (IMAGE_FILENAME_EXT_RE.test(name)) return true;
        if ((t === 'application/octet-stream' || t === '' || t === 'binary/octet-stream') && name) {
            return IMAGE_FILENAME_EXT_RE.test(name);
        }
        return false;
    }

    async function compressImage(dataUrl, maxWidth = 1000) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                if (!img.width || !img.height) {
                    reject(new Error('Invalid image dimensions'));
                    return;
                }
                const tempCanvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }

                tempCanvas.width = width;
                tempCanvas.height = height;
                const ctx = tempCanvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Canvas not available'));
                    return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                resolve({
                    url: tempCanvas.toDataURL('image/jpeg', 0.7),
                    aspectRatio: width / height
                });
            };
            img.onerror = () => {
                reject(new Error('Could not decode image (unsupported or corrupt file)'));
            };
            img.src = dataUrl;
        });
    }

    function uint8ToBase64(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < arr.length; i += chunk) {
            binary += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + chunk, arr.length)));
        }
        return btoa(binary);
    }

    /** Download object from Storage, build `data:<mime>;base64,...`, return Gemini inline_data fields. */
    async function fetchStorageImageAsGeminiInlineData(storagePath) {
        const path = String(storagePath || '').trim();
        if (!path) throw new Error('Missing storage path');
        const storageRef = ref(storage, path);
        const [meta, raw] = await Promise.all([
            getMetadata(storageRef).catch(() => null),
            getBytes(storageRef)
        ]);
        let mime = 'image/jpeg';
        if (meta && meta.contentType && /^image\//i.test(meta.contentType)) {
            mime = meta.contentType.split(';')[0].trim().toLowerCase();
        }
        const data = uint8ToBase64(raw);
        const dataUrl = `data:${mime};base64,${data}`;
        const parsed = dataUrlToGeminiInlineData(dataUrl);
        if (!parsed) throw new Error('Could not build image data URL from Storage bytes');
        return parsed;
    }

    /** If the canvas image has no Storage path yet, upload JPEG bytes then read back from Storage (same path). */
    async function ensureImageOnStorageThenFetch(node, img) {
        let path = (node.dataset.storagePath || '').trim();
        if (path) {
            return fetchStorageImageAsGeminiInlineData(path);
        }
        const part = await imageElementToGeminiJpegPart(img);
        const dataUrl = `data:${part.mime_type};base64,${part.data}`;
        if (!auth.currentUser) throw new Error('Sign in to save images to cloud storage for analysis.');
        path = `boards/${auth.currentUser.uid}/canvasImages/${Date.now()}-${Math.random().toString(36).slice(2, 11)}.jpg`;
        const blob = await fetch(dataUrl).then((r) => r.blob());
        await uploadBytes(ref(storage, path), blob, { contentType: part.mime_type || 'image/jpeg' });
        node.dataset.storagePath = path;
        scheduleCloudSave();
        return fetchStorageImageAsGeminiInlineData(path);
    }

    function handleFiles(files) {
        if (!activeFrameForUpload) return;

        const list = Array.from(files || []).filter(Boolean);
        if (list.length === 0) return;

        const accepted = list.filter(isLikelyImageFile);
        if (accepted.length === 0) {
            alert(
                'No supported images were found in that selection.\n\n' +
                    'Use PNG, JPEG, GIF, WebP, HEIC/HEIF (browser-dependent), SVG, BMP, TIFF, AVIF, or ICO. ' +
                    'Some screenshots arrive with no file type — try saving as PNG or JPEG and uploading again.'
            );
            return;
        }
        if (accepted.length < list.length) {
            console.warn(
                'MyMotif: skipped',
                list.length - accepted.length,
                'file(s) that did not look like supported images.'
            );
        }

        saveStateSafe(); // Save state before adding images

        const frameBody = activeFrameForUpload.querySelector('.frame-body');
        const runBtn = activeFrameForUpload.querySelector('.run-btn');
        frameBody.classList.add('has-content');

        let offset = 0;
        accepted.forEach((file) => {
            const reader = new FileReader();
            reader.onerror = () => {
                console.error('FileReader failed:', file.name);
                alert(`Could not read file: ${file.name || 'image'}`);
            };
            reader.onload = async (e) => {
                const imgNode = document.createElement('div');
                imgNode.className = 'motif-image-node';
                
                const fw = activeFrameForUpload.offsetWidth;
                const fh = activeFrameForUpload.offsetHeight;
                const size = Math.min(fw, fh) * 0.4; 
                
                imgNode.style.width = size + 'px';
                imgNode.style.height = size + 'px';
                imgNode.style.left = (fw / 2 - size / 2 + offset) + 'px';
                imgNode.style.top = (fh / 2 - size / 2 + offset) + 'px';
                offset += 20; 
                
                // Show a loading state
                imgNode.innerHTML = `
                    <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#eee;">
                        <i class="fa-solid fa-spinner fa-spin" style="color:var(--accent);"></i>
                    </div>
                `;
                frameBody.appendChild(imgNode);
                
                try {
                    // Compress the image locally to avoid hitting Firestore 1MB limits
                    const result = await compressImage(e.target.result);
                    const compressedUrl = result.url;
                    const aspectRatio = result.aspectRatio;
                    
                    const fw = activeFrameForUpload.offsetWidth;
                    const fh = activeFrameForUpload.offsetHeight;
                    const baseSize = Math.min(fw, fh) * 0.4; 
                    
                    // Adjust node size to match real aspect ratio
                    if (aspectRatio > 1) {
                        imgNode.style.width = baseSize + 'px';
                        imgNode.style.height = (baseSize / aspectRatio) + 'px';
                    } else {
                        imgNode.style.height = baseSize + 'px';
                        imgNode.style.width = (baseSize * aspectRatio) + 'px';
                    }
                    
                    imgNode.innerHTML = `
                        <img src="${compressedUrl}">
                        <div class="image-resize-handle"></div>
                        <div class="individual-drag-handle" title="Move Individually"></div>
                    `;
                    if (auth.currentUser) {
                        const uid = auth.currentUser.uid;
                        const storagePath = `boards/${uid}/canvasImages/${Date.now()}-${Math.random().toString(36).slice(2, 11)}.jpg`;
                        const blob = await fetch(compressedUrl).then((r) => r.blob());
                        await uploadBytes(ref(storage, storagePath), blob, { contentType: 'image/jpeg' });
                        imgNode.dataset.storagePath = storagePath;
                    }
                    runBtn.classList.add('ready');
                    scheduleCloudSave();
                } catch (error) {
                    console.error('Image processing failed:', error);
                    imgNode.remove();
                    alert(
                        `Could not process "${file.name || 'image'}".\n` +
                            (error && error.message
                                ? error.message
                                : 'Try PNG or JPEG. HEIC may not work in all browsers.')
                    );
                }
            };
            reader.readAsDataURL(file);
        });
    }

    // On-Canvas Analysis Card Logic
    function getContainedNodes(boardEl) {
        const contained = [];
        const bx = parseFloat(boardEl.style.left);
        const by = parseFloat(boardEl.style.top);
        const bw = parseFloat(boardEl.style.width);
        const bh = parseFloat(boardEl.style.height);
        
        document.querySelectorAll('.motif-frame').forEach(node => {
            const nx = parseFloat(node.style.left);
            const ny = parseFloat(node.style.top);
            const nw = parseFloat(node.style.width) || node.offsetWidth;
            const nh = parseFloat(node.style.height) || node.offsetHeight;
            
            const cx = nx + nw/2;
            const cy = ny + nh/2;
            if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) {
                contained.push(node);
            }
        });
        return contained;
    }

    // A) API key: Google AI (Gemini) with Generative Language API enabled.
    // Uses MYMOTIF_DEFAULT_GEMINI_API_KEY unless you set a non-empty window.MYMOTIF_GEMINI_API_KEY before load.
    // Single model only (v1): gemini-1.5-flash-latest — no fallback chain.
    //
    // GitHub Pages API key restriction (HTTP referrers) should include BOTH:
    //   https://ritzcrackers12.github.io/*
    //   https://ritzcrackers12.github.io/MyMotif/*
    // plus http://localhost:* for local dev.
    const winGeminiOverride =
        typeof window !== 'undefined' &&
        typeof window.MYMOTIF_GEMINI_API_KEY === 'string' &&
        window.MYMOTIF_GEMINI_API_KEY.trim();
    const GEMINI_API_KEY = winGeminiOverride || MYMOTIF_DEFAULT_GEMINI_API_KEY;
    console.log('MyMotif: Gemini key source →', winGeminiOverride ? 'window.MYMOTIF_GEMINI_API_KEY' : 'MYMOTIF_DEFAULT_GEMINI_API_KEY');

    const GEMINI_GENERATE_CONTENT_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    function geminiRetryMsFromMessage(message) {
        if (!message) return 0;
        const m = String(message).match(/retry in ([\d.]+)\s*s/i);
        if (!m) return 0;
        const sec = parseFloat(m[1]);
        if (!Number.isFinite(sec) || sec < 0) return 0;
        return Math.min(Math.ceil(sec * 1000), 45000);
    }

    function geminiRetryMsFromResponse(response, message) {
        try {
            const h = response && response.headers && response.headers.get('Retry-After');
            if (h) {
                const sec = parseFloat(h);
                if (Number.isFinite(sec) && sec > 0) {
                    return Math.min(Math.ceil(sec * 1000), 120000);
                }
            }
        } catch {
            /* ignore */
        }
        return geminiRetryMsFromMessage(message);
    }

    function geminiSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const GEMINI_FETCH_TIMEOUT_MS = 75000;

    function geminiCandidateHasText(data) {
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return false;
        return parts.some((p) => typeof p.text === 'string' && p.text.trim().length > 0);
    }

    /**
     * Calls Gemini v1 `gemini-1.5-flash-latest` only (no model fallback). Retries on 429 with delays.
     */
    async function geminiGenerateContent(requestBody) {
        let lastMessage = '';
        const maxAttempts = 6;
        const minDelayBetween429RetriesMs = 12000;

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
                if (e && e.name === 'AbortError') {
                    lastMessage = `Request timed out after ${Math.round(GEMINI_FETCH_TIMEOUT_MS / 1000)}s (network or very large images). Try fewer images or a faster connection.`;
                } else {
                    lastMessage = e && e.message ? String(e.message) : 'Network error calling Gemini.';
                }
                break;
            }
            clearTimeout(timer);

            const data = await response.json().catch(() => ({}));

            if (data.promptFeedback?.blockReason) {
                lastMessage = `Prompt blocked: ${data.promptFeedback.blockReason}`;
                break;
            }

            const c0 = data.candidates?.[0];
            if (response.ok && c0) {
                if (!geminiCandidateHasText(data)) {
                    const fr = c0.finishReason || c0.finish_reason;
                    lastMessage = fr
                        ? `Model returned no text (finish: ${fr}). Try different images or a smaller set.`
                        : 'Model returned no text in the response.';
                    break;
                }
                return data;
            }

            lastMessage = data.error?.message || `HTTP ${response.status}`;

            const is429 =
                response.status === 429 ||
                data.error?.status === 'RESOURCE_EXHAUSTED' ||
                /quota|exceeded|Resource exhausted|Too Many Requests/i.test(lastMessage);
            if (is429 && attempt < maxAttempts - 1) {
                let waitMs = geminiRetryMsFromResponse(response, lastMessage);
                if (waitMs < minDelayBetween429RetriesMs) waitMs = minDelayBetween429RetriesMs;
                await geminiSleep(waitMs);
                continue;
            }

            break;
        }
        const hint429 =
            /429|quota|Resource exhausted|Too Many Requests/i.test(lastMessage)
                ? ' (429 = rate limit: waits were applied between retries; try again later or enable billing in Google AI Studio.)'
                : '';
        throw new Error(
            (lastMessage ||
                'Gemini request failed (v1 models/gemini-1.5-flash-latest). Check https://aistudio.google.com/ for API access and quotas.') + hint429
        );
    }

    async function callGeminiFollowUp(insights, messages) {
        const ctx = JSON.stringify(insights);
        const ctxTrim = ctx.length > 14000 ? ctx.slice(0, 14000) + "\n…(truncated)" : ctx;
        const historyContents = [];
        for (const m of messages) {
            const role = m.role === "user" ? "user" : "model";
            historyContents.push({ role, parts: [{ text: m.text }] });
        }
        const body = {
            systemInstruction: {
                parts: [
                    {
                        text:
                            `You are the same expert visual design analyst who produced the structured analysis. The user has that analysis on screen. Answer follow-ups clearly and concisely (short paragraphs or tight bullets). Ground answers in the JSON below; if you cannot know something from the analysis, say so.\n\nAnalysis JSON:\n${ctxTrim}`
                    }
                ]
            },
            contents: historyContents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        };
        const data = await geminiGenerateContent(body);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const out = String(text).trim();
        return out || "(No reply text returned.)";
    }

    function bindFollowUpPanel(card) {
        const wrap = card.querySelector(".followup-chat");
        if (!wrap || !card._myMotifInsights) return;
        const thread = wrap.querySelector("[data-followup-thread]");
        const input = wrap.querySelector("[data-followup-input]");
        const sendBtn = wrap.querySelector("[data-followup-send]");
        if (!thread || !input || !sendBtn) return;

        function appendBubble(role, text) {
            const div = document.createElement("div");
            div.className = "followup-msg followup-msg-" + role;
            div.textContent = text;
            thread.appendChild(div);
            thread.scrollTop = thread.scrollHeight;
        }

        async function sendFollowUp() {
            const text = input.value.trim();
            if (!text) return;
            input.value = "";
            appendBubble("user", text);
            card._myMotifFollowUp.push({ role: "user", text });

            const loading = document.createElement("div");
            loading.className = "followup-msg followup-msg-model followup-loading";
            loading.textContent = "Thinking…";
            thread.appendChild(loading);
            thread.scrollTop = thread.scrollHeight;

            try {
                const reply = await callGeminiFollowUp(card._myMotifInsights, card._myMotifFollowUp);
                loading.remove();
                appendBubble("model", reply);
                card._myMotifFollowUp.push({ role: "model", text: reply });
                scheduleCloudSave();
            } catch (err) {
                loading.remove();
                const msg = err.message || String(err);
                appendBubble("model", "Sorry — " + msg);
                card._myMotifFollowUp.push({ role: "model", text: msg });
            }
        }

        sendBtn.onclick = (e) => {
            e.preventDefault();
            sendFollowUp();
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendFollowUp();
            }
        };
        if (!wrap.dataset.followupBound) {
            wrap.addEventListener("mousedown", (e) => e.stopPropagation());
            wrap.dataset.followupBound = "1";
        }
    }

    function mountFollowUpChat(card, insights) {
        const resultsDiv = card.querySelector(".analysis-results");
        if (!resultsDiv) return;
        resultsDiv.querySelector(".followup-chat")?.remove();

        card._myMotifInsights = insights;
        card._myMotifFollowUp = [];

        const wrap = document.createElement("div");
        wrap.className = "followup-chat";
        wrap.innerHTML = `
            <div class="followup-header"><i class="fa-solid fa-message"></i> Follow-up</div>
            <div class="followup-thread" data-followup-thread></div>
            <div class="followup-input-row">
                <textarea rows="2" class="followup-textarea" placeholder="Ask a follow-up… Enter sends · Shift+Enter newline" data-followup-input></textarea>
                <button type="button" class="followup-send" data-followup-send title="Send"><i class="fa-solid fa-arrow-up"></i></button>
            </div>`;
        resultsDiv.appendChild(wrap);
        bindFollowUpPanel(card);
    }

    function rehydrateAnalysisCardsFromDom() {
        canvas.querySelectorAll(".analysis-card").forEach((card) => {
            const store = card.querySelector(".analysis-payload-store");
            if (!store || !store.textContent.trim()) return;
            let insights;
            try {
                insights = JSON.parse(store.textContent);
            } catch (e) {
                return;
            }
            card._myMotifInsights = insights;
            card._myMotifFollowUp = [];
            card.querySelectorAll(".followup-thread .followup-msg").forEach((el) => {
                if (el.classList.contains("followup-loading")) return;
                const role = el.classList.contains("followup-msg-user") ? "user" : "model";
                card._myMotifFollowUp.push({ role, text: el.textContent });
            });
            bindFollowUpPanel(card);
        });
    }

    // --- INLINE IMAGE COMMENT (bubble editor → Enter → small chip, stays on this node for Gemini) ---
    let activeCommentEditor = null;

    function stripCommentUI(imgNode) {
        imgNode.querySelectorAll('.image-comment-editor, .image-comment-chip, .image-comment, .image-comment-icon').forEach((el) => el.remove());
    }

    function truncateCommentText(str, max) {
        const s = str.trim();
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '…';
    }

    function renderCommentChip(imgNode) {
        const val = (imgNode.dataset.comment || '').trim();
        stripCommentUI(imgNode);
        if (!val) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'image-comment-chip';
        chip.title = val;
        chip.setAttribute('aria-label', 'Edit note on this image');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-comment-dots';
        const span = document.createElement('span');
        span.className = 'image-comment-chip-text';
        span.textContent = truncateCommentText(val, 36);
        chip.append(icon, span);
        chip.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openCommentModal(imgNode);
        });
        chip.addEventListener('mousedown', (ev) => ev.stopPropagation());
        imgNode.appendChild(chip);
    }

    function commitInlineComment(imgNode, textarea) {
        const val = textarea.value.trim();
        imgNode.dataset.comment = val;
        activeCommentEditor = null;
        renderCommentChip(imgNode);
        setTool('select');
    }

    function cancelInlineComment(imgNode, initialDataset) {
        imgNode.dataset.comment = initialDataset;
        activeCommentEditor = null;
        renderCommentChip(imgNode);
        setTool('select');
    }

    function openCommentModal(imgNode) {
        if (activeCommentEditor) {
            if (activeCommentEditor.imgNode === imgNode) {
                activeCommentEditor.wrap.querySelector('textarea').focus();
                return;
            }
            const prevTa = activeCommentEditor.wrap.querySelector('textarea');
            commitInlineComment(activeCommentEditor.imgNode, prevTa);
        }

        const legacyBubble = imgNode.querySelector('.image-comment');
        if (legacyBubble && legacyBubble.textContent.trim() && !(imgNode.dataset.comment || '').trim()) {
            imgNode.dataset.comment = legacyBubble.textContent.trim();
        }
        const initialDataset = imgNode.dataset.comment || '';

        stripCommentUI(imgNode);

        const wrap = document.createElement('div');
        wrap.className = 'image-comment-editor';
        wrap.innerHTML = `
            <div class="image-comment-editor-inner">
                <textarea class="image-comment-editor-input" rows="3" placeholder="What do you like about this image?"></textarea>
                <div class="image-comment-editor-hint"><kbd>Enter</kbd> save · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>Esc</kbd> cancel</div>
            </div>
        `;
        const textarea = wrap.querySelector('textarea');
        textarea.value = initialDataset;
        imgNode.appendChild(wrap);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitInlineComment(imgNode, textarea);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                cancelInlineComment(imgNode, initialDataset);
            }
        });

        wrap.addEventListener('mousedown', (e) => e.stopPropagation());

        activeCommentEditor = { imgNode, wrap };
    }

    // --- CONTEXT MODAL ---
    function openContextModal(frame) {
        const existing = frame.dataset.context || '';
        const overlay = document.createElement('div');
        overlay.className = 'comment-input-overlay';
        overlay.innerHTML = `
            <div class="comment-input-modal">
                <h3><i class="fa-solid fa-bullseye" style="color:var(--accent); margin-right:6px;"></i>Set Frame Context</h3>
                <p>What's the project? Tell Gemini what you're trying to create so it can give you actionable advice.</p>
                <textarea id="context-textarea" placeholder="e.g. I'm designing a t-shirt with stars but I can't figure out the right style...">${existing}</textarea>
                <div class="modal-actions">
                    <button class="cancel-btn">Cancel</button>
                    <button class="save-btn">Save Context</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const textarea = overlay.querySelector('#context-textarea');
        textarea.focus();

        overlay.querySelector('.cancel-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('.save-btn').addEventListener('click', () => {
            const val = textarea.value.trim();
            frame.dataset.context = val;

            // Remove old context bar
            frame.querySelector('.frame-context-bar')?.remove();

            if (val) {
                const bar = document.createElement('div');
                bar.className = 'frame-context-bar';
                bar.innerHTML = `
                    <i class="fa-solid fa-bullseye"></i>
                    <span title="${val}">${val}</span>
                    <button class="edit-context-btn" title="Edit Context"><i class="fa-solid fa-pen"></i></button>
                `;
                frame.appendChild(bar);

                // Edit button
                bar.querySelector('.edit-context-btn').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    openContextModal(frame);
                });
            }
            overlay.remove();
            setTool('select');
        });
    }

    function getImageCommentText(node) {
        const fromData = (node.dataset.comment || '').trim();
        if (fromData) return fromData;
        const legacy = node.querySelector('.image-comment');
        if (legacy && legacy.textContent) return legacy.textContent.trim();
        return '';
    }

    /** Parse data: URLs for Gemini (handles image/svg+xml, charset, etc.). */
    function dataUrlToGeminiInlineData(src) {
        if (!src || typeof src !== 'string' || !src.startsWith('data:')) return null;
        const comma = src.indexOf(',');
        if (comma < 0) return null;
        const head = src.slice(0, comma).toLowerCase();
        if (!head.includes('base64')) return null;
        const meta = src.slice(5, comma);
        const mime = meta.split(';')[0].trim().toLowerCase();
        if (!mime.startsWith('image/')) return null;
        const data = src.slice(comma + 1).replace(/\s/g, '');
        if (!data) return null;
        return { mime_type: mime, data };
    }

    /** Re-encode to JPEG and cap size so the API request stays small and returns faster. */
    async function imageElementToGeminiJpegPart(imgEl, maxDim = 768, quality = 0.72) {
        const im = imgEl;
        if (!im.complete) {
            await new Promise((resolve, reject) => {
                im.addEventListener('load', () => resolve(), { once: true });
                im.addEventListener(
                    'error',
                    () => reject(new Error('Could not load image for analysis')),
                    { once: true }
                );
            });
        }
        const w = im.naturalWidth || im.width || 0;
        const h = im.naturalHeight || im.height || 0;
        if (!w || !h) throw new Error('Image has no dimensions');

        let tw = w;
        let th = h;
        if (Math.max(w, h) > maxDim) {
            if (w >= h) {
                tw = maxDim;
                th = Math.max(1, Math.round((h * maxDim) / w));
            } else {
                th = maxDim;
                tw = Math.max(1, Math.round((w * maxDim) / h));
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas not available');
        ctx.drawImage(im, 0, 0, tw, th);

        try {
            const parsed = dataUrlToGeminiInlineData(canvas.toDataURL('image/jpeg', quality));
            if (parsed) return parsed;
            const fallback = dataUrlToGeminiInlineData(canvas.toDataURL('image/jpeg', 0.85));
            if (fallback) return fallback;
        } catch (canvasErr) {
            const direct = dataUrlToGeminiInlineData(im.src);
            if (direct) return direct;
            throw canvasErr;
        }
        throw new Error('Could not encode image');
    }

    async function runAnalysis(parentNode) {
        const isBoard = parentNode.classList.contains('motif-board');
        const titleInput = parentNode.querySelector(isBoard ? '.board-title' : '.frame-title');
        const title = titleInput ? titleInput.value : 'Analysis';

        let containedFrames = [];
        if (isBoard) {
            containedFrames = getContainedNodes(parentNode);
            if (containedFrames.length === 0) {
                alert("Add some frames with images to the board first!");
                return;
            }
        } else {
            containedFrames = [parentNode];
        }

        const imageRecords = [];
        let imageOrdinal = 0;
        const collectFromFrame = (frameEl) => {
            const frameTitle = frameEl.querySelector('.frame-title')?.value?.trim() || 'Frame';
            frameEl.querySelectorAll('.motif-image-node').forEach((node) => {
                const img = node.querySelector('img');
                if (!img) return;
                imageOrdinal += 1;
                imageRecords.push({
                    img,
                    node,
                    frameTitle,
                    index: imageOrdinal
                });
            });
        };
        containedFrames.forEach(collectFromFrame);

        if (imageRecords.length === 0) {
            alert("Add some images first, then use the Comment tool on each image to note what you like. Run analysis when you're ready.");
            return;
        }

        if (!auth.currentUser) {
            alert('Please sign in to run analysis. Images are loaded from your Firebase Storage and sent to the model as base64.');
            return;
        }

        saveStateSafe();

        const px = parseFloat(parentNode.style.left);
        const py = parseFloat(parentNode.style.top);
        const pw = parseFloat(parentNode.style.width);
        
        const card = spawnAnalysisCard(title, px + pw + 40, py);

        const commentLines = imageRecords.map((r) => {
            const note = getImageCommentText(r.node);
            return `Image ${r.index} (frame "${r.frameTitle}"): ${note ? note : '(no written note — rely on pixels only for this one)'}`;
        });
        const commentsText =
            `\nThe user added these per-image notes. Image order matches the images attached above (Image 1 first, then 2, …). Weight these notes heavily when suggesting search queries, styles, and features:\n${commentLines.join('\n')}\n`;

        let contextText = '';
        const contexts = containedFrames.map((f) => f.dataset.context).filter(Boolean);
        if (contexts.length > 0) {
            contextText = `The user's project context and goals:\n${contexts.map((c) => `- ${c}`).join('\n')}\n`;
        }

        const prepared = await Promise.all(
            imageRecords.map(({ img, node }) =>
                ensureImageOnStorageThenFetch(node, img).catch((err) => {
                    console.warn('Prep image from Firebase Storage:', err);
                    return null;
                })
            )
        );
        const imageParts = prepared.filter(Boolean).map((inline) => ({ inline_data: inline }));

        if (imageParts.length === 0) {
            showAnalysisError(
                card,
                'Could not load images from Firebase Storage. Check that you are signed in, Storage rules allow reads, and images were uploaded while logged in.'
            );
            return;
        }

        const analystPreamble = `You are an expert visual design analyst and aesthetic researcher with deep knowledge of design history, art movements, graphic design theory, and contemporary visual culture. You specialize in identifying the subtle visual DNA that makes a collection of images feel cohesive.

When a user uploads a collection of images under a motif title, you will analyze them with the depth of a senior creative director, not a casual observer. Your analysis should surface insights the user couldn't articulate themselves — the subconscious patterns they are drawn to.`;

        const jsonContract = `You MUST respond with a single valid JSON object only (no markdown, no prose outside JSON). Use exactly these keys:

1. "visual_dna" (string): Break down what the designs share across form, line quality, proportion, complexity, texture, color, and how literal vs abstract they are.

2. "tension_analysis" (string): Contradictions within the collection; what the user is pulled between.

3. "aesthetic_movements" (array of objects): Each object: "name" (string, e.g. Cybersigilism, Brutalism), "match_percent" (integer 0-100), "explanation" (string — why this movement fits).

4. "unconscious_preference_summary" (string): Exactly 2-3 sentences on what the collection reveals about their taste that they probably could not say themselves.

5. "what_to_explore_next" (string): One direction slightly outside their comfort zone that logically extends their taste.

6. "search_queries" (object) with these array-of-strings properties (each at least 3 items when possible):
   - "precise_design_terminology"
   - "broad_discovery"
   - "specific_artists_or_designers"
   - "pinterest" (queries tuned for Pinterest visual search)
   - "arena" (queries tuned for Are.na boards / channels)
   - "google_images" (queries tuned for Google Images)

7. "do_not_explore" (array of strings): Aesthetic directions that would feel wrong for this collection.

8. "era_fingerprint" (string): What decade or design era the collection feels rooted in.

9. "mood_score" (object) with three sub-objects, each with "score_0_to_100" (integer) and "interpretation" (short string):
   - "warm_vs_cold" (0 = ice-cold / clinical, 100 = warm / intimate)
   - "loud_vs_quiet" (0 = whisper-quiet / minimal, 100 = loud / maximal)
   - "familiar_vs_alien" (0 = familiar / mainstream, 100 = alien / uncanny)

10. "cultural_geography" (string): What cultural visual tradition(s) the collection pulls from (regions, diasporas, vernaculars, or global fusion).`;

        const userTask = `Motif / frame title: "${title}"

${contextText || ''}${commentsText}

There are exactly ${imageParts.length} images attached in order (Image 1 through Image ${imageParts.length}). Map each per-image note to the matching image. If a note is missing for an image, infer from that image alone.

Return the JSON object now.`;

        const requestBody = {
            contents: [{
                parts: [
                    ...imageParts,
                    { text: `${analystPreamble}\n\n${jsonContract}\n\n${userTask}` }
                ]
            }],
            generationConfig: {
                temperature: 0.65,
                maxOutputTokens: 4096,
                responseMimeType: 'application/json'
            }
        };

        function parseGeminiJson(rawText) {
            let s = String(rawText || '')
                .replace(/^\uFEFF/, '')
                .replace(/```json\s*/gi, '')
                .replace(/```\s*/g, '')
                .trim();
            try {
                return JSON.parse(s);
            } catch (firstErr) {
                const start = s.indexOf('{');
                const end = s.lastIndexOf('}');
                if (start >= 0 && end > start) {
                    return JSON.parse(s.slice(start, end + 1));
                }
                throw firstErr;
            }
        }

        try {
            const data = await geminiGenerateContent(requestBody);
            const candidate = data.candidates?.[0];
            if (!candidate) {
                const br = data.promptFeedback?.blockReason || data.error?.message;
                throw new Error(br ? String(br) : 'No response from Gemini. Check API key and quota.');
            }
            const rawText = candidate.content?.parts?.[0]?.text || '';
            const insights = parseGeminiJson(rawText);
            renderAnalysisResults(card, insights);
            scheduleCloudSave();
        } catch (error) {
            console.error("Gemini API Error:", error);
            showAnalysisError(card, error.message || String(error));
        }
    }

    function spawnAnalysisCard(title, x, y) {
        const cardId = 'card-' + Date.now();
        const card = document.createElement('div');
        card.className = 'analysis-card';
        card.id = cardId;
        card.style.left = x + 'px';
        card.style.top = y + 'px';
        card.style.zIndex = 5;

        card.innerHTML = `
            <div class="card-header">
                <h2>Analysis: ${escapeHtml(title)}</h2>
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="individual-drag-handle" title="Move Individually"></div>
            <div class="analysis-loader">
                <div class="spinner"></div>
                <p>Running analysis…</p>
            </div>
            <div class="analysis-results hidden"></div>
        `;
        canvas.appendChild(card);
        selectElement(card, 'card');
        return card;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderTagList(items) {
        const arr = Array.isArray(items) ? items : [];
        return arr.map((q) => `<span class="search-query">${escapeHtml(q)}</span>`).join('');
    }

    function renderMoodRow(label, sub) {
        if (!sub || typeof sub !== 'object') return '';
        const score = typeof sub.score_0_to_100 === 'number' ? sub.score_0_to_100 : parseInt(sub.score, 10) || 0;
        const clamped = Math.max(0, Math.min(100, score));
        const interp = sub.interpretation || sub.label || '';
        return `
            <div class="mood-row">
                <div class="mood-row-label">${escapeHtml(label)}</div>
                <div class="mood-bar-track"><div class="mood-bar-fill" style="width:${clamped}%"></div></div>
                <div class="mood-row-meta"><span class="mood-pct">${clamped}</span>${interp ? ` — ${escapeHtml(interp)}` : ''}</div>
            </div>`;
    }

    function renderAnalysisResults(card, insights) {
        const loader = card.querySelector('.analysis-loader');
        const resultsDiv = card.querySelector('.analysis-results');
        if (!loader || !resultsDiv) return;

        const sq = insights.search_queries && typeof insights.search_queries === 'object' ? insights.search_queries : {};
        const movements = Array.isArray(insights.aesthetic_movements) ? insights.aesthetic_movements : [];
        const movementHtml = movements
            .map((m) => {
                const name = m.name || 'Movement';
                const pct = typeof m.match_percent === 'number' ? m.match_percent : parseInt(m.match_percent, 10);
                const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : '—';
                const expl = m.explanation || '';
                return `<div class="movement-card"><div class="movement-card-head"><strong>${escapeHtml(name)}</strong><span class="match-pct">${escapeHtml(String(p))}${p !== '—' ? '%' : ''}</span></div><p>${escapeHtml(expl)}</p></div>`;
            })
            .join('');

        const mood = insights.mood_score && typeof insights.mood_score === 'object' ? insights.mood_score : {};
        const moodHtml =
            renderMoodRow('Warm ↔ Cold', mood.warm_vs_cold) +
            renderMoodRow('Loud ↔ Quiet', mood.loud_vs_quiet) +
            renderMoodRow('Familiar ↔ Alien', mood.familiar_vs_alien);

        const doNot = Array.isArray(insights.do_not_explore) ? insights.do_not_explore : [];
        const doNotHtml = doNot.length ? `<ul>${doNot.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : '<p class="muted">—</p>';

        resultsDiv.innerHTML = `
            <div class="analysis-results-main">
            <div class="analysis-section">
                <h3><i class="fa-solid fa-dna" style="margin-right:6px; color:var(--accent);"></i>Visual DNA</h3>
                <p>${escapeHtml(insights.visual_dna) || '—'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-bolt" style="margin-right:6px; color:var(--accent);"></i>Tension analysis</h3>
                <p>${escapeHtml(insights.tension_analysis) || '—'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-layer-group" style="margin-right:6px; color:var(--accent);"></i>Aesthetic movements</h3>
                <div class="movement-stack">${movementHtml || '<p class="muted">—</p>'}</div>
            </div>
            <div class="analysis-section highlight-panel">
                <h3><i class="fa-solid fa-brain" style="margin-right:6px; color:var(--accent);"></i>Unconscious preference summary</h3>
                <p>${escapeHtml(insights.unconscious_preference_summary) || '—'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-compass" style="margin-right:6px; color:var(--accent);"></i>What to explore next</h3>
                <p>${escapeHtml(insights.what_to_explore_next) || '—'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-magnifying-glass" style="margin-right:6px; color:var(--accent);"></i>Search queries</h3>
                <div class="analysis-subsection"><h4>Precise design terminology</h4><div class="tags-container">${renderTagList(sq.precise_design_terminology)}</div></div>
                <div class="analysis-subsection"><h4>Broad discovery</h4><div class="tags-container">${renderTagList(sq.broad_discovery)}</div></div>
                <div class="analysis-subsection"><h4>Artists &amp; designers</h4><div class="tags-container">${renderTagList(sq.specific_artists_or_designers)}</div></div>
                <div class="analysis-subsection"><h4>Pinterest</h4><div class="tags-container">${renderTagList(sq.pinterest)}</div></div>
                <div class="analysis-subsection"><h4>Are.na</h4><div class="tags-container">${renderTagList(sq.arena)}</div></div>
                <div class="analysis-subsection"><h4>Google Images</h4><div class="tags-container">${renderTagList(sq.google_images)}</div></div>
            </div>
            <div class="analysis-section warn-panel">
                <h3><i class="fa-solid fa-ban" style="margin-right:6px; color:#B45309;"></i>Do not explore</h3>
                ${doNotHtml}
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-clock-rotate-left" style="margin-right:6px; color:var(--accent);"></i>Era fingerprint</h3>
                <p>${escapeHtml(insights.era_fingerprint) || '—'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-gauge-high" style="margin-right:6px; color:var(--accent);"></i>Mood score</h3>
                <div class="mood-stack">${moodHtml || '<p class="muted">—</p>'}</div>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-earth-americas" style="margin-right:6px; color:var(--accent);"></i>Cultural geography</h3>
                <p>${escapeHtml(insights.cultural_geography) || '—'}</p>
            </div>
            </div>
        `;

        const mainEl = resultsDiv.querySelector(".analysis-results-main");
        if (mainEl) {
            mainEl.querySelector(".analysis-payload-store")?.remove();
            const store = document.createElement("textarea");
            store.className = "analysis-payload-store";
            store.setAttribute("aria-hidden", "true");
            store.hidden = true;
            store.textContent = JSON.stringify(insights);
            mainEl.appendChild(store);
        }

        loader.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
        mountFollowUpChat(card, insights);
    }

    function showAnalysisError(card, message) {
        const loader = card.querySelector('.analysis-loader');
        const resultsDiv = card.querySelector('.analysis-results');
        if (!loader || !resultsDiv) return;

        resultsDiv.innerHTML = `
            <div class="analysis-section" style="text-align:center; padding:20px;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size:32px; color:#EF4444; margin-bottom:12px;"></i>
                <h3 style="color:#EF4444;">Analysis Failed</h3>
                <p style="font-size:13px; color:var(--text-secondary); margin-top:8px;">${escapeHtml(message)}</p>
            </div>
        `;

        loader.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
    }

    if (saveCloudBtn) {
        saveCloudBtn.addEventListener("click", async () => {
            if (!auth.currentUser) return;
            saveCloudBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                await persistBoardToCloud({ silent: false });
                saveCloudBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10B981;"></i>';
                setTimeout(() => {
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                }, 2000);
            } catch (error) {
                console.error("Error saving to cloud:", error);
                saveCloudBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #EF4444;"></i>';
                setTimeout(() => {
                    saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
                }, 2000);
                alert("Failed to save board. Are Firestore rules open?");
            }
        });
    }

    console.log("My Motif: App Initialized & Listeners Attached.");
    } catch (e) {
        alert("Fatal error during app boot: " + e.message);
    }
};



if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void initApp();
    });
} else {
    void initApp();
}
