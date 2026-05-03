import { auth, db, provider, signInWithPopup, onAuthStateChanged, signOut, doc, setDoc, getDoc } from './firebase.js';

const initApp = () => {
    const boardContainer = document.getElementById('board-container');
    const canvas = document.getElementById('canvas');
    const ghostFrame = document.getElementById('ghost-frame');
    const globalFileInput = document.getElementById('global-file-input');
    const landingPage = document.getElementById('landing-page');
    
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

    // --- UNDO HISTORY ---
    let historyStack = [];
    
    function saveState() {
        // Sync input values to HTML attributes so innerHTML captures them
        document.querySelectorAll('#canvas input').forEach(inp => {
            inp.setAttribute('value', inp.value);
        });
        
        // Temporarily remove selected classes to avoid saving selection state if we don't want to
        // Actually, saving selection state is fine. 
        
        // We only want to save the actual children, but wait, ghost-frame is in there. 
        // We can just save the whole innerHTML.
        historyStack.push(canvas.innerHTML);
        if (historyStack.length > 30) historyStack.shift();
    }

    function undo() {
        if (historyStack.length > 0) {
            canvas.innerHTML = historyStack.pop();
            // Need to re-grab the ghost frame reference since innerHTML wiped it
            rebindGhostFrame();
            deselectAll();
        }
    }

    function rebindGhostFrame() {
        // Update the global reference used by drawing logic
        const newGhost = document.getElementById('ghost-frame');
        if (newGhost) {
            // we don't actually have a global let ghostFrame, it's const. 
            // So we need to make sure we don't destroy ghostFrame.
            // Better: remove ghostFrame from canvas before saving, put it back after.
        }
    }
    
    // Let's adjust saveState to ignore ghost-frame by extracting it
    let ghostFrameEl = ghostFrame;
    function saveStateSafe() {
        document.querySelectorAll('#canvas input').forEach(inp => {
            inp.setAttribute('value', inp.value);
        });
        
        if (ghostFrameEl.parentNode === canvas) {
            canvas.removeChild(ghostFrameEl);
        }
        
        historyStack.push(canvas.innerHTML);
        if (historyStack.length > 30) historyStack.shift();
        
        canvas.prepend(ghostFrameEl);
    }

    function undoSafe() {
        if (historyStack.length > 0) {
            if (ghostFrameEl.parentNode === canvas) {
                canvas.removeChild(ghostFrameEl);
            }
            canvas.innerHTML = historyStack.pop();
            canvas.prepend(ghostFrameEl);
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
            
            ghostFrameEl.style.display = 'block';
            ghostFrameEl.style.left = dragStartX + 'px';
            ghostFrameEl.style.top = dragStartY + 'px';
            ghostFrameEl.style.width = '0px';
            ghostFrameEl.style.height = '0px';
            if (currentTool === 'board') {
                ghostFrameEl.style.borderStyle = 'dashed';
                ghostFrameEl.style.background = 'rgba(243, 244, 246, 0.4)';
            } else {
                ghostFrameEl.style.borderStyle = 'solid';
                ghostFrameEl.style.background = 'rgba(107, 92, 231, 0.1)';
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
            
            ghostFrameEl.style.left = left + 'px';
            ghostFrameEl.style.top = top + 'px';
            ghostFrameEl.style.width = width + 'px';
            ghostFrameEl.style.height = height + 'px';
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
            ghostFrameEl.style.display = 'none';
            
            const width = parseFloat(ghostFrameEl.style.width);
            const height = parseFloat(ghostFrameEl.style.height);
            const left = parseFloat(ghostFrameEl.style.left);
            const top = parseFloat(ghostFrameEl.style.top);
            
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
                resolve(tempCanvas.toDataURL('image/jpeg', 0.7));
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
                    const compressedUrl = await compressImage(e.target.result);
                    
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

    function runAnalysis(parentNode) {
        const isBoard = parentNode.classList.contains('motif-board');
        const titleInput = parentNode.querySelector(isBoard ? '.board-title' : '.frame-title');
        const title = titleInput ? titleInput.value : 'Analysis';
        
        const runBtn = parentNode.querySelector('.run-btn');
        if (!isBoard && !runBtn.classList.contains('ready')) return; 
        
        if (isBoard) {
            const frames = getContainedNodes(parentNode);
            if (frames.length === 0) {
                alert("Add some frames to the board first before analyzing it!");
                return;
            }
        }

        saveStateSafe(); // Save state before spawning card

        const px = parseFloat(parentNode.style.left);
        const py = parseFloat(parentNode.style.top);
        const pw = parseFloat(parentNode.style.width);
        
        spawnAnalysisCard(title, px + pw + 40, py);
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
                <p>Generating insights...</p>
            </div>
            <div class="analysis-results hidden">
                <div class="analysis-section">
                    <h3>Visual Commonalities</h3>
                    <ul>
                        <li>Soft, natural lighting with diffused shadows.</li>
                        <li>Organic shapes and fluid contours, avoiding sharp angles.</li>
                        <li>A muted, warm-neutral color palette.</li>
                    </ul>
                </div>
                <div class="analysis-section">
                    <h3>Aesthetic Breakdown</h3>
                    <p>This collection aligns heavily with the <strong>"Organic Modern"</strong> or <strong>"Wabi-Sabi"</strong> aesthetic. The emphasis is on raw materials and textural imperfections.</p>
                </div>
                <div class="analysis-section">
                    <h3>Search Queries</h3>
                    <div class="tags-container">
                        <span class="search-query">Organic modern</span>
                        <span class="search-query">Wabi-sabi</span>
                        <span class="search-query">Soft diffused</span>
                    </div>
                </div>
            </div>
        `;
        canvas.appendChild(card);
        selectElement(card, 'card');

        // Mock load
        setTimeout(() => {
            const loader = card.querySelector('.analysis-loader');
            const results = card.querySelector('.analysis-results');
            if (loader && results) {
                loader.classList.add('hidden');
                results.classList.remove('hidden');
            }
        }, 1500);
    }

    // --- FIREBASE LOGIN LOGIC ---
    const googleLoginBtns = document.querySelectorAll('.google-login-btn');
    const userIconBtn = document.querySelector('.login-trigger');
    const saveCloudBtn = document.getElementById('save-cloud-btn');
    
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

    // Login Trigger (Top Bar)
    userIconBtn.addEventListener('click', () => {
        if (auth.currentUser) {
            // If already logged in, clicking the avatar signs them out
            if(confirm("Do you want to sign out?")) {
                signOut(auth);
                // Clear the board on sign out
                document.querySelectorAll('.motif-board, .motif-frame, .analysis-card').forEach(el => el.remove());
                saveStateSafe(); // reset history
            }
        }
    });

    // Google Sign In / Sign Up
    googleLoginBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
            try {
                await signInWithPopup(auth, provider);
                // onAuthStateChanged handles the success automatically
            } catch (error) {
                console.error("Error signing in with Google: ", error);
                alert(`Firebase Auth Error!\nCode: ${error.code}\nMessage: ${error.message}`);
                btn.innerHTML = '<i class="fa-brands fa-google"></i> Sign Up with Google';
            }
        });
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
