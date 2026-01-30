pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- State ---
let pdfDoc = null;
let fileBytes = null;
let fileName = '';
let pageRotations = []; 
let totalPages = 0;
let selectedPageIndex = 0;
let currentZoom = 1.0; 
let currentViewport = null; 
let renderTask = null;
let currentRenderId = 0; 
let scrollTimeout = null;
let dragSrcEl = null; 

// --- MỐC ZOOM CỐ ĐỊNH (Theo yêu cầu) ---
const ZOOM_LEVELS = [
    0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.85, 
    1.00, 1.25, 1.50, 2.00, 3.00, 4.00, 6.00, 
    8.00, 12.00, 16.00
];

// --- History Manager (Undo/Redo) ---
const MAX_HISTORY = 50;
let historyStack = [];
let historyIndex = -1;
let isRestoringState = false; 

// --- Rendering Optimization ---
// bgCanvas: Giữ hình ảnh đang hiển thị hiện tại để vẽ lại nhanh khi tương tác
let bgCanvas = document.createElement('canvas'); 
let bgContext = bgCanvas.getContext('2d');
let isPdfRendered = false; 

// --- Interaction Modes ---
let currentMode = 'draw'; 
let drawTool = null; 

// --- Drawing/Interaction State ---
let activeColor = '#ff0000';
let activeWidth = 3;
let isMouseDown = false;
let isDrawing = false; 
let startX = 0; 
let startY = 0;

// Pan State
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panScrollLeft = 0, panScrollTop = 0;

// --- MULTI-SELECT STATE (Shapes) ---
let selectedIndices = new Set(); 
let isDraggingShape = false;
let isBoxSelecting = false; 
let selectionBoxStart = { x: 0, y: 0 }; 
let selectionBoxCurrent = { x: 0, y: 0 }; 
let dragAction = null; 
let dragStartShapeState = null; 

// --- SIDEBAR MULTI-SELECT STATE ---
let lastSelectedCardIndex = -1; 

// --- TEXT BOX SELECT/DRAG STATE ---
let selectedBox = null;     
let isDraggingBox = false;  
let dragBoxStartX = 0;
let dragBoxStartY = 0;
let initialBoxLeft = 0;
let initialBoxTop = 0;

let pageDrawings = {}; 
let tempImageData = null; 

// --- TEXT TOOL STATE ---
let activeTextBox = null; 
let activeFont = 'MS Gothic';
let activeFontSize = 16;

// Elements
const textPopup = document.getElementById('text-format-popup');
const popupFontSelect = document.getElementById('popup-font');
const popupSizeInput = document.getElementById('popup-size');
const miniColorPalette = document.getElementById('mini-color-palette');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadOverlay = document.getElementById('upload-overlay');
const globalToolbar = document.getElementById('global-toolbar');
const editToolbar = document.getElementById('edit-toolbar');
const sidebarList = document.getElementById('sidebar-list');
const mainCanvas = document.getElementById('main-canvas');
const previewWrapper = document.getElementById('preview-wrapper');
const canvasBox = document.getElementById('canvas-box'); 
const emptyMsg = document.getElementById('empty-msg');
const loader = document.getElementById('loader');
const widthLabel = document.getElementById('width-label');
const colorPopup = document.getElementById('color-popup');
const widthPopup = document.getElementById('width-popup');
const cursorPopup = document.getElementById('cursor-popup');
const pageNavInput = document.getElementById('page-nav-input');
const pageCountDisplay = document.getElementById('page-count-display');
const zoomSlider = document.getElementById('zoom-vertical-slider');
const zoomValueDisplay = document.getElementById('zoom-value-display');
const zoomControls = document.getElementById('zoom-controls');

// --- ZOOM CONTROLS LOGIC (AUTO HIDE) ---
let zoomControlTimeout = null;

function showZoomControls() {
    if (zoomControls) {
        zoomControls.classList.add('active'); // Hiển thị
        
        // Reset timeout cũ nếu có
        if (zoomControlTimeout) {
            clearTimeout(zoomControlTimeout);
        }
        
        // Đặt timeout mới để ẩn sau 4 giây
        zoomControlTimeout = setTimeout(() => {
            zoomControls.classList.remove('active'); // Ẩn
        }, 4000);
    }
}

// --- HELPER: TÌM ZOOM LEVEL TIẾP THEO ---
function getNextZoomLevel(current, direction) {
    const epsilon = 0.001; 
    if (direction > 0) { // Zoom In
        for (let z of ZOOM_LEVELS) {
            if (z > current + epsilon) return z;
        }
        return ZOOM_LEVELS[ZOOM_LEVELS.length - 1]; 
    } else { // Zoom Out
        for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
            let z = ZOOM_LEVELS[i];
            if (z < current - epsilon) return z;
        }
        return ZOOM_LEVELS[0]; 
    }
}

// --- HELPER: CẬP NHẬT UI ZOOM ---
function updateZoomUI() {
    // Gọi hàm hiển thị thanh zoom mỗi khi zoom thay đổi
    showZoomControls();

    if (!zoomSlider || !zoomValueDisplay) return;
    
    // Tìm index gần nhất trong mảng ZOOM_LEVELS
    let closestIndex = 0;
    let minDiff = Infinity;
    
    ZOOM_LEVELS.forEach((val, idx) => {
        const diff = Math.abs(val - currentZoom);
        if (diff < minDiff) {
            minDiff = diff;
            closestIndex = idx;
        }
    });

    // Cập nhật giá trị thanh trượt và text hiển thị
    zoomSlider.value = closestIndex;
    zoomValueDisplay.value = Math.round(currentZoom * 100) + '%';
}

// --- SỰ KIỆN THANH TRƯỢT ZOOM ---
if (zoomSlider) {
    zoomSlider.addEventListener('input', (e) => {
        // Khi kéo thanh trượt, cũng cần hiện thanh zoom (giữ nó hiển thị)
        showZoomControls();

        const index = parseInt(e.target.value);
        if (index >= 0 && index < ZOOM_LEVELS.length) {
            const newZoom = ZOOM_LEVELS[index];
            if (newZoom !== currentZoom) {
                currentZoom = newZoom;
                isPdfRendered = false;
                updateMainCanvas(selectedPageIndex);
                // Cập nhật text hiển thị ngay lập tức
                if (zoomValueDisplay) zoomValueDisplay.value = Math.round(currentZoom * 100) + '%';
            }
        }
    });
}

// --- HISTORY SYSTEM (UNDO/REDO) ---

function snapshotState() {
    const drawingsClone = JSON.parse(JSON.stringify(pageDrawings));
    const rotationsClone = [...pageRotations];
    const pageOrder = Array.from(document.querySelectorAll('.page-card')).map(card => {
        return parseInt(card.dataset.originalIndex);
    });

    return {
        drawings: drawingsClone,
        rotations: rotationsClone,
        pageOrder: pageOrder,
        selectedPageIndex: selectedPageIndex
    };
}

function saveState() {
    if (isRestoringState) return;
    if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
    }
    historyStack.push(snapshotState());
    historyIndex++;
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift();
        historyIndex--;
    }
}

function undo() {
    if (historyIndex > 0) {
        historyIndex--;
        restoreState(historyStack[historyIndex]);
    }
}

function redo() {
    if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        restoreState(historyStack[historyIndex]);
    }
}

