// DOM elements
const modelSelect = document.getElementById('model-select');
const highlightModeContainer = document.getElementById('highlight-mode-select');
const opacitySlider = document.getElementById('opacity-slider');
const opacityVal = document.getElementById('opacity-val');
const btnGenerate = document.getElementById('btn-generate');
const btnClear = document.getElementById('btn-clear');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const legendCard = document.getElementById('legend-card');
const elementsCount = document.getElementById('elements-count');
const analysisBadge = document.getElementById('analysis-badge');
const insightsText = document.getElementById('insights-text');

// Search DOM elements
const searchCard = document.getElementById('search-card');
const searchInput = document.getElementById('search-input');
const btnSearch = document.getElementById('btn-search');
const searchResultsContainer = document.getElementById('search-results-container');
const searchResultsList = document.getElementById('search-results-list');
const btnClearSearch = document.getElementById('btn-clear-search');

// State
let selectedHighlightMode = 'sentences';
let activeResults = null;
let activeKeyInsight = null;

// Initialize Settings and Listeners
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved preference configurations
  const settings = await chrome.storage.local.get([
    'model', 
    'highlightMode', 
    'opacity'
  ]);
  
  if (settings.model) modelSelect.value = settings.model;
  
  if (settings.highlightMode) {
    selectedHighlightMode = settings.highlightMode;
    updateSegmentedActive(highlightModeContainer, selectedHighlightMode);
  }
  
  if (settings.opacity) {
    opacitySlider.value = settings.opacity;
    opacityVal.textContent = `${Math.round(settings.opacity * 100)}%`;
  }

  // Get active tab and query its scanning status dynamically
  const tab = await getActiveTab();
  if (tab) {
    try {
      const response = await sendTabMessage(tab.id, { action: 'GET_STATUS' });
      if (response && response.status === 'success' && response.active) {
        activeResults = response.results;
        activeKeyInsight = response.keyInsight || 'No core concepts extracted.';
        
        // Restore Visual Elements
        legendCard.style.display = 'block';
        searchCard.style.display = 'block';
        elementsCount.textContent = activeResults.length;
        
        // Restore Badge & Status
        setAnalysisBadgeActive(true);
        updateProgressBar(100, 'Heatmap Active');
        
        // Restore Insights Text
        insightsText.textContent = activeKeyInsight;
      } else {
        // No active scan on this tab
        legendCard.style.display = 'none';
        searchCard.style.display = 'none';
        setAnalysisBadgeActive(false);
        updateProgressBar(0, 'Ready');
      }
    } catch (err) {
      // Content script not injected yet or tab loading
      legendCard.style.display = 'none';
      searchCard.style.display = 'none';
      setAnalysisBadgeActive(false);
      updateProgressBar(0, 'Ready');
    }
  }

  // Setup Event Listeners
  modelSelect.addEventListener('change', saveSettings);
  opacitySlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    opacityVal.textContent = `${Math.round(val * 100)}%`;
    saveSettings();
    updatePageStyling();
  });

  // Highlight Mode Granularity buttons listener
  setupSegmentedListener(highlightModeContainer, (val) => {
    selectedHighlightMode = val;
    saveSettings();
  });

  // Action Buttons
  btnGenerate.addEventListener('click', handleGenerate);
  btnClear.addEventListener('click', handleClear);
  
  // Search Buttons
  btnSearch.addEventListener('click', handleSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
  btnClearSearch.addEventListener('click', handleClearSearch);
});

// Setup Segmented Buttons Toggle
function setupSegmentedListener(container, callback) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    callback(btn.dataset.value);
  });
}

// Update Active Segment styling
function updateSegmentedActive(container, value) {
  container.querySelectorAll('button').forEach(b => {
    if (b.dataset.value === value) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
}

// Save Preferences to Local Storage
async function saveSettings() {
  await chrome.storage.local.set({
    model: modelSelect.value,
    highlightMode: selectedHighlightMode,
    opacity: parseFloat(opacitySlider.value)
  });
}

// Update highlighting opacity on active page (real-time slider drag feedback)
async function updatePageStyling() {
  const tab = await getActiveTab();
  if (!tab) return;
  
  chrome.tabs.sendMessage(tab.id, {
    action: 'UPDATE_STYLING',
    colorMode: 'hsl',
    styleMode: 'background',
    opacity: parseFloat(opacitySlider.value)
  }).catch(() => {
    // Fail silently if content script not injected yet
  });
}

// Send Message to Tab Helper
function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(response);
      }
    });
  });
}

