import { auth, db, provider, signInWithPopup, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, doc, setDoc, getDoc } from './firebase.js';

const initApp = () => {
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


        // --- AUTH STATE OBSERVER ---
        onAuthStateChanged(auth, async (user) => {
            console.log("Auth State Changed:", user ? "Logged In" : "Logged Out");
            if (user) {
                landingPage.classList.add('hidden');
                landingPage.style.display = 'none';
                
                if (userIconBtn) {
                    userIconBtn.innerHTML = `<img src="${user.photoURL}" alt="Profile" style="width: 24px; height: 24px; border-radius: 50%;">`;
                    userIconBtn.title = `Logged in as ${user.displayName}`;
                }
                if (saveCloudBtn) saveCloudBtn.style.display = 'block';
                
                try {
                    const docSnap = await getDoc(doc(db, "boards", user.uid));
                    if (docSnap.exists()) {
                        const temp = document.createElement('div');
                        temp.innerHTML = docSnap.data().canvasHTML;
                        const ghost = document.getElementById('ghost-frame');
                        if (ghost) temp.prepend(ghost);
                        canvas.innerHTML = temp.innerHTML;
                    }
                } catch(e) { console.error("Load Error:", e); }
            } else {
                landingPage.classList.remove('hidden');
                landingPage.style.display = 'flex';
                if (userIconBtn) userIconBtn.innerHTML = `<i class="fa-solid fa-user"></i>`;
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
                // Set persistence first
                await setPersistence(auth, browserLocalPersistence);
                const result = await signInWithPopup(auth, provider);
                if (result.user) {
                    console.log("Login Success!");
                    landingPage.classList.add('hidden');
                    landingPage.style.display = 'none';
                }
            } catch (error) {
                console.error("Auth Error:", error);
                alert("Login Error: " + (error.code || error.message));
            } finally {
                isSigningIn = false;
            }
        }

        if (signupBtn) signupBtn.addEventListener('click', doGoogleSignIn);
        if (loginBtn) loginBtn.addEventListener('click', doGoogleSignIn);
        if (userIconBtn) {
            userIconBtn.addEventListener('click', (e) => {
                if (auth.currentUser) {
                    if(confirm("Sign out?")) {
                        signOut(auth);
                        location.reload();
                    }
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
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            if (e.key.toLowerCase() === 'v') setTool('select');
            if (e.key.toLowerCase() === 'b') setTool('board');
            if (e.key.toLowerCase() === 'f') setTool('frame');
            if (e.key.toLowerCase() === 'c') setTool('comment');
        }


        // Delete / Backspace
        if (e.key === 'Backspace' || e.key === 'Delete') {
            // Don't delete if we are typing in an input
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
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

        if (currentTool === 'select' || executeIndividualMove) {
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

            const deleteBtn = e.target.closest('.delete-btn');
            const runBtn = e.target.closest('.run-btn');

            if (deleteBtn) {
                const parentEl = deleteBtn.closest('.motif-frame, .motif-board, .analysis-card');
                if (parentEl) {
                    saveStateSafe();
                    parentEl.remove();
                }
                return;
            }

            if (runBtn) {
                const parentNode = runBtn.closest('.motif-frame, .motif-board');
                if (parentNode) runAnalysis(parentNode);
                return;
            }

            // --- COMMENT TOOL: click an image to add a note ---
            if (currentTool === 'comment') {
                const imgNode = e.target.closest('.motif-image-node');
                if (imgNode) {
                    openCommentModal(imgNode);
                }
                return;
            }

            // --- CONTEXT TOOL: click a frame to set project context ---
            if (currentTool === 'context') {
                const frame = e.target.closest('.motif-frame');
                if (frame) {
                    openContextModal(frame);
                }
                return;
            }

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
            } else if (frameBody && e.target === frameBody) {
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
            <button class="run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Analyze Board</button>
        `;
        canvas.appendChild(board);
        selectElement(board, 'board');
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
                <div class="empty-prompt">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    Click to add images
                </div>
            </div>
            <div class="frame-resize-handle"></div>
            <div class="individual-drag-handle" title="Move Individually"></div>
            <button class="run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Run Motif</button>
        `;

        canvas.appendChild(frame);
        selectElement(frame, 'frame');
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

    async function compressImage(dataUrl, maxWidth = 1000) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
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
                ctx.drawImage(img, 0, 0, width, height);
                // Compress to 70% quality JPEG to save massive space
                resolve({ 
                    url: tempCanvas.toDataURL('image/jpeg', 0.7),
                    aspectRatio: width / height
                });
            };
            img.src = dataUrl;
        });
    }

    function handleFiles(files) {
        if (!activeFrameForUpload) return;
        
        saveStateSafe(); // Save state before adding images
        
        const frameBody = activeFrameForUpload.querySelector('.frame-body');
        const runBtn = activeFrameForUpload.querySelector('.run-btn');
        frameBody.classList.add('has-content'); 

        let offset = 0;
        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
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
                    runBtn.classList.add('ready');
                } catch(error) {
                    console.error("Image processing failed:", error);
                    imgNode.remove();
                    alert("Failed to process image.");
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

    const GEMINI_API_KEY = 'AIzaSyBIO_RbPR64ltwkTMlVovWXruem8wAsEe0';
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    // --- COMMENT MODAL ---
    function openCommentModal(imgNode) {
        const existing = imgNode.dataset.comment || '';
        const overlay = document.createElement('div');
        overlay.className = 'comment-input-overlay';
        overlay.innerHTML = `
            <div class="comment-input-modal">
                <h3><i class="fa-solid fa-comment-dots" style="color:var(--accent); margin-right:6px;"></i>Add Comment</h3>
                <p>What do you like about this image? This helps Gemini understand your style.</p>
                <textarea id="comment-textarea" placeholder="e.g. I love the star shape and how it's slightly distressed...">${existing}</textarea>
                <div class="modal-actions">
                    <button class="cancel-btn">Cancel</button>
                    <button class="save-btn">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const textarea = overlay.querySelector('#comment-textarea');
        textarea.focus();

        overlay.querySelector('.cancel-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('.save-btn').addEventListener('click', () => {
            const val = textarea.value.trim();
            imgNode.dataset.comment = val;

            // Remove old comment bubble/icon
            imgNode.querySelector('.image-comment')?.remove();
            imgNode.querySelector('.image-comment-icon')?.remove();

            if (val) {
                // Add comment icon badge
                const icon = document.createElement('div');
                icon.className = 'image-comment-icon';
                icon.innerHTML = '<i class="fa-solid fa-comment"></i>';
                icon.title = val;
                imgNode.appendChild(icon);

                // Add visible comment bubble
                const bubble = document.createElement('div');
                bubble.className = 'image-comment';
                bubble.textContent = val;
                imgNode.appendChild(bubble);
            }
            overlay.remove();
            setTool('select');
        });
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

    async function runAnalysis(parentNode) {
        const isBoard = parentNode.classList.contains('motif-board');
        const titleInput = parentNode.querySelector(isBoard ? '.board-title' : '.frame-title');
        const title = titleInput ? titleInput.value : 'Analysis';
        
        const runBtn = parentNode.querySelector('.run-btn');
        // Allow run if there are images (we check below)
        
        // Collect all images and data
        let imageElements = [];
        let containedFrames = [];
        
        if (isBoard) {
            containedFrames = getContainedNodes(parentNode);
            if (containedFrames.length === 0) {
                alert("Add some frames with images to the board first!");
                return;
            }
            containedFrames.forEach(f => {
                f.querySelectorAll('.motif-image-node img').forEach(img => imageElements.push(img));
            });
        } else {
            containedFrames = [parentNode];
            parentNode.querySelectorAll('.motif-image-node img').forEach(img => imageElements.push(img));
        }

        if (imageElements.length === 0) {
            alert("Add some images first before running analysis!");
            return;
        }

        saveStateSafe();

        const px = parseFloat(parentNode.style.left);
        const py = parseFloat(parentNode.style.top);
        const pw = parseFloat(parentNode.style.width);
        
        // Spawn card with loading state
        const card = spawnAnalysisCard(title, px + pw + 40, py);

        // Collect user comments from image nodes within the relevant frames
        const comments = [];
        containedFrames.forEach(frame => {
            frame.querySelectorAll('.motif-image-node').forEach((node, i) => {
                if (node.dataset.comment) {
                    comments.push(`Image in "${frame.querySelector('.frame-title')?.value || 'Frame'}": "${node.dataset.comment}"`);
                }
            });
        });

        const commentsText = comments.length > 0 
            ? `\nThe user left these comments about specific images to guide your analysis:\n${comments.join('\n')}\n`
            : '';

        // Collect frame context from the relevant frames
        let contextText = '';
        const contexts = containedFrames
            .map(f => f.dataset.context)
            .filter(ctx => !!ctx);
            
        if (contexts.length > 0) {
            contextText = `The user's project context and goals:\n${contexts.map(c => `- ${c}`).join('\n')}\n`;
        }


        // Extract base64 data from all <img> src attributes
        const imageParts = [];
        for (const img of imageElements) {
            const src = img.src;
            if (src.startsWith('data:')) {
                // data:image/jpeg;base64,/9j/4AAQ...
                const mimeMatch = src.match(/^data:(image\/\w+);base64,/);
                if (mimeMatch) {
                    imageParts.push({
                        inline_data: {
                            mime_type: mimeMatch[1],
                            data: src.replace(/^data:image\/\w+;base64,/, '')
                        }
                    });
                }
            }
        }

        if (imageParts.length === 0) {
            showAnalysisError(card, "Could not read image data.");
            return;
        }

        // Build Gemini request
        const requestBody = {
            contents: [{
                parts: [
                    ...imageParts,
                    {
                        text: `You are an expert Design Strategist and Aesthetic Researcher. Your task is to analyze a collection of images and identify the user's "Motif" — the underlying visual DNA and stylistic patterns.

${contextText}
${commentsText}

Analyze all ${imageParts.length} images as a unified design collection. Focus on visual metaphors, material qualities, lighting, and composition. 

Return a JSON object with these exact keys:
- "commonalities": (Array) 3-5 high-level visual themes or recurring elements.
- "aesthetic": (String) A sophisticated 2-3 sentence breakdown of the design movement (e.g., Bauhaus, Memphis, Brutalism, Organic Modernism) and its historical/emotional vibe.
- "palette": (Array) 5-6 dominant hex codes that capture the mood.
- "features_to_look_for": (Array) 3-5 specific stylistic markers the user should seek out (e.g., "High-contrast grain," "Asymmetric balance," "Saturated geometric shapes").
- "recommendation": (String) 2-3 sentences of expert advice on how to apply these motifs to their project context.
- "search_queries": (Array) 4-6 precise terms for finding more inspiration.

Respond ONLY with raw JSON (no markdown fences).`

                    }
                ]
            }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1024
            }
        };

        try {
            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error?.message || `API returned ${response.status}`);
            }

            const data = await response.json();
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            // Parse JSON from the response (strip any accidental markdown fences)
            const jsonStr = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            const insights = JSON.parse(jsonStr);

            renderAnalysisResults(card, insights);

        } catch (error) {
            console.error("Gemini API Error:", error);
            showAnalysisError(card, error.message);
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
                <h2>Analysis: ${title}</h2>
                <button class="delete-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="individual-drag-handle" title="Move Individually"></div>
            <div class="analysis-loader">
                <div class="spinner"></div>
                <p>Analyzing ${title} with Gemini AI...</p>
            </div>
            <div class="analysis-results hidden"></div>
        `;
        canvas.appendChild(card);
        selectElement(card, 'card');
        return card;
    }

    function renderAnalysisResults(card, insights) {
        const loader = card.querySelector('.analysis-loader');
        const resultsDiv = card.querySelector('.analysis-results');
        if (!loader || !resultsDiv) return;

        // Build commonalities list
        const commonList = (insights.commonalities || [])
            .map(c => `<li>${c}</li>`).join('');

        // Build palette swatches
        const paletteSwatches = (insights.palette || [])
            .map(hex => `<span style="display:inline-block; width:28px; height:28px; border-radius:6px; background:${hex}; border:2px solid rgba(0,0,0,0.1); margin-right:6px;" title="${hex}"></span>`)
            .join('');

        // Build features list
        const featuresList = (insights.features_to_look_for || [])
            .map(f => `<li>${f}</li>`).join('');

        // Build search query tags
        const queryTags = (insights.search_queries || [])
            .map(q => `<span class="search-query">${q}</span>`).join('');

        resultsDiv.innerHTML = `
            <div class="analysis-section">
                <h3><i class="fa-solid fa-eye" style="margin-right:6px; color:var(--accent);"></i>Visual Commonalities</h3>
                <ul>${commonList}</ul>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-palette" style="margin-right:6px; color:var(--accent);"></i>Color Palette</h3>
                <div style="display:flex; flex-wrap:wrap; gap:4px; margin:8px 0;">${paletteSwatches}</div>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px; color:var(--accent);"></i>Aesthetic Breakdown</h3>
                <p>${insights.aesthetic || 'No aesthetic data available.'}</p>
            </div>
            <div class="analysis-section">
                <h3><i class="fa-solid fa-magnifying-glass" style="margin-right:6px; color:var(--accent);"></i>Features to Look For</h3>
                <ul>${featuresList}</ul>
            </div>
            ${insights.recommendation ? `
            <div class="analysis-section" style="background: rgba(107,92,231,0.05); border-radius: 10px; padding: 14px;">
                <h3><i class="fa-solid fa-lightbulb" style="margin-right:6px; color:#F59E0B;"></i>Recommendation</h3>
                <p>${insights.recommendation}</p>
            </div>` : ''}
            <div class="analysis-section">
                <h3><i class="fa-solid fa-hashtag" style="margin-right:6px; color:var(--accent);"></i>Search Queries</h3>
                <div class="tags-container">${queryTags}</div>
            </div>
        `;

        loader.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
    }

    function showAnalysisError(card, message) {
        const loader = card.querySelector('.analysis-loader');
        const resultsDiv = card.querySelector('.analysis-results');
        if (!loader || !resultsDiv) return;

        resultsDiv.innerHTML = `
            <div class="analysis-section" style="text-align:center; padding:20px;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size:32px; color:#EF4444; margin-bottom:12px;"></i>
                <h3 style="color:#EF4444;">Analysis Failed</h3>
                <p style="font-size:13px; color:var(--text-secondary); margin-top:8px;">${message}</p>
            </div>
        `;

        loader.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
    }

    // --- FIREBASE LOGIN LOGIC ---
    
    // Auth State Observer
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            landingPage.classList.add('hidden');
            
            userIconBtn.innerHTML = `<img src="${user.photoURL}" alt="Profile" style="width: 24px; height: 24px; border-radius: 50%;">`;
            userIconBtn.title = `Logged in as ${user.displayName} (Click to Sign Out)`;
            saveCloudBtn.style.display = 'block';
            
            // Load user's board data from Firestore
            try {
                const docSnap = await getDoc(doc(db, "boards", user.uid));
                if (docSnap.exists() && docSnap.data().canvasHTML) {
                    const temp = document.createElement('div');
                    temp.innerHTML = docSnap.data().canvasHTML;
                    // Protect ghost-frame
                    const ghost = document.getElementById('ghost-frame');
                    if (ghost) temp.prepend(ghost);
                    canvas.innerHTML = temp.innerHTML;
                    
                    // Resync input attributes so they visually show up
                    document.querySelectorAll('#canvas input').forEach(inp => {
                        if(inp.hasAttribute('value')) inp.value = inp.getAttribute('value');
                    });
                }
            } catch(e) {
                console.error("Error loading board:", e);
            }
        } else {
            userIconBtn.innerHTML = `<i class="fa-solid fa-user"></i>`;
            userIconBtn.title = "Log In";
            saveCloudBtn.style.display = 'none';
            landingPage.classList.remove('hidden');
        }
    });

    // Save to Cloud
    saveCloudBtn.addEventListener('click', async () => {
        if (!auth.currentUser) return;
        saveCloudBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        
        try {
            // Make sure inputs are serialized
            document.querySelectorAll('#canvas input').forEach(inp => inp.setAttribute('value', inp.value));
            
            // Extract ghost frame temporarily to not save it
            let ghostHtml = '';
            const ghost = document.getElementById('ghost-frame');
            if (ghost && ghost.parentNode === canvas) {
                canvas.removeChild(ghost);
                ghostHtml = ghost.outerHTML;
            }
            
            await setDoc(doc(db, "boards", auth.currentUser.uid), {
                canvasHTML: canvas.innerHTML,
                updatedAt: new Date()
            });
            
            if (ghostHtml) canvas.innerHTML = ghostHtml + canvas.innerHTML;
            
            saveCloudBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10B981;"></i>';
            setTimeout(() => saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>', 2000);
        } catch(error) {
            console.error("Error saving to cloud:", error);
            saveCloudBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #EF4444;"></i>';
            setTimeout(() => saveCloudBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>', 2000);
            alert("Failed to save board. Are Firestore rules open?");
        }
    });

    // Redirect sign-in return (e.g. GitHub Pages). Loaded dynamically so Safari never hits a missing top-level binding.
    import("https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js")
        .then(({ getRedirectResult }) => getRedirectResult(auth))
        .catch((error) => {
            console.error("Redirect Result Error:", error);
            if (error.code !== "auth/cancelled-popup-request") {
                alert("Login failed during redirect: " + error.message);
            }
        });

    console.log("My Motif: App Initialized & Listeners Attached.");
    } catch (e) {
        alert("Fatal error during app boot: " + e.message);
    }
};



if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