async function restoreState(state) {
    if (!state) return;
    isRestoringState = true;
    
    // TẮT LOADER KHI UNDO ĐỂ TRÁNH NHÁY MÀN HÌNH
    // showLoader(true); 

    pageDrawings = JSON.parse(JSON.stringify(state.drawings));
    pageRotations = [...state.rotations];
    selectedPageIndex = state.selectedPageIndex;

    const currentOrder = Array.from(document.querySelectorAll('.page-card')).map(c => parseInt(c.dataset.originalIndex));
    const isOrderChanged = JSON.stringify(currentOrder) !== JSON.stringify(state.pageOrder);

    if (isOrderChanged) {
        const cardCache = {};
        document.querySelectorAll('.page-card').forEach(card => {
            cardCache[card.dataset.originalIndex] = card;
        });

        let needsFullReload = false;
        for (let idx of state.pageOrder) {
            if (!cardCache[idx]) {
                needsFullReload = true;
                break;
            }
        }

        if (needsFullReload) {
            // Trường hợp phải load lại sidebar (vd: undo xóa trang), vẫn cần hiện loader nếu quá chậm, 
            // nhưng với app nhỏ này thì render lại khá nhanh nên có thể bỏ qua để mượt hơn.
            // Nếu muốn hiện loader chỉ cho thao tác nặng này, có thể bật ở đây.
            // showLoader(true); 
            await renderSidebar();
            // showLoader(false);
            
            const freshCards = {};
            document.querySelectorAll('.page-card').forEach(c => freshCards[c.dataset.originalIndex] = c);
            sidebarList.innerHTML = ''; 
            
            state.pageOrder.forEach(idx => {
                if(freshCards[idx]) sidebarList.appendChild(freshCards[idx]);
            });
            updateSidebarPageNumbers();
        } else {
            sidebarList.innerHTML = '';
            state.pageOrder.forEach((originalIndex, newIndex) => {
                let card = cardCache[originalIndex];
                if (card) {
                    sidebarList.appendChild(card);
                    const num = card.querySelector('.page-number');
                    if (num) num.textContent = newIndex + 1;
                }
            });
        }
    }

    highlightSelectedPages();
    isPdfRendered = false;
    await updateMainCanvas(selectedPageIndex);
    
    state.pageOrder.forEach(idx => {
        const thumb = document.getElementById(`thumb-${idx}`);
        if(thumb) thumb.style.transform = `rotate(${pageRotations[idx]}deg)`;
    });

    // showLoader(false); // Tắt loader
    isRestoringState = false;
}

// --- NAVIGATION LOGIC ---
if (pageNavInput) {
    pageNavInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value);
        const cards = document.querySelectorAll('.page-card');
        const maxPages = cards.length;
        if (isNaN(val) || val < 1) val = 1;
        if (val > maxPages) val = maxPages;
        if (cards[val - 1]) {
            const originalIdx = parseInt(cards[val - 1].dataset.originalIndex);
            selectPage(originalIdx);
        } else {
             e.target.value = 1; 
        }
    });
}

function updatePageNavDisplay() {
    if (!pageNavInput || !pageCountDisplay) return;
    const cards = Array.from(document.querySelectorAll('.page-card'));
    const currentIndex = cards.findIndex(c => parseInt(c.dataset.originalIndex) === selectedPageIndex);
    pageNavInput.value = currentIndex !== -1 ? currentIndex + 1 : 1;
    pageCountDisplay.textContent = '/ ' + cards.length; 
    pageNavInput.max = cards.length;
}

// --- GLOBAL DRAG & DROP ---
document.body.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); });
document.body.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
document.body.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); });
document.body.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        const pdfFiles = files.filter(f => f.type === 'application/pdf');
        if (pdfFiles.length === 0) { alert('Only PDF files are supported!'); return; }
        if (!fileBytes) {
            await handleFile(pdfFiles[0]);
            if (pdfFiles.length > 1) await handleMergeMultipleFiles(pdfFiles.slice(1));
        } else {
            await handleMergeMultipleFiles(pdfFiles);
        }
    }
});

if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => { if(e.target.files[0]) handleFile(e.target.files[0]); });
}

// --- CANVAS EVENTS ---
if (mainCanvas) mainCanvas.addEventListener('mousedown', handleMouseDown);
window.addEventListener('mousemove', handleMouseMove); 
window.addEventListener('mouseup', handleMouseUp);

// --- POPUP EVENTS ---
if (popupFontSelect) {
    popupFontSelect.addEventListener('change', (e) => {
        activeFont = e.target.value;
        if (activeTextBox) { activeTextBox.style.fontFamily = activeFont; activeTextBox.focus(); } 
        else if (selectedBox) { selectedBox.style.fontFamily = activeFont; updateTextBoxData(selectedBox); saveState(); }
    });
}
if (popupSizeInput) {
    popupSizeInput.addEventListener('change', (e) => {
        activeFontSize = parseInt(e.target.value);
        if (activeTextBox) { activeTextBox.style.fontSize = (activeFontSize * currentZoom) + 'px'; activeTextBox.focus(); } 
        else if (selectedBox) { selectedBox.style.fontSize = (activeFontSize * currentZoom) + 'px'; updateTextBoxData(selectedBox); saveState(); }
    });
}
if (miniColorPalette) {
    miniColorPalette.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('mini-swatch')) {
            e.preventDefault();
            const color = e.target.getAttribute('data-color');
            activeColor = color;
            document.getElementById('tool-color-btn').style.backgroundColor = color;
            if (activeTextBox) activeTextBox.style.color = activeColor;
            else if (selectedBox) { selectedBox.style.color = activeColor; updateTextBoxData(selectedBox); saveState(); }
        }
    });
}

// --- KEYBOARD EVENTS ---
window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
        return;
    }
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        redo();
        return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (activeTextBox) return; 
        if (selectedBox && selectedBox.classList.contains('editing-in-select')) return; 
        if (selectedBox && currentMode === 'select') {
            const idx = parseInt(selectedBox.dataset.idx);
            if (!isNaN(idx) && pageDrawings[selectedPageIndex]) {
                pageDrawings[selectedPageIndex].splice(idx, 1);
            }
            selectedBox.remove();
            selectedBox = null;
            hideTextPopup(); 
            redrawCanvas();
            saveState(); 
            return;
        }
        if (currentMode === 'select' && selectedIndices.size > 0) {
            deleteSelectedShapes();
            return;
        }
        deleteSelectedPages();
    }
    if (e.key === 'Escape') {
        forceSaveActiveBox(); 
        if (currentMode === 'select') {
            selectedIndices.clear();
            deselectBox(); 
            redrawCanvas();
        }
        if (isDrawing || isBoxSelecting) {
            isDrawing = false;
            isBoxSelecting = false;
            redrawCanvas();
        }
    }
});

// ... (Helper functions) ...
function getMousePos(evt) {
    const rect = mainCanvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}
function toPdf(cx, cy) {
    if (!currentViewport) return { x: cx, y: cy };
    const pt = currentViewport.convertToPdfPoint(cx, cy);
    return { x: pt[0], y: pt[1] };
}
function toCanvas(px, py) {
    if (!currentViewport) return { x: px, y: py };
    const pt = currentViewport.convertToViewportPoint(px, py);
    return { x: pt[0], y: pt[1] };
}
function getShapeBounds(d) {
    if (d.type === 'freehand') {
        if (!d.points || d.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
        const xs = d.points.map(p => p.x); const ys = d.points.map(p => p.y);
        const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, type: 'freehand' };
    } else {
        const minX = Math.min(d.startX, d.endX); const maxX = Math.max(d.startX, d.endX);
        const minY = Math.min(d.startY, d.endY); const maxY = Math.max(d.startY, d.endY);
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, type: 'rect' };
    }
}
function setMode(mode, tool = null) {
    forceSaveActiveBox();
    currentMode = mode;
    if (mode !== 'select') deselectBox();
    if (mode === 'draw') {
        drawTool = tool;
        selectedIndices.clear(); 
        canvasBox.classList.remove('text-mode');
        if (tool === 'text') canvasBox.classList.add('text-mode');
    } else {
        drawTool = null;
        canvasBox.classList.remove('text-mode');
    }
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    if (mode === 'draw' && tool) {
        const btn = document.getElementById(`tool-${tool}`);
        if(btn) btn.classList.add('active');
        if (tool === 'eraser') mainCanvas.style.cursor = 'cell';
        else if (tool === 'text') mainCanvas.style.cursor = 'text';
        else mainCanvas.style.cursor = 'crosshair';
    } else if (mode === 'select') {
        document.getElementById('mode-select').classList.add('active');
        document.getElementById('tool-cursor-btn').classList.add('active'); 
        mainCanvas.style.cursor = 'default';
    } else if (mode === 'pan') {
        document.getElementById('mode-pan').classList.add('active');
        document.getElementById('tool-cursor-btn').classList.add('active');
        mainCanvas.style.cursor = 'grab';
        previewWrapper.style.cursor = 'grab';
    }
    if(mode !== 'select' && mode !== 'pan') cursorPopup.classList.remove('show');
    redrawCanvas(); 
}