// Scan DOM - Inject Content Script if necessary
async function executeScan(tabId) {
  try {
    return await sendTabMessage(tabId, { 
      action: 'SCAN_DOM', 
      highlightMode: selectedHighlightMode 
    });
  } catch (err) {
    // Dynamically inject script on older tabs
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      await new Promise(r => setTimeout(r, 150));
      return await sendTabMessage(tabId, { 
        action: 'SCAN_DOM', 
        highlightMode: selectedHighlightMode 
      });
    } catch (injectErr) {
      throw new Error('Script injection blocked on this page.');
    }
  }
}

// Listen to Model Download Progress from Background Service Worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'MODEL_PROGRESS') {
    const { data } = message;
    if (data.status === 'downloading') {
      const file = data.file || '';
      const percent = data.progress ? Math.round(data.progress) : 0;
      const cleanFileName = file.split('/').pop() || '';
      statusText.textContent = `Downloading ${cleanFileName.substring(0, 12)}... ${percent}%`;
      statusText.style.color = '#f59e0b';
      progressBar.style.width = `${percent}%`;
    } else if (data.status === 'done') {
      statusText.textContent = `Processing embeddings...`;
      statusText.style.color = '#3b82f6';
    }
  }
});

// Get Current Active Tab
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Generate Heatmap Trigger
async function handleGenerate() {
  const tab = await getActiveTab();
  if (!tab) {
    showError('No active tab found.');
    return;
  }

  // Prevent scripting on chrome system pages
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('https://chrome.google.com/webstore')) {
    showError('Visuals blocked on system pages.');
    return;
  }

  setUIState(true);
  updateProgressBar(10, 'Scanning webpage...');
  
  try {
    // 1. Scan page for text elements at selected granularity
    const scanResponse = await executeScan(tab.id);
    if (!scanResponse || scanResponse.status !== 'success') {
      throw new Error(scanResponse ? scanResponse.message : 'Failed to scan DOM.');
    }
    
    const elements = scanResponse.elements;
    if (elements.length === 0) {
      throw new Error('No text elements found to map.');
    }
    
    updateProgressBar(35, 'Initializing model...');
    
    // 2. Pre-load model to warm it up
    const modelId = modelSelect.value;
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'LOAD_MODEL', modelId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response && response.status === 'error') {
          reject(new Error(response.message));
        } else {
          resolve(response);
        }
      });
    });

    updateProgressBar(55, 'Extracting vectors...');

    // 3. Process text vectors in background worker
    const processResponse = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'PROCESS_TEXTS',
        elements,
        modelId,
        tabId: tab.id
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (response && response.status === 'error') {
          reject(new Error(response.message));
        } else {
          resolve(response);
        }
      });
    });

    updateProgressBar(90, 'Rendering heatmap...');
    activeResults = processResponse.results;
    activeKeyInsight = processResponse.keyInsight || 'No core concepts extracted.';
    
    // 4. Send colors back to page content script (Default to Background HSL heatmap)
    const applyResponse = await sendTabMessage(tab.id, {
      action: 'APPLY_COLORS',
      results: activeResults,
      keyInsight: activeKeyInsight,
      colorMode: 'hsl',
      styleMode: 'background',
      opacity: parseFloat(opacitySlider.value)
    });
    
    if (!applyResponse || applyResponse.status !== 'success') {
      throw new Error('Failed to paint colors onto the page.');
    }

    // Success! Update UI details
    updateProgressBar(100, 'Heatmap Active');
    setAnalysisBadgeActive(true);
    
    legendCard.style.display = 'block';
    searchCard.style.display = 'block';
    elementsCount.textContent = elements.length;
    insightsText.textContent = activeKeyInsight;
    
    await saveSettings();

  } catch (error) {
    showError(error.message);
  } finally {
    setUIState(false);
  }
}

// Clear Heatmap Trigger
async function handleClear() {
  const tab = await getActiveTab();
  if (!tab) return;
  
  setUIState(true);
  try {
    await sendTabMessage(tab.id, { action: 'CLEAR_HEATMAP' });
    
    // Reset State
    activeResults = null;
    activeKeyInsight = null;
    
    // Reset UI Card Displays
    legendCard.style.display = 'none';
    searchCard.style.display = 'none';
    searchResultsContainer.style.display = 'none';
    searchInput.value = '';
    searchResultsList.innerHTML = '';
    insightsText.textContent = 'Scan the page to identify the core concepts.';
    
    // Reset status & badge
    setAnalysisBadgeActive(false);
    updateProgressBar(0, 'Ready');
    
    await saveSettings();
  } catch (error) {
    console.error('Error clearing page styles:', error);
    // Force local state reset even if connection fails
    activeResults = null;
    activeKeyInsight = null;
    legendCard.style.display = 'none';
    searchCard.style.display = 'none';
    searchResultsContainer.style.display = 'none';
    setAnalysisBadgeActive(false);
    updateProgressBar(0, 'Ready');
    await saveSettings();
  } finally {
    setUIState(false);
  }
}

