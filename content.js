// Map to store original styles and HTML structure for restoring them later
let originalStyles = new Map();
let originalInnerHTMLs = new Map();
let lastResults = null;
let lastColorMode = 'hsl';
let lastStyleMode = 'background';
let lastOpacity = 0.4;
let lastKeyInsight = null;

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Traverse DOM and extract text-bearing elements based on granularity (words, sentences, paragraphs)
function extractTextElements(highlightMode = 'sentences') {
  // Clear any old semantic attributes and reset DOM first
  clearHeatmap();
  
  const elements = [];
  let idCounter = 0;
  const targets = [];
  
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: function(node) {
        const skipTags = [
          'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'PATH', 
          'TEXTAREA', 'INPUT', 'SELECT', 'PRE', 'CODE', 'HEAD', 
          'NAV', 'FOOTER', 'BUTTON', 'CANVAS', 'AUDIO', 'VIDEO'
        ];
        if (skipTags.includes(node.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip hidden elements
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Identify pure leaf text containers: has text child nodes, but NO element child nodes
        let hasDirectText = false;
        let hasElementChildren = false;
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
            hasDirectText = true;
          }
          if (child.nodeType === Node.ELEMENT_NODE) {
            hasElementChildren = true;
          }
        }
        
        if (hasDirectText && !hasElementChildren) {
          return NodeFilter.FILTER_ACCEPT;
        }
        
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let currentNode;
  while (currentNode = walker.nextNode()) {
    targets.push(currentNode);
  }
  
  // Modify the DOM safely after traversal is fully complete
  for (const node of targets) {
    const cleanText = node.textContent.replace(/\s+/g, ' ').trim();
    
    // Skip if empty or matches formatting filter
    if (cleanText.length <= 2 || /^[0-9\s\p{P}]+$/u.test(cleanText)) {
      continue;
    }
    
    // Backup original DOM layout of the container node
    if (!originalInnerHTMLs.has(node)) {
      originalInnerHTMLs.set(node, node.innerHTML);
    }
    
    if (highlightMode === 'paragraphs') {
      const semanticId = `sem-${idCounter++}`;
      node.setAttribute('data-semantic-id', semanticId);
      elements.push({
        id: semanticId,
        text: cleanText
      });
    } else if (highlightMode === 'sentences') {
      // Split cleanText on punctuation mark boundary
      const sentences = cleanText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 2);
      
      if (sentences.length === 0) continue;
      
      const wrappedHTML = sentences.map(s => {
        const semanticId = `sem-${idCounter++}`;
        elements.push({
          id: semanticId,
          text: s.trim()
        });
        return `<span data-semantic-id="${semanticId}">${escapeHTML(s)}</span>`;
      }).join(' ');
      
      node.innerHTML = wrappedHTML;
    } else if (highlightMode === 'words') {
      // Split on spacing
      const words = cleanText.split(/\s+/).filter(w => w.trim().length > 1);
      
      if (words.length === 0) continue;
      
      const wrappedHTML = words.map(w => {
        const semanticId = `sem-${idCounter++}`;
        elements.push({
          id: semanticId,
          text: w.trim()
        });
        return `<span data-semantic-id="${semanticId}">${escapeHTML(w)}</span>`;
      }).join('');
      
      node.innerHTML = wrappedHTML;
    }
  }
  
  return elements;
}