// --- MOUSE HANDLERS ---
function handleMouseDown(e) {
    if (currentMode === 'draw' && drawTool === 'text') {
        if (e.target.closest('.text-box') || e.target.closest('#text-format-popup')) return;
        forceSaveActiveBox();
        const pos = getMousePos(e);
        createNewTextBox(pos.x, pos.y);
        return; 
    }
    isMouseDown = true;
    const pos = getMousePos(e);
    if (currentMode === 'pan') startPan(e);
    else if (currentMode === 'select') startSelect(pos.x, pos.y, e.shiftKey || e.ctrlKey);
    else if (currentMode === 'draw') startDraw(e, pos);
}

function handleMouseMove(e) {
    if (isDraggingBox && selectedBox && currentMode === 'select') {
        e.preventDefault(); 
        const dx = e.clientX - dragBoxStartX;
        const dy = e.clientY - dragBoxStartY;
        selectedBox.style.left = `${initialBoxLeft + dx}px`;
        selectedBox.style.top = `${initialBoxTop + dy}px`;
        showTextPopup(selectedBox.offsetLeft, selectedBox.offsetTop);
        return; 
    }
    if (!isMouseDown && !isPanning) {
        if (currentMode === 'select') {
            const pos = getMousePos(e);
            const pdfPt = toPdf(pos.x, pos.y);
            const drawings = pageDrawings[selectedPageIndex] || [];
            let cursor = 'default';
            if (selectedIndices.size === 1) {
                const idx = Array.from(selectedIndices)[0];
                const d = drawings[idx];
                if (d && d.type !== 'text') {
                    const handle = getHandleHit(d, pdfPt.x, pdfPt.y);
                    if (handle) cursor = 'nwse-resize';
                    else if (hitTestShape(d, pdfPt.x, pdfPt.y)) cursor = 'move';
                }
            }
            mainCanvas.style.cursor = cursor;
        }
        return;
    }
    if (isPanning) doPan(e);
    else if (currentMode === 'select') {
        const pos = getMousePos(e);
        if (isDraggingShape) doMoveShape(pos.x, pos.y);
        else if (isBoxSelecting) { selectionBoxCurrent = { x: pos.x, y: pos.y }; redrawCanvas(); }
    } else if (currentMode === 'draw') {
        const pos = getMousePos(e); 
        doDraw(e, pos);
    }
}

function handleMouseUp(e) {
    if (isDraggingBox && selectedBox) {
        isDraggingBox = false;
        updateTextBoxData(selectedBox);
        saveState(); 
        return;
    }
    isMouseDown = false;
    if (isPanning) endPan();
    else if (currentMode === 'select') { 
        if (isBoxSelecting) endBoxSelect();
        if (isDraggingShape) saveState(); 
        isDraggingShape = false; 
        isBoxSelecting = false; 
        dragAction = null; 
        dragStartShapeState = null; 
        redrawCanvas();
    }
    else if (currentMode === 'draw') endDraw(e);
}

// --- TEXT BOX FUNCTIONS ---
function forceSaveActiveBox() {
    if (activeTextBox) {
        const text = activeTextBox.innerText.trim();
        if (text) {
            if (!pageDrawings[selectedPageIndex]) pageDrawings[selectedPageIndex] = [];
            const pdfPt = toPdf(parseFloat(activeTextBox.style.left), parseFloat(activeTextBox.style.top));
            pageDrawings[selectedPageIndex].push({
                type: 'text', text: text, x: pdfPt.x, y: pdfPt.y,
                color: activeColor, fontSize: activeFontSize, fontFamily: activeFont
            });
            saveState(); 
        }
        activeTextBox.remove();
        activeTextBox = null;
        hideTextPopup();
    }
}

function selectBox(box) {
    if (selectedBox && selectedBox !== box) deselectBox();
    selectedBox = box;
    box.classList.add('selected');
    box.contentEditable = 'false';
    const idx = parseInt(box.dataset.idx);
    if (!isNaN(idx) && pageDrawings[selectedPageIndex] && pageDrawings[selectedPageIndex][idx]) {
        const d = pageDrawings[selectedPageIndex][idx];
        activeFont = d.fontFamily; activeFontSize = d.fontSize; activeColor = d.color;
    } else { activeColor = box.style.color; }
    showTextPopup(box.offsetLeft, box.offsetTop);
}

function deselectBox() {
    if (selectedBox) {
        selectedBox.classList.remove('selected');
        selectedBox.classList.remove('editing-in-select');
        selectedBox.contentEditable = 'false'; 
        selectedBox = null;
    }
    hideTextPopup(); 
}

function updateTextBoxData(box) {
    const idx = parseInt(box.dataset.idx);
    if (isNaN(idx)) return;
    if (!pageDrawings[selectedPageIndex]) pageDrawings[selectedPageIndex] = [];
    const d = pageDrawings[selectedPageIndex][idx];
    if (d && d.type === 'text') {
        const currentLeft = parseFloat(box.style.left || 0);
        const currentTop = parseFloat(box.style.top || 0);
        const pdfPt = toPdf(currentLeft, currentTop);
        d.x = pdfPt.x; d.y = pdfPt.y; d.text = box.innerText;
        d.color = box.style.color; d.fontSize = parseFloat(box.style.fontSize) / currentZoom; 
        d.fontFamily = box.style.fontFamily;
        if (box.style.width) d.width = parseFloat(box.style.width) / currentZoom;
        if (box.style.height) d.height = parseFloat(box.style.height) / currentZoom;
    }
}

function setupBoxEvents(box) {
    box.addEventListener('mousedown', (e) => {
        if (currentMode !== 'select') return;
        e.stopPropagation(); 
        if (box.classList.contains('editing-in-select')) return;
        const isResizing = (e.offsetX > box.clientWidth - 15) && (e.offsetY > box.clientHeight - 15);
        selectBox(box);
        if (!isResizing) {
            isDraggingBox = true; dragBoxStartX = e.clientX; dragBoxStartY = e.clientY;
            initialBoxLeft = box.offsetLeft; initialBoxTop = box.offsetTop;
        }
    });
    box.addEventListener('mouseup', (e) => {
        if (currentMode === 'select' && selectedBox === box) updateTextBoxData(box);
    });
    box.addEventListener('dblclick', (e) => {
        if (currentMode !== 'select') return;
        e.stopPropagation();
        box.contentEditable = 'true'; box.classList.remove('selected'); box.classList.add('editing-in-select'); box.focus();
    });
    box.addEventListener('blur', () => {
        if (box.classList.contains('editing-in-select')) box.classList.remove('editing-in-select');
        if (box.innerText.trim() === '') {
            const idx = parseInt(box.dataset.idx);
            if (!isNaN(idx) && pageDrawings[selectedPageIndex]) {
                pageDrawings[selectedPageIndex].splice(idx, 1);
            }
            box.remove();
            if (selectedBox === box) { selectedBox = null; hideTextPopup(); }
            redrawCanvas();
            saveState();
        } else {
            updateTextBoxData(box);
            saveState(); 
        }
    });
}

function createNewTextBox(x, y) {
    const div = document.createElement('div');
    div.className = 'text-box'; div.contentEditable = true;
    div.style.left = x + 'px'; div.style.top = y + 'px';
    div.style.color = activeColor; div.style.fontFamily = activeFont;
    div.style.fontSize = (activeFontSize * currentZoom) + 'px';
    div.style.zIndex = 1000;
    const rotation = pageRotations[selectedPageIndex] || 0;
    if (rotation !== 0) { div.style.transform = `rotate(${rotation}deg)`; div.style.transformOrigin = 'top left'; }
    div.addEventListener('blur', () => { if (activeTextBox === div) { forceSaveActiveBox(); redrawCanvas(); } });
    canvasBox.appendChild(div);
    activeTextBox = div;
    setTimeout(() => div.focus(), 0);
    showTextPopup(x, y);
}