// Toggle Main UI elements disabled state
function setUIState(processing) {
  btnGenerate.disabled = processing;
  btnClear.disabled = processing;
  modelSelect.disabled = processing;
  searchInput.disabled = processing;
  btnSearch.disabled = processing;
  highlightModeContainer.querySelectorAll('button').forEach(b => b.disabled = processing);
}

// Toggle Search UI elements disabled state
function setSearchUIState(searching) {
  btnSearch.disabled = searching;
  searchInput.disabled = searching;
  btnClearSearch.disabled = searching;
  btnGenerate.disabled = searching;
  btnClear.disabled = searching;
}

// Update Progress Display
function updateProgressBar(percent, text) {
  progressBar.style.width = `${percent}%`;
  statusText.textContent = text;
  if (text.includes('Error')) {
    statusText.style.color = '#ef4444';
  } else if (percent === 100) {
    statusText.style.color = '#10b981';
  } else {
    statusText.style.color = '#3b82f6';
  }
}

// Show error helper
function showError(msg) {
  progressBar.style.width = '0%';
  statusText.textContent = `Error: ${msg}`;
  statusText.style.color = '#ef4444';
  setAnalysisBadgeActive(false);
}

// Set badge active/inactive
function setAnalysisBadgeActive(active) {
  if (active) {
    analysisBadge.textContent = 'ANALYSIS ACTIVE';
    analysisBadge.className = 'badge-active';
  } else {
    analysisBadge.textContent = 'INACTIVE';
    analysisBadge.className = 'badge-inactive';
  }
}

// Semantic Search Trigger
async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  const tab = await getActiveTab();
  if (!tab) return;

  setSearchUIState(true);
  updateProgressBar(50, 'Searching semantics...');

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'SEMANTIC_SEARCH',
        query: query,
        modelId: modelSelect.value,
        tabId: tab.id
      }, (res) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (res && res.status === 'error') {
          reject(new Error(res.message));
        } else {
          resolve(res);
        }
      });
    });

    const results = response.results;
    
    // Send highlight request to page content script
    const highlightResponse = await sendTabMessage(tab.id, {
      action: 'APPLY_SEARCH_HIGHLIGHTS',
      results: results
    });

    if (!highlightResponse || highlightResponse.status !== 'success') {
      throw new Error('Failed to highlight matches on page.');
    }

    // Display Top 5 Results in Popup
    searchResultsList.innerHTML = '';
    const topMatches = results.slice(0, 5);
    
    if (topMatches.length === 0 || topMatches[0].score < 0.35) {
      searchResultsList.innerHTML = '<div style="font-size: 11px; color: #64748b; text-align: center; padding: 10px; text-transform: uppercase;">No relevant matches found</div>';
    } else {
      topMatches.forEach(match => {
        const matchPercent = Math.round(match.score * 100);
        
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.style.marginBottom = '6px';
        item.innerHTML = `
          <span class="search-result-text" title="${match.text}">${match.text}</span>
          <span class="search-result-badge">${matchPercent}% match</span>
        `;
        
        // Scroll page to element on click
        item.addEventListener('click', async () => {
          await sendTabMessage(tab.id, {
            action: 'SCROLL_TO_ELEMENT',
            id: match.id
          });
        });
        
        searchResultsList.appendChild(item);
      });
    }

    searchResultsContainer.style.display = 'block';
    updateProgressBar(100, 'Search Completed');
    statusText.style.color = '#10b981';

  } catch (error) {
    showError(error.message);
  } finally {
    setSearchUIState(false);
  }
}

// Clear Search Highlight Trigger
async function handleClearSearch() {
  const tab = await getActiveTab();
  if (!tab) return;

  setSearchUIState(true);
  try {
    await sendTabMessage(tab.id, { action: 'CLEAR_SEARCH_HIGHLIGHTS' });
    searchInput.value = '';
    searchResultsContainer.style.display = 'none';
    searchResultsList.innerHTML = '';
    updateProgressBar(100, 'Heatmap Active');
    statusText.style.color = '#10b981';
  } catch (error) {
    console.error('Error clearing search highlights:', error);
  } finally {
    setSearchUIState(false);
  }
}