// Apply colors to the page using existing results
function applyColors(results, colorMode, styleMode, opacity) {
  lastResults = results;
  lastColorMode = colorMode;
  lastStyleMode = styleMode;
  lastOpacity = opacity;
  
  // If we haven't saved original styles for these, do it now
  results.forEach(res => {
    const el = document.querySelector(`[data-semantic-id="${res.id}"]`);
    if (!el) return;
    
    if (!originalStyles.has(el)) {
      originalStyles.set(el, {
        backgroundColor: el.style.backgroundColor,
        border: el.style.border,
        color: el.style.color,
        transition: el.style.transition,
        borderRadius: el.style.borderRadius,
        boxShadow: el.style.boxShadow
      });
    }
    
    // Set smooth transitions
    el.style.transition = 'background-color 0.4s ease, border-color 0.4s ease, color 0.4s ease';
    
    // Generate the CSS color string
    let colorString = '';
    if (colorMode === 'hsl') {
      const { h, s, l } = res.hsl;
      colorString = `hsla(${h}, ${s}%, ${l}%, ${opacity})`;
    } else {
      const { r, g, b } = res.rgb;
      colorString = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
    
    // Apply based on selected style mode
    if (styleMode === 'background') {
      // Restore other styles
      el.style.border = originalStyles.get(el).border;
      el.style.color = originalStyles.get(el).color;
      // Set background
      el.style.backgroundColor = colorString;
    } else if (styleMode === 'border') {
      // Restore other styles
      el.style.backgroundColor = originalStyles.get(el).backgroundColor;
      el.style.color = originalStyles.get(el).color;
      // Set border (vibrant solid border)
      const borderCSS = `3px solid ${colorString.replace(/[\d\.]+\)$/, '1)')}`; // full opacity for border
      el.style.border = borderCSS;
    } else if (styleMode === 'text') {
      // Restore other styles
      el.style.backgroundColor = originalStyles.get(el).backgroundColor;
      el.style.border = originalStyles.get(el).border;
      // Set text color (darker version of color for legibility)
      if (colorMode === 'hsl') {
        const { h, s } = res.hsl;
        el.style.color = `hsl(${h}, ${s}%, 35%)`; // darker L for text readability
      } else {
        // Darken RGB
        const { r, g, b } = res.rgb;
        el.style.color = `rgb(${Math.round(r * 0.75)}, ${Math.round(g * 0.75)}, ${Math.round(b * 0.75)})`;
      }
    }
  });
}

// Clear heatmap and restore original elements styling & DOM nodes
function clearHeatmap() {
  // First, restore split HTML blocks
  originalInnerHTMLs.forEach((html, container) => {
    try {
      if (document.body.contains(container)) {
        container.innerHTML = html;
      }
    } catch (e) {
      // Container might have been removed
    }
  });
  originalInnerHTMLs.clear();

  // Then restore original inline styles on other modified elements
  originalStyles.forEach((style, el) => {
    try {
      if (document.body.contains(el)) {
        el.style.backgroundColor = style.backgroundColor;
        el.style.border = style.border;
        el.style.color = style.color;
        el.style.transition = style.transition;
        el.style.borderRadius = style.borderRadius;
        el.style.boxShadow = style.boxShadow;
        el.removeAttribute('data-semantic-id');
      }
    } catch (e) {
      // Element might have been removed
    }
  });
  
  originalStyles.clear();
  lastResults = null;
}

// Apply search highlights on elements
function applySearchHighlights(results) {
  if (!document.getElementById('semantic-search-styles')) {
    const style = document.createElement('style');
    style.id = 'semantic-search-styles';
    style.textContent = `
      @keyframes semantic-pulse {
        0% { box-shadow: 0 0 6px rgba(245, 158, 11, 0.4); }
        50% { box-shadow: 0 0 16px rgba(245, 158, 11, 0.8); }
        100% { box-shadow: 0 0 6px rgba(245, 158, 11, 0.4); }
      }
      .semantic-search-match {
        animation: semantic-pulse 2s infinite ease-in-out !important;
        border-radius: 4px !important;
        outline: 2px solid rgba(245, 158, 11, 0.85) !important;
        transition: outline 0.3s ease, background-color 0.3s ease, opacity 0.3s ease, filter 0.3s ease !important;
      }
      .semantic-search-fade {
        opacity: 0.15 !important;
        filter: blur(0.5px) grayscale(50%) !important;
        transition: opacity 0.3s ease, filter 0.3s ease !important;
      }
      .semantic-search-flash {
        outline: 4px solid #3b82f6 !important;
        box-shadow: 0 0 24px #3b82f6 !important;
        transform: scale(1.02) !important;
        transition: all 0.3s ease !important;
      }
    `;
    document.head.appendChild(style);
  }

  const scoreMap = new Map();
  results.forEach(res => scoreMap.set(res.id, res.score));

  originalStyles.forEach((style, el) => {
    const semId = el.getAttribute('data-semantic-id');
    if (!semId) return;

    const score = scoreMap.get(semId) || 0;
    const threshold = 0.35; // Semantic similarity threshold for highlighting
    
    if (score > threshold) {
      el.classList.remove('semantic-search-fade');
      el.classList.add('semantic-search-match');
      
      const range = 1.0 - threshold;
      const intensity = 0.2 + 0.6 * ((score - threshold) / range); // [0.2, 0.8]
      
      el.style.backgroundColor = `rgba(245, 158, 11, ${intensity})`;
      el.style.border = 'none';
      el.style.color = '#000000'; // high contrast black text
      el.style.opacity = '1';
    } else {
      el.classList.remove('semantic-search-match');
      el.classList.add('semantic-search-fade');
      
      // Remove custom overlays, show original
      el.style.backgroundColor = style.backgroundColor;
      el.style.border = style.border;
      el.style.color = style.color;
    }
  });
}

// Clear search highlights
function clearSearchHighlights() {
  originalStyles.forEach((style, el) => {
    el.classList.remove('semantic-search-match', 'semantic-search-fade', 'semantic-search-flash');
  });
  
  if (lastResults) {
    applyColors(lastResults, lastColorMode, lastStyleMode, lastOpacity);
  } else {
    originalStyles.forEach((style, el) => {
      el.style.backgroundColor = style.backgroundColor;
      el.style.border = style.border;
      el.style.color = style.color;
    });
  }
}

// Scroll smoothly to a specific element and flash it
function scrollToElement(id) {
  const el = document.querySelector(`[data-semantic-id="${id}"]`);
  if (!el) return;
  
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  el.classList.add('semantic-search-flash');
  setTimeout(() => {
    el.classList.remove('semantic-search-flash');
  }, 1500);
}

// Consolidated Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'SCAN_DOM') {
    try {
      const elements = extractTextElements(message.highlightMode);
      sendResponse({ status: 'success', elements: elements });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'APPLY_COLORS') {
    try {
      lastKeyInsight = message.keyInsight || null;
      applyColors(message.results, message.colorMode, message.styleMode, message.opacity);
      sendResponse({ status: 'success' });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'UPDATE_STYLING') {
    try {
      if (lastResults) {
        applyColors(lastResults, message.colorMode, message.styleMode, message.opacity);
        sendResponse({ status: 'success' });
      } else {
        sendResponse({ status: 'error', message: 'No active heatmap to update.' });
      }
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'CLEAR_HEATMAP') {
    try {
      clearHeatmap();
      lastKeyInsight = null;
      sendResponse({ status: 'success' });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'APPLY_SEARCH_HIGHLIGHTS') {
    try {
      applySearchHighlights(message.results);
      sendResponse({ status: 'success' });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'CLEAR_SEARCH_HIGHLIGHTS') {
    try {
      clearSearchHighlights();
      sendResponse({ status: 'success' });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'SCROLL_TO_ELEMENT') {
    try {
      scrollToElement(message.id);
      sendResponse({ status: 'success' });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  } else if (message.action === 'GET_STATUS') {
    try {
      sendResponse({
        status: 'success',
        active: lastResults !== null,
        results: lastResults,
        keyInsight: lastKeyInsight,
        colorMode: lastColorMode,
        styleMode: lastStyleMode,
        opacity: lastOpacity
      });
    } catch (e) {
      sendResponse({ status: 'error', message: e.message });
    }
  }
  return true; // Keep message channel open for async response
});