function renderTextBoxes() {
    const existing = document.querySelectorAll('.text-box');
    existing.forEach(b => b.remove());
    activeTextBox = null; 
    const drawings = pageDrawings[selectedPageIndex];
    if (!drawings) return;
    const rotation = pageRotations[selectedPageIndex] || 0;
    drawings.forEach((d, idx) => {
        if (d.type === 'text') {
            const screenPt = toCanvas(d.x, d.y);
            const div = document.createElement('div');
            div.className = 'text-box'; div.innerText = d.text;
            div.style.left = screenPt.x + 'px'; div.style.top = screenPt.y + 'px';
            div.style.color = d.color; div.style.fontFamily = d.fontFamily;
            div.style.fontSize = (d.fontSize * currentZoom) + 'px';
            if (d.width) div.style.width = (d.width * currentZoom) + 'px';
            if (d.height) div.style.height = (d.height * currentZoom) + 'px';
            div.dataset.idx = idx; 
            if (rotation !== 0) { div.style.transform = `rotate(${rotation}deg)`; div.style.transformOrigin = 'top left'; }
            setupBoxEvents(div);
            canvasBox.appendChild(div);
        }
    });
}

function showTextPopup(x, y) {
    if (!textPopup) return;
    if(popupFontSelect) popupFontSelect.value = activeFont;
    if(popupSizeInput) popupSizeInput.value = activeFontSize;
    canvasBox.appendChild(textPopup);
    textPopup.style.display = 'flex'; textPopup.style.position = 'absolute';
    textPopup.style.transform = 'none'; textPopup.style.left = x + 'px'; textPopup.style.top = (y - 45) + 'px';
}
function hideTextPopup() { if (textPopup) textPopup.style.display = 'none'; }
function clearAllTextBoxes() {
    document.querySelectorAll('.text-box').forEach(b => b.remove());
    activeTextBox = null; selectedBox = null; hideTextPopup();
}

// --- DELETE MULTIPLE PAGES ---
function deleteSelectedPages() {
    const selectedCards = document.querySelectorAll('.page-card.selected');
    if (selectedCards.length === 0) return;
    if (document.querySelectorAll('.page-card').length <= selectedCards.length) {
        alert("Cannot delete all pages!");
        return;
    }
    
    if (confirm(`Are you sure you want to delete ${selectedCards.length} page(s)?`)) {
        selectedCards.forEach(card => card.remove());
        updateSidebarPageNumbers();
        
        // Ensure we have a valid selection after delete
        const remaining = document.querySelectorAll('.page-card');
        if (remaining.length > 0) {
            selectPage(parseInt(remaining[0].dataset.originalIndex), false); 
        } else {
            emptyMsg.style.display = 'block';
        }
        saveState(); 
    }
}

// --- PAN LOGIC ---
function startPan(e) { isPanning = true; panStartX = e.clientX; panStartY = e.clientY; panScrollLeft = previewWrapper.scrollLeft; panScrollTop = previewWrapper.scrollTop; mainCanvas.style.cursor = 'grabbing'; previewWrapper.style.cursor = 'grabbing'; }
function doPan(e) { if (!isPanning) return; e.preventDefault(); const dx = e.clientX - panStartX; const dy = e.clientY - panStartY; previewWrapper.scrollLeft = panScrollLeft - dx; previewWrapper.scrollTop = panScrollTop - dy; }
function endPan() { isPanning = false; mainCanvas.style.cursor = 'grab'; previewWrapper.style.cursor = 'grab'; }

// --- SELECT/MOVE SHAPE LOGIC ---
function startSelect(cx, cy, isMultiSelect) {
    const pdfPt = toPdf(cx, cy);
    const drawings = pageDrawings[selectedPageIndex] || [];
    if (selectedIndices.size === 1) {
        const idx = Array.from(selectedIndices)[0];
        const d = drawings[idx];
        if (d && d.type !== 'text') {
            const handle = getHandleHit(d, pdfPt.x, pdfPt.y);
            if (handle) {
                isDraggingShape = true; dragAction = handle; startX = pdfPt.x; startY = pdfPt.y;
                dragStartShapeState = JSON.parse(JSON.stringify(d)); dragStartShapeState.bounds = getShapeBounds(d);
                return;
            }
        }
    }
    let hitIndex = -1;
    for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        if (d.type === 'text') continue; 
        if (hitTestShape(d, pdfPt.x, pdfPt.y)) { hitIndex = i; break; }
    }
    if (hitIndex !== -1) {
        if (selectedIndices.has(hitIndex)) {
            if (isMultiSelect) { selectedIndices.delete(hitIndex); isDraggingShape = false; } 
            else { isDraggingShape = true; dragAction = 'move'; }
        } else {
            if (!isMultiSelect) selectedIndices.clear();
            selectedIndices.add(hitIndex);
            isDraggingShape = true; dragAction = 'move';
        }
        startX = pdfPt.x; startY = pdfPt.y;
    } else {
        if (!isMultiSelect) selectedIndices.clear();
        isBoxSelecting = true; selectionBoxStart = { x: cx, y: cy }; selectionBoxCurrent = { x: cx, y: cy };
    }
    redrawCanvas();
}

function endBoxSelect() {
    const pdfStart = toPdf(selectionBoxStart.x, selectionBoxStart.y);
    const pdfEnd = toPdf(selectionBoxCurrent.x, selectionBoxCurrent.y);
    const minX = Math.min(pdfStart.x, pdfEnd.x); const maxX = Math.max(pdfStart.x, pdfEnd.x);
    const minY = Math.min(pdfStart.y, pdfEnd.y); const maxY = Math.max(pdfStart.y, pdfEnd.y);
    const drawings = pageDrawings[selectedPageIndex] || [];
    drawings.forEach((d, idx) => {
        if (d.type === 'text') return; 
        const bounds = getShapeBounds(d);
        if (bounds.x < maxX && (bounds.x + bounds.w) > minX && bounds.y < maxY && (bounds.y + bounds.h) > minY) {
            selectedIndices.add(idx);
        }
    });
    const textBoxes = document.querySelectorAll('.text-box');
    const screenStart = toCanvas(minX, minY); const screenEnd = toCanvas(maxX, maxY);
    const selectRect = {
        left: Math.min(selectionBoxStart.x, selectionBoxCurrent.x),
        top: Math.min(selectionBoxStart.y, selectionBoxCurrent.y),
        right: Math.max(selectionBoxStart.x, selectionBoxCurrent.x),
        bottom: Math.max(selectionBoxStart.y, selectionBoxCurrent.y)
    };
    textBoxes.forEach(box => {
        const boxRect = { left: box.offsetLeft, top: box.offsetTop, right: box.offsetLeft + box.offsetWidth, bottom: box.offsetTop + box.offsetHeight };
        const isIntersecting = !(boxRect.right < selectRect.left || boxRect.left > selectRect.right || boxRect.bottom < selectRect.top || boxRect.top > selectRect.bottom);
        if (isIntersecting) selectBox(box);
    });
    redrawCanvas();
}

function doMoveShape(cx, cy) {
    if (selectedIndices.size === 0) return;
    const pdfPt = toPdf(cx, cy);
    const drawings = pageDrawings[selectedPageIndex];
    const dx = pdfPt.x - startX;
    const dy = pdfPt.y - startY;
    if (dragAction === 'move') {
        selectedIndices.forEach(idx => {
            const d = drawings[idx];
            if (!d || d.type === 'text') return;
            if (d.type === 'line' || d.type === 'arrow' || d.type === 'rect' || d.type === 'ellipse') {
                d.startX += dx; d.startY += dy; d.endX += dx; d.endY += dy;
            } else if (d.type === 'freehand') {
                d.points.forEach(p => { p.x += dx; p.y += dy; });
            }
        });
        startX = pdfPt.x; startY = pdfPt.y;
    } else if (selectedIndices.size === 1) {
        const idx = Array.from(selectedIndices)[0];
        const d = drawings[idx];
        if (d && d.type !== 'text') {
            if (d.type === 'line' || d.type === 'arrow') {
                 if(dragAction === 'start') { d.startX += dx; d.startY += dy; } 
                 else { d.endX += dx; d.endY += dy; }
            } else if (d.type === 'rect' || d.type === 'ellipse') {
                if(dragAction === 'tl') { d.startX+=dx; d.startY+=dy; } else if(dragAction==='tr') { d.endX+=dx; d.startY+=dy; }
                else if(dragAction === 'bl') { d.startX+=dx; d.endY+=dy; } else if(dragAction==='br') { d.endX+=dx; d.endY+=dy; }
            }
            startX = pdfPt.x; startY = pdfPt.y;
        }
    }
    redrawCanvas();
}

function deleteSelectedShapes() {
    if (!pageDrawings[selectedPageIndex]) return;
    const indicesToDelete = Array.from(selectedIndices).sort((a, b) => b - a);
    indicesToDelete.forEach(idx => {
        pageDrawings[selectedPageIndex].splice(idx, 1);
    });
    selectedIndices.clear();
    redrawCanvas();
    saveState(); 
}

// ... (getHandleHit, hitTestShape, etc. - keep same) ...
function getHandleHit(d, x, y) {
    if(d.type === 'text') return null;
    const dist = 10 / currentZoom; 
    let b = null;
    if (d.type === 'freehand') {
        const bounds = getShapeBounds(d);
        b = { tl: {x: bounds.x, y: bounds.y}, tr: {x: bounds.x + bounds.w, y: bounds.y}, bl: {x: bounds.x, y: bounds.y + bounds.h}, br: {x: bounds.x + bounds.w, y: bounds.y + bounds.h} };
    } else if (d.type === 'rect' || d.type === 'ellipse') {
        const minX = Math.min(d.startX, d.endX), maxX = Math.max(d.startX, d.endX);
        const minY = Math.min(d.startY, d.endY), maxY = Math.max(d.startY, d.endY);
        b = { tl: {x: minX, y: minY}, tr: {x: maxX, y: minY}, bl: {x: minX, y: maxY}, br: {x: maxX, y: maxY} };
    } else if (d.type === 'line' || d.type === 'arrow') {
        if (Math.abs(x - d.startX) < dist && Math.abs(y - d.startY) < dist) return 'start';
        if (Math.abs(x - d.endX) < dist && Math.abs(y - d.endY) < dist) return 'end';
        return null;
    }
    if (b) {
        if (Math.abs(x - b.tl.x) < dist && Math.abs(y - b.tl.y) < dist) return 'tl';
        if (Math.abs(x - b.tr.x) < dist && Math.abs(y - b.tr.y) < dist) return 'tr';
        if (Math.abs(x - b.bl.x) < dist && Math.abs(y - b.bl.y) < dist) return 'bl';
        if (Math.abs(x - b.br.x) < dist && Math.abs(y - b.br.y) < dist) return 'br';
    }
    return null;
}

function hitTestShape(d, x, y) {
    if(d.type === 'text') return false;
    const hitDist = 10 / currentZoom; 
    if (d.type === 'line' || d.type === 'arrow') {
        return pointToLineDistance(x, y, d.startX, d.startY, d.endX, d.endY) < hitDist;
    } else if (d.type === 'rect') {
        const minX = Math.min(d.startX, d.endX); const maxX = Math.max(d.startX, d.endX);
        const minY = Math.min(d.startY, d.endY); const maxY = Math.max(d.startY, d.endY);
        if (x >= minX - hitDist && x <= maxX + hitDist && y >= minY - hitDist && y <= maxY + hitDist) {
            return (Math.abs(y - minY) < hitDist || Math.abs(y - maxY) < hitDist || Math.abs(x - minX) < hitDist || Math.abs(x - maxX) < hitDist);
        }
    } else if (d.type === 'ellipse') {
        const cx = (d.startX+d.endX)/2, cy = (d.startY+d.endY)/2;
        const rx = Math.abs(d.endX-d.startX)/2, ry = Math.abs(d.endY-d.startY)/2;
        if (rx <= 0 || ry <= 0) return false;
        const val = (Math.pow(x - cx, 2) / Math.pow(rx, 2)) + (Math.pow(y - cy, 2) / Math.pow(ry, 2));
        return val <= 1.2; 
    } else if (d.type === 'freehand') {
        for (let j = 0; j < d.points.length - 1; j++) {
            if (pointToLineDistance(x, y, d.points[j].x, d.points[j].y, d.points[j+1].x, d.points[j+1].y) < hitDist) return true;
        }
    }
    return false;
}
function pointToLineDistance(px, py, x1, y1, x2, y2) { const A = px - x1; const B = py - y1; const C = x2 - x1; const D = y2 - y1; const dot = A * C + B * D; const len_sq = C * C + D * D; let param = -1; if (len_sq != 0) param = dot / len_sq; let xx, yy; if (param < 0) { xx = x1; yy = y1; } else if (param > 1) { xx = x2; yy = y2; } else { xx = x1 + param * C; yy = y1 + param * D; } const dx = px - xx; const dy = py - yy; return Math.sqrt(dx * dx + dy * dy); }

// --- DRAWING FUNCTIONS ---
function startDraw(e, pos) {
    if (!drawTool || drawTool === 'text') return; 
    const pdfPt = toPdf(pos.x, pos.y);
    if (drawTool === 'eraser') { eraseAt(pdfPt.x, pdfPt.y); return; }
    isDrawing = true; startX = pdfPt.x; startY = pdfPt.y;
    tempImageData = mainCanvas.getContext('2d').getImageData(0, 0, mainCanvas.width, mainCanvas.height);
    if (drawTool === 'freehand') {
        if (!pageDrawings[selectedPageIndex]) pageDrawings[selectedPageIndex] = [];
        pageDrawings[selectedPageIndex].push({ type: 'freehand', color: activeColor, width: activeWidth, points: [{x: startX, y: startY}] });
    }
}

function doDraw(e, pos) {
    if (!drawTool || !isDrawing) return;
    const pdfPt = toPdf(pos.x, pos.y);
    if (drawTool === 'eraser') { eraseAt(pdfPt.x, pdfPt.y); return; }
    const ctx = mainCanvas.getContext('2d');
    if (drawTool === 'freehand') {
        const drawings = pageDrawings[selectedPageIndex];
        const path = drawings[drawings.length - 1];
        path.points.push({x: pdfPt.x, y: pdfPt.y});
        const prev = path.points[path.points.length-2];
        const p1 = toCanvas(prev.x, prev.y); const p2 = toCanvas(pdfPt.x, pdfPt.y);
        ctx.save(); ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = activeColor; ctx.lineWidth = activeWidth * currentZoom; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
    } else {
        ctx.putImageData(tempImageData, 0, 0);
        const s = toCanvas(startX, startY); const e = toCanvas(pdfPt.x, pdfPt.y);
        ctx.save(); ctx.beginPath(); ctx.strokeStyle = activeColor; ctx.lineWidth = activeWidth * currentZoom; 
        if (drawTool === 'line') { ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke(); } 
        else if (drawTool === 'arrow') { drawArrow(ctx, s.x, s.y, e.x, e.y); } 
        else if (drawTool === 'rect') { ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y); } 
        else if (drawTool === 'ellipse') { 
            const cx = (s.x+e.x)/2, cy = (s.y+e.y)/2; const rx = Math.abs(e.x-s.x)/2, ry = Math.abs(e.y-s.y)/2;
            ctx.ellipse(cx, cy, rx, ry, 0, 0, 2*Math.PI); ctx.stroke();
        }
        ctx.restore();
    }
}

function endDraw(e) {
    if (!isDrawing) return;
    isDrawing = false; 
    if (!drawTool || drawTool === 'eraser') return;
    if (drawTool !== 'freehand') {
        const pos = getMousePos(e);
        const pdfPt = toPdf(pos.x, pos.y);
        if (!pageDrawings[selectedPageIndex]) pageDrawings[selectedPageIndex] = [];
        pageDrawings[selectedPageIndex].push({
            type: drawTool, color: activeColor, width: activeWidth,
            startX: startX, startY: startY, endX: pdfPt.x, endY: pdfPt.y
        });
    }
    redrawCanvas();
    saveState(); // Save after draw
}

function eraseAt(x, y) {
    if (checkEraserHit(x, y)) { redrawCanvas(); saveState(); } // Save after erase
}
function checkEraserHit(x, y) {
    const drawings = pageDrawings[selectedPageIndex];
    if (!drawings) return false;
    let deleted = false;
    for (let i = drawings.length - 1; i >= 0; i--) {
        if (drawings[i].type === 'text') continue;
        if (hitTestShape(drawings[i], x, y)) { drawings.splice(i, 1); deleted = true; break; }
    }
    return deleted;
}
function drawArrow(ctx, fromx, fromy, tox, toy) {
    const headlen = 10 * (activeWidth * currentZoom / 3 + 0.5); const angle = Math.atan2(toy - fromy, tox - fromx);
    const lineEndX = tox - headlen * Math.cos(angle) * 0.8; const lineEndY = toy - headlen * Math.sin(angle) * 0.8;
    ctx.beginPath(); ctx.moveTo(fromx, fromy); ctx.lineTo(lineEndX, lineEndY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
}

// --- APP LOGIC (UPDATED ZOOM & SCROLL) ---
if (previewWrapper) {
    // Ngăn chặn sự kiện wheel mặc định để kiểm soát zoom và chuyển trang
    previewWrapper.addEventListener('wheel', (e) => {
        // Zoom với Ctrl
        if (e.ctrlKey) {
            e.preventDefault();

            // Sửa logic Zoom lấy con trỏ làm tâm (Relative to Content)
            const rect = canvasBox.getBoundingClientRect(); // Lấy rect của nội dung, không phải wrapper
            
            // Tính toán vị trí chuột so với góc trên trái của nội dung (Content coordinates)
            // Lưu ý: rect.left/top đã bao gồm scroll của wrapper rồi
            const mouseX_Rel = e.clientX - rect.left;
            const mouseY_Rel = e.clientY - rect.top;

            const oldZoom = currentZoom;
            const direction = e.deltaY < 0 ? 1 : -1;
            
            // Sử dụng hàm helper để lấy mức zoom cố định tiếp theo
            let newZoom = getNextZoomLevel(currentZoom, direction);

            if (newZoom !== oldZoom) {
                currentZoom = newZoom;
                
                // Gọi updateMainCanvas nhưng không set isPdfRendered = false vội
                // Để canvas cũ vẫn hiển thị trong lúc chờ render mới
                updateMainCanvas(selectedPageIndex).then(() => {
                    // Logic điều chỉnh scroll để giữ nguyên vị trí chuột trên nội dung
                    // Công thức: Mới_Scroll = Cũ_Scroll + (Chuột_Trên_Nội_Dung_Mới - Chuột_Trên_Nội_Dung_Cũ)
                    // Chuột_Trên_Nội_Dung_Mới = Chuột_Trên_Nội_Dung_Cũ * (NewZoom / OldZoom)
                    
                    const scaleFactor = newZoom / oldZoom;
                    
                    // Độ lệch cần điều chỉnh thêm vào scroll hiện tại
                    const deltaX = (mouseX_Rel * scaleFactor) - mouseX_Rel;
                    const deltaY = (mouseY_Rel * scaleFactor) - mouseY_Rel;
                    
                    previewWrapper.scrollLeft += deltaX;
                    previewWrapper.scrollTop += deltaY;
                    
                    // Cập nhật UI thanh zoom
                    updateZoomUI();
                });
            }
        } else {
            // Logic cuộn trang
            const scrollTop = previewWrapper.scrollTop;
            const scrollHeight = previewWrapper.scrollHeight;
            const clientHeight = previewWrapper.clientHeight;
            
            const isAtTop = scrollTop <= 1;
            const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

            if (e.deltaY > 0) { // Lăn xuống
                if (!isAtBottom) return; 
                else {
                    e.preventDefault();
                    if (scrollTimeout) return;
                    if (selectedPageIndex < totalPages - 1) {
                        changePage(1);
                        setTimeout(() => { previewWrapper.scrollTop = 0; }, 50);
                    }
                    scrollTimeout = setTimeout(() => { scrollTimeout = null; }, 200); 
                }
            } else { // Lăn lên
                if (!isAtTop) return; 
                else {
                    e.preventDefault();
                    if (scrollTimeout) return;
                    if (selectedPageIndex > 0) {
                        changePage(-1);
                        setTimeout(() => { previewWrapper.scrollTop = 0; }, 50);
                    }
                    scrollTimeout = setTimeout(() => { scrollTimeout = null; }, 200);
                }
            }
        }
    }, { passive: false });
}

// --- NEW MULTI-SELECT SIDEBAR LOGIC ---
async function selectPage(idx, addToSelection = false, isRange = false) {
    if (idx < 0 || idx >= totalPages && totalPages > 0) return;
    
    // Clear DOM boxes of prev page
    forceSaveActiveBox();
    clearAllTextBoxes();

    const allCards = document.querySelectorAll('.page-card');

    if (!addToSelection && !isRange) {
        // Normal Click: Clear all, select one
        allCards.forEach(c => c.classList.remove('selected'));
        const card = document.getElementById(`card-${idx}`);
        if(card) card.classList.add('selected');
        lastSelectedCardIndex = idx;
    } else if (addToSelection) {
        // Ctrl+Click: Toggle
        const card = document.getElementById(`card-${idx}`);
        if(card) {
            if(card.classList.contains('selected')) {
                // Prevent deselecting the only selected page (optional UX choice)
                if(document.querySelectorAll('.page-card.selected').length > 1) {
                    card.classList.remove('selected');
                }
            } else {
                card.classList.add('selected');
                lastSelectedCardIndex = idx;
            }
        }
    } else if (isRange) {
        // Shift+Click: Range
        const start = lastSelectedCardIndex !== -1 ? lastSelectedCardIndex : idx;
        const end = idx;
        const domCards = Array.from(sidebarList.children);
        const startCard = document.getElementById(`card-${start}`);
        const endCard = document.getElementById(`card-${end}`);
        
        if (startCard && endCard) {
            const startPos = domCards.indexOf(startCard);
            const endPos = domCards.indexOf(endCard);
            
            const p1 = Math.min(startPos, endPos);
            const p2 = Math.max(startPos, endPos);
            
            allCards.forEach(c => c.classList.remove('selected'));
            for(let i=p1; i<=p2; i++) {
                domCards[i].classList.add('selected');
            }
        }
    }

    selectedPageIndex = idx; // Main canvas shows the last clicked page
    emptyMsg.style.display = 'none'; 
    isPdfRendered = false; 
    updatePageNavDisplay(); // Cập nhật số trang hiển thị
    
    // Reset cuộn về đầu trang khi chuyển trang
    if (previewWrapper) previewWrapper.scrollTop = 0;

    await updateMainCanvas(idx);
    
    // Scroll selection into view if needed
    const card = document.getElementById(`card-${idx}`);
    if(card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function highlightSelectedPages() {
    // Only needed if we restore state and need to check what should be selected.
    // In this app, we simply select selectedPageIndex on restore.
    const card = document.getElementById(`card-${selectedPageIndex}`);
    if(card) {
        document.querySelectorAll('.page-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        updatePageNavDisplay();
    }
}

// --- UPDATE MAIN CANVAS (ANTI-FLICKER VERSION) ---
async function updateMainCanvas(idx) {
    if (!pdfDoc) return;
    
    const page = await pdfDoc.getPage(idx + 1);
    const totalRotation = (page.rotate + pageRotations[idx]) % 360;
    const viewport = page.getViewport({ scale: currentZoom, rotation: totalRotation });
    currentViewport = viewport;

    // Hủy render cũ nếu có
    if (renderTask) {
        try { await renderTask.cancel(); } catch (e) {}
    }

    // 1. Render vào Canvas ẩn (bgCanvas) thay vì mainCanvas ngay lập tức
    // Lưu ý: bgCanvas ở đây đóng vai trò là Buffer
    // Tuy nhiên biến toàn cục bgCanvas đang được redrawCanvas dùng để vẽ
    // Nên ta cần tạo một renderCanvas tạm thời hoặc sử dụng bgCanvas nhưng không resize mainCanvas vội
    
    // Tạo canvas tạm để render (tránh ảnh hưởng bgCanvas hiện tại đang hiển thị)
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = viewport.width;
    renderCanvas.height = viewport.height;
    const renderCtx = renderCanvas.getContext('2d');

    renderTask = page.render({ canvasContext: renderCtx, viewport });
    
    try {
        await renderTask.promise;
        isPdfRendered = true;

        // 2. Render xong mới cập nhật bgCanvas và mainCanvas (Hoán đổi buffer)
        bgCanvas.width = viewport.width;
        bgCanvas.height = viewport.height;
        bgContext.drawImage(renderCanvas, 0, 0);

        // Resize mainCanvas lúc này mới an toàn, không bị nháy trắng
        mainCanvas.width = viewport.width;
        mainCanvas.height = viewport.height;
        mainCanvas.style.transform = 'none';
        
        redrawCanvas();
    } catch (error) {
        // Bỏ qua lỗi hủy render
        if (error.name !== 'RenderingCancelledException') {
            console.error(error);
        }
    }
}

function redrawCanvas() {
    if (!isPdfRendered) return;
    const ctx = mainCanvas.getContext('2d');
    ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    // Vẽ từ bgCanvas (đã chứa ảnh PDF hoàn chỉnh)
    ctx.drawImage(bgCanvas, 0, 0);
    
    const drawings = pageDrawings[selectedPageIndex];
    if (drawings) {
        drawings.forEach((d, idx) => {
            if (d.type === 'text') return; 
            ctx.beginPath();
            if (currentMode === 'select' && selectedIndices.has(idx)) { ctx.shadowColor = '#2563eb'; ctx.shadowBlur = 5; } 
            else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
            ctx.strokeStyle = d.color; ctx.lineWidth = d.width * currentZoom; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.fillStyle = d.color;
            if (d.type === 'freehand') {
                if (d.points.length > 0) {
                    const start = toCanvas(d.points[0].x, d.points[0].y);
                    ctx.moveTo(start.x, start.y);
                    for(let i=1; i<d.points.length; i++) {
                        const p = toCanvas(d.points[i].x, d.points[i].y);
                        ctx.lineTo(p.x, p.y);
                    }
                    ctx.stroke();
                }
            } else {
                const s = toCanvas(d.startX, d.startY); const e = toCanvas(d.endX, d.endY);
                if (d.type === 'line') { ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke(); }
                else if (d.type === 'arrow') { drawArrow(ctx, s.x, s.y, e.x, e.y); }
                else if (d.type === 'rect') { ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y); }
                else if (d.type === 'ellipse') { 
                    const cx = (s.x+e.x)/2, cy = (s.y+e.y)/2; const rx = Math.abs(e.x-s.x)/2, ry = Math.abs(e.y-s.y)/2;
                    ctx.ellipse(cx, cy, rx, ry, 0, 0, 2*Math.PI); ctx.stroke();
                }
            }
            if (currentMode === 'select' && selectedIndices.has(idx)) {
                ctx.shadowBlur = 0; 
                const dh = (px, py) => {
                        const pt = toCanvas(px, py); const hs = 8; 
                        ctx.fillStyle='#fff'; ctx.strokeStyle='#2563eb'; ctx.lineWidth=1;
                        ctx.beginPath(); ctx.rect(pt.x-hs/2, pt.y-hs/2, hs, hs); ctx.fill(); ctx.stroke();
                };
                const b = getShapeBounds(d);
                if (d.type === 'freehand' || d.type === 'rect' || d.type === 'ellipse') { dh(b.x, b.y); dh(b.x + b.w, b.y); dh(b.x + b.w, b.y + b.h); dh(b.x, b.y + b.h); } 
                else if (d.type === 'line' || d.type === 'arrow') { dh(d.startX, d.startY); dh(d.endX, d.endY); }
            }
        });
    }
    renderTextBoxes();
    if (currentMode === 'select' && isBoxSelecting) {
        ctx.save(); ctx.fillStyle = "rgba(37, 99, 235, 0.1)"; ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1;
        const w = selectionBoxCurrent.x - selectionBoxStart.x; const h = selectionBoxCurrent.y - selectionBoxStart.y;
        ctx.fillRect(selectionBoxStart.x, selectionBoxStart.y, w, h); ctx.strokeRect(selectionBoxStart.x, selectionBoxStart.y, w, h); ctx.restore();
    }
}

// ... (Toggle functions keep same) ...
function toggleCursorPopup() { setMode('select'); cursorPopup.classList.toggle('show'); widthPopup.classList.remove('show'); colorPopup.classList.remove('show'); }
function toggleColorPopup() { colorPopup.classList.toggle('show'); widthPopup.classList.remove('show'); cursorPopup.classList.remove('show'); }
function toggleWidthPopup() { widthPopup.classList.toggle('show'); colorPopup.classList.remove('show'); cursorPopup.classList.remove('show'); }
function selectTool(tool) { setMode('draw', tool); cursorPopup.classList.remove('show'); colorPopup.classList.remove('show'); widthPopup.classList.remove('show'); }
function selectColor(color) { activeColor = color; document.getElementById('tool-color-btn').style.backgroundColor = color; colorPopup.classList.remove('show'); }
function setWidth(val) { activeWidth = parseInt(val); widthLabel.textContent = val + 'px'; }
document.addEventListener('click', (e) => { 
    if (!e.target.closest('#tool-cursor-btn') && !e.target.closest('#cursor-popup') && cursorPopup) cursorPopup.classList.remove('show'); 
    if (!e.target.closest('#tool-color-btn') && !e.target.closest('#color-popup') && colorPopup) colorPopup.classList.remove('show'); 
    if (!e.target.closest('#tool-width-btn') && !e.target.closest('#width-popup') && widthPopup) widthPopup.classList.remove('show'); 
});

async function handleFile(file) { 
    if (file.type !== 'application/pdf') return alert('Only PDF'); 
    showLoader(true); fileName = file.name; const ab = await file.arrayBuffer(); fileBytes = ab.slice(0); 
    pdfDoc = await pdfjsLib.getDocument({data:ab}).promise; totalPages = pdfDoc.numPages; 
    pageRotations = new Array(totalPages).fill(0); pageDrawings = {}; 
    await renderSidebar(); 
    saveState(); // Initial state
    uploadOverlay.style.display='none'; globalToolbar.style.display='flex'; editToolbar.style.display='flex'; 
    selectPage(0); showLoader(false); 
}

async function renderSidebar() { 
    sidebarList.innerHTML = ''; 
    for (let i = 1; i <= totalPages; i++) { 
        const page = await pdfDoc.getPage(i); 
        const card = document.createElement('div'); 
        card.className = 'page-card'; 
        card.dataset.originalIndex = i-1; 
        card.id = `card-${i-1}`; 
        
        // --- MULTI SELECT CLICK HANDLER ---
        card.onclick = (e) => { 
            if(!e.target.closest('.mini-rotate-btn')) {
                const idx = parseInt(card.dataset.originalIndex);
                selectPage(idx, e.ctrlKey, e.shiftKey); 
            }
        }; 
        
        const header = document.createElement('div'); header.className = 'card-header'; 
        const num = document.createElement('div'); num.className = 'page-number'; num.textContent = `${i}`; 
        const rotateBtn = document.createElement('button'); rotateBtn.className = 'mini-rotate-btn'; rotateBtn.innerHTML = '↻'; 
        rotateBtn.onclick = (e) => { 
            e.stopPropagation(); 
            rotatePage(i-1, 90); 
        }; 
        header.append(num, rotateBtn); 
        const thumbWrapper = document.createElement('div'); thumbWrapper.className = 'thumb-canvas-wrapper'; 
        const canvas = document.createElement('canvas'); canvas.id = `thumb-${i-1}`; 
        const viewport = page.getViewport({ scale: 0.25 }); canvas.width = viewport.width; canvas.height = viewport.height; 
        page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise; 
        thumbWrapper.appendChild(canvas); card.append(header, thumbWrapper); 
        sidebarList.appendChild(card); addDragEvents(card); 
    } 
}

function rotatePage(idx, deg) { 
    pageRotations[idx] += deg; 
    document.getElementById(`thumb-${idx}`).style.transform = `rotate(${pageRotations[idx]}deg)`; 
    if(selectedPageIndex===idx) { isPdfRendered = false; updateMainCanvas(idx); }
    saveState(); // Save after rotate
}
function rotateAll(deg) { for(let i=0; i<totalPages; i++) rotatePage(i, deg); saveState(); }
function changePage(d) { 
    const currentCard = document.querySelector('.page-card.selected');
    if (!currentCard) return;
    let targetCard;
    if (d > 0) targetCard = currentCard.nextElementSibling;
    else targetCard = currentCard.previousElementSibling;
    if (targetCard) targetCard.click();
}

// --- UPDATED CHANGE ZOOM WITH FIXED LEVELS ---
function changeZoom(d) { 
    // d là hướng: +0.2 hoặc -0.2 (từ nút bấm)
    // Chuyển đổi sang direction +1 hoặc -1
    const direction = d > 0 ? 1 : -1;
    const newZoom = getNextZoomLevel(currentZoom, direction);
    
    if(newZoom !== currentZoom){ 
        currentZoom = newZoom; 
        isPdfRendered = false; 
        updateMainCanvas(selectedPageIndex); 
        // Cập nhật UI thanh zoom
        updateZoomUI();
    } 
}

// --- DRAG & DROP MULTIPLE PAGES ---
function addDragEvents(card) {
    card.setAttribute('draggable', 'true'); 
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', handleDrop);
    card.addEventListener('dragend', handleDragEnd);
}

function handleDragStart(e) {
    // If dragging an item NOT in selection, select it solely
    if (!this.classList.contains('selected')) {
        selectPage(parseInt(this.dataset.originalIndex));
    }
    
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML); 
    
    // Visually mark all selected items as dragging
    document.querySelectorAll('.page-card.selected').forEach(c => {
        c.classList.add(c === this ? 'dragging' : 'multi-dragging');
    });
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        this.classList.add('drag-over-bottom'); return false;
    }
    if (document.querySelectorAll('.page-card.selected').length > 0 && this.classList.contains('selected')) {
        // Don't show drop targets on items being dragged
        return false;
    }
    
    const rect = this.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    this.classList.remove('drag-over-top');
    this.classList.remove('drag-over-bottom');
    if (offset < rect.height / 2) {
        this.classList.add('drag-over-top');
    } else {
        this.classList.add('drag-over-bottom');
    }
    return false;
}

function handleDragLeave(e) {
    if (this.contains(e.relatedTarget)) return;
    this.classList.remove('drag-over-top');
    this.classList.remove('drag-over-bottom');
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault(); 
    
    // Handle external files
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        const pdfFiles = files.filter(f => f.type === 'application/pdf');
        if (pdfFiles.length > 0) handleMergeMultipleFiles(pdfFiles);
        return false;
    }

    // Handle reordering internal pages
    if (dragSrcEl) {
        const selectedCards = document.querySelectorAll('.page-card.selected');
        const target = this;
        
        // If dropping onto itself or another selected card, do nothing
        if (target.classList.contains('selected')) return false;

        // Insert before or after based on drop position
        const insertBefore = target.classList.contains('drag-over-top');
        const referenceNode = insertBefore ? target : target.nextSibling;
        
        selectedCards.forEach(card => {
            if (referenceNode) {
                target.parentNode.insertBefore(card, referenceNode);
            } else {
                target.parentNode.appendChild(card);
            }
        });

        updateSidebarPageNumbers();
        saveState(); // Save after reorder
    }
    
    this.classList.remove('drag-over-top');
    this.classList.remove('drag-over-bottom');
    return false;
}

function handleDragEnd(e) {
    document.querySelectorAll('.page-card').forEach(c => {
        c.classList.remove('dragging');
        c.classList.remove('multi-dragging');
        c.classList.remove('drag-over-top');
        c.classList.remove('drag-over-bottom');
    });
    dragSrcEl = null; 
}

function updateSidebarPageNumbers() {
    const cards = document.querySelectorAll('.page-card');
    cards.forEach((card, index) => {
        const num = card.querySelector('.page-number');
        if (num) num.textContent = index + 1;
    });
    updatePageNavDisplay(); 
}

async function handleMergeMultipleFiles(files) {
    if (!fileBytes) return; 
    showLoader(true);
    try {
        const { PDFDocument } = PDFLib;
        const newPdfDoc = await PDFDocument.create();
        if (fileBytes) {
            const currentBytes = new Uint8Array(fileBytes);
            const currentPdf = await PDFDocument.load(currentBytes);
            const currentPages = await newPdfDoc.copyPages(currentPdf, currentPdf.getPageIndices());
            currentPages.forEach(page => newPdfDoc.addPage(page));
        }
        for (const file of files) {
            const buffer = await file.arrayBuffer();
            const incomingPdf = await PDFDocument.load(buffer);
            const incomingPages = await newPdfDoc.copyPages(incomingPdf, incomingPdf.getPageIndices());
            incomingPages.forEach(page => newPdfDoc.addPage(page));
        }
        const mergedBytes = await newPdfDoc.save();
        const finalBuffer = new Uint8Array(mergedBytes.length);
        finalBuffer.set(mergedBytes);
        fileBytes = finalBuffer;
        pdfDoc = await pdfjsLib.getDocument({data: fileBytes.slice(0)}).promise;
        const oldTotal = totalPages;
        totalPages = pdfDoc.numPages;
        const newPagesCount = totalPages - pageRotations.length; 
        for(let k=0; k<newPagesCount; k++) pageRotations.push(0);
        await renderSidebar();
        selectPage(oldTotal > 0 ? oldTotal : 0); 
        saveState(); // Save after merge
    } catch (error) { console.error(error); alert('Error merging PDF: ' + error.message); }
    showLoader(false);
}

// --- SAVE PDF ---
async function savePDF() { 
    if (!fileBytes) return; 
    forceSaveActiveBox();
    showLoader(true); 
    try { 
        const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib; 
        const srcDoc = await PDFDocument.load(fileBytes); 
        const newDoc = await PDFDocument.create(); 
        const cards = Array.from(document.querySelectorAll('.page-card')); 
        const indices = cards.map(c => parseInt(c.dataset.originalIndex)); 
        const copied = await newDoc.copyPages(srcDoc, indices); 
        const fontMap = { 
            'MS Gothic': await newDoc.embedFont(StandardFonts.Helvetica), 
            'MS Mincho': await newDoc.embedFont(StandardFonts.TimesRoman), 
            'Meiryo': await newDoc.embedFont(StandardFonts.Helvetica), 
            'Yu Gothic': await newDoc.embedFont(StandardFonts.Helvetica),
            'Arial': await newDoc.embedFont(StandardFonts.Helvetica),
            'Times New Roman': await newDoc.embedFont(StandardFonts.TimesRoman)
        }; 
        for (let i = 0; i < copied.length; i++) { 
            const page = copied[i]; const originalIdx = indices[i]; const {height} = page.getSize(); 
            const drawings = pageDrawings[originalIdx]; 
            const finalRotation = (page.getRotation().angle + pageRotations[originalIdx]) % 360;
            page.setRotation(degrees(finalRotation)); 
            if (drawings) { 
                drawings.forEach(d => { 
                    const color = rgb(parseInt(d.color.slice(1,3),16)/255, parseInt(d.color.slice(3,5),16)/255, parseInt(d.color.slice(5,7),16)/255); 
                    if (d.type === 'text') {
                        const font = fontMap[d.fontFamily] || fontMap['Arial'];
                        page.drawText(d.text, { x: d.x, y: height - d.y - d.fontSize, size: d.fontSize, font: font, color: color });
                    }
                    else if(d.type==='line') page.drawLine({ start: {x: d.startX, y: height-d.startY}, end: {x: d.endX, y: height-d.endY}, thickness: d.width, color });
                    else if(d.type==='rect') page.drawRectangle({ x: d.startX, y: height-d.startY-(d.endY-d.startY), width: d.endX-d.startX, height: d.endY-d.startY, borderColor: color, borderWidth: d.width });
                    else if(d.type==='ellipse') { 
                        const cx = (d.startX+d.endX)/2; const cy = height-(d.startY+d.endY)/2; const rx = Math.abs(d.endX-d.startX)/2; const ry = Math.abs(d.endY-d.startY)/2; 
                        page.drawEllipse({ x: cx, y: cy, xScale: rx, yScale: ry, borderColor: color, borderWidth: d.width }); 
                    } 
                    else if(d.type==='freehand' && d.points.length) { for(let k=0; k<d.points.length-1; k++) page.drawLine({ start: {x: d.points[k].x, y: height-d.points[k].y}, end: {x: d.points[k+1].x, y: height-d.points[k+1].y}, thickness: d.width, color }); }
                }); 
            } 
            newDoc.addPage(page); 
        } 
        const data = await newDoc.save(); 
        const blob = new Blob([data], {type: 'application/pdf'}); 
        const url = URL.createObjectURL(blob); 
        const a = document.createElement('a'); a.href=url; a.download=fileName.replace('.pdf','_edited.pdf'); a.click(); 
    } catch(e) { console.log(e); alert('Error saving: ' + e.message); } 
    showLoader(false); 
}

function resetApp() { if(confirm('Are you sure you want to reset?')) location.reload(); }
function showLoader(s) { if(loader) loader.style.display = s ? 'flex' : 'none'; }