import { env, pipeline } from './lib/transformers/transformers.js';

// Configure Transformers.js to work in Extension context
env.allowLocalModels = false; // We fetch the model from HF hub and let it cache in browser storage
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/transformers/');
env.backends.onnx.wasm.numThreads = 1;


// Keep track of active model
let currentModelId = 'Xenova/all-MiniLM-L6-v2';
let extractorInstance = null;
let isLoading = false;
let cachedElements = []; // [{ id, text, vector }]

// Singleton helper to load model
async function getExtractor(modelId = 'Xenova/all-MiniLM-L6-v2', onProgress = null) {
  if (currentModelId !== modelId) {
    extractorInstance = null;
    currentModelId = modelId;
  }
  
  if (extractorInstance === null) {
    isLoading = true;
    try {
      extractorInstance = await pipeline('feature-extraction', modelId, {
        progress_callback: (data) => {
          if (onProgress) onProgress(data);
        }
      });
    } finally {
      isLoading = false;
    }
  }
  return extractorInstance;
}

// PCA implementation to map high-dimensional vectors to 3D
function runPCA(vectors, targetDimensions = 3) {
  const N = vectors.length;
  if (N === 0) return [];
  const D = vectors[0].length;

  if (N < 3) {
    if (N === 1) {
      return [[0, 0, 0]];
    }
    if (N === 2) {
      // Return maximum contrast coordinates
      return [[-1, 0, 0], [1, 0, 0]];
    }
  }

  // 1. Mean-centering
  const mean = new Array(D).fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < D; j++) {
      mean[j] += vectors[i][j];
    }
  }
  for (let j = 0; j < D; j++) {
    mean[j] /= N;
  }

  const centered = [];
  for (let i = 0; i < N; i++) {
    const row = new Array(D);
    for (let j = 0; j < D; j++) {
      row[j] = vectors[i][j] - mean[j];
    }
    centered.push(row);
  }

  // 2. Covariance matrix (D x D)
  const cov = [];
  for (let i = 0; i < D; i++) {
    cov.push(new Array(D).fill(0));
  }
  for (let i = 0; i < D; i++) {
    for (let j = i; j < D; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += centered[k][i] * centered[k][j];
      }
      cov[i][j] = sum / N;
      cov[j][i] = cov[i][j]; // symmetric
    }
  }

  // 3. Power iteration to find top 3 eigenvectors
  const eigenvectors = [];
  let tempCov = cov;

  for (let dim = 0; dim < targetDimensions; dim++) {
    let v = new Array(D);
    for (let i = 0; i < D; i++) {
      v[i] = Math.random() * 2 - 1;
    }
    
    let norm = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
    v = v.map(val => val / (norm || 1));

    const maxIterations = 25;
    for (let iter = 0; iter < maxIterations; iter++) {
      const nextV = new Array(D).fill(0);
      for (let i = 0; i < D; i++) {
        for (let j = 0; j < D; j++) {
          nextV[i] += tempCov[i][j] * v[j];
        }
      }
      
      const nextNorm = Math.sqrt(nextV.reduce((sum, val) => sum + val * val, 0));
      v = nextV.map(val => val / (nextNorm || 1));
    }

    // Compute eigenvalue
    let eigenvalue = 0;
    const tempCovV = new Array(D).fill(0);
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        tempCovV[i] += tempCov[i][j] * v[j];
      }
      eigenvalue += v[i] * tempCovV[i];
    }

    eigenvectors.push(v);

    // Deflate covariance matrix
    const nextCov = [];
    for (let i = 0; i < D; i++) {
      nextCov.push(new Array(D));
      for (let j = 0; j < D; j++) {
        nextCov[i][j] = tempCov[i][j] - eigenvalue * v[i] * v[j];
      }
    }
    tempCov = nextCov;
  }

  // 4. Project centered data onto eigenvectors
  const projection = [];
  for (let i = 0; i < N; i++) {
    const proj = new Array(targetDimensions).fill(0);
    for (let d = 0; d < targetDimensions; d++) {
      for (let j = 0; j < D; j++) {
        proj[d] += centered[i][j] * eigenvectors[d][j];
      }
    }
    projection.push(proj);
  }

  return projection;
}

// Receive messages from Popup or Content Scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'LOAD_MODEL') {
    const modelId = message.modelId || currentModelId;
    
    getExtractor(modelId, (data) => {
      // Send progress to popup
      chrome.runtime.sendMessage({
        action: 'MODEL_PROGRESS',
        data: data
      }).catch(() => {
        // Suppress errors when popup is closed
      });
    }).then(() => {
      sendResponse({ status: 'success', message: `Model ${modelId} loaded successfully.` });
    }).catch((error) => {
      sendResponse({ status: 'error', message: error.message });
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.action === 'PROCESS_TEXTS') {
    const { elements, modelId } = message;
    
    if (!elements || elements.length === 0) {
      sendResponse({ status: 'error', message: 'No text elements provided.' });
      return;
    }
    
    const texts = elements.map(el => el.text);
    
    getExtractor(modelId || currentModelId)
      .then(async (extractor) => {
        // Run feature extraction (batch processing)
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        
        // Extract 2D array representation from flat tensor output
        const N = output.dims[0];
        const D = output.dims[1];
        const vectors = [];
        for (let i = 0; i < N; i++) {
          const start = i * D;
          const end = start + D;
          vectors.push(Array.from(output.data.subarray(start, end)));
        }
        
        // Cache vectors for semantic search
        cachedElements = elements.map((el, i) => ({
          id: el.id,
          text: el.text,
          vector: vectors[i]
        }));
        
        // Run PCA to project high-dimensional vectors to 3D
        const projection = runPCA(vectors, 3);
        
        // Calculate min and max bounds for normalization
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < projection.length; i++) {
          for (let d = 0; d < 3; d++) {
            if (projection[i][d] < min[d]) min[d] = projection[i][d];
            if (projection[i][d] > max[d]) max[d] = projection[i][d];
          }
        }
        
        // Map elements to color spaces (both HSL and RGB)
        const results = elements.map((el, i) => {
          const p = projection[i];
          
          // HSL Mapping
          const colorH = Math.round(360 * (p[0] - min[0]) / (max[0] - min[0] || 1));
          const colorS = Math.round(75 + 25 * (p[1] - min[1]) / (max[1] - min[1] || 1));
          const colorL = Math.round(45 + 25 * (p[2] - min[2]) / (max[2] - min[2] || 1));
          
          // RGB Mapping
          const colorR = Math.round(255 * (p[0] - min[0]) / (max[0] - min[0] || 1));
          const colorG = Math.round(255 * (p[1] - min[1]) / (max[1] - min[1] || 1));
          const colorB = Math.round(255 * (p[2] - min[2]) / (max[2] - min[2] || 1));
          
          return {
            id: el.id,
            text: el.text,
            hsl: { h: colorH, s: colorS, l: colorL },
            rgb: { r: colorR, g: colorG, b: colorB }
          };
        });
        
        // Calculate LexRank Centrality Score to find Key Insight
        let keyInsightText = 'No key concept extracted.';
        if (N > 0) {
          const scores = new Array(N).fill(0);
          for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
              if (i === j) continue;
              let sim = 0;
              for (let k = 0; k < D; k++) {
                sim += vectors[i][k] * vectors[j][k];
              }
              scores[i] += sim;
            }
          }
          
          let maxScoreIndex = 0;
          let maxScore = -Infinity;
          for (let i = 0; i < N; i++) {
            if (scores[i] > maxScore) {
              maxScore = scores[i];
              maxScoreIndex = i;
            }
          }
          if (elements[maxScoreIndex]) {
            keyInsightText = elements[maxScoreIndex].text;
          }
        }

        sendResponse({ status: 'success', results: results, keyInsight: keyInsightText });
      })
      .catch((error) => {
        sendResponse({ status: 'error', message: error.message });
      });
      
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'SEMANTIC_SEARCH') {
    const { query, modelId } = message;
    if (!query) {
      sendResponse({ status: 'error', message: 'No search query provided.' });
      return;
    }
    if (cachedElements.length === 0) {
      sendResponse({ status: 'error', message: 'No cached page embeddings. Scan the page first.' });
      return;
    }
    
    getExtractor(modelId || currentModelId)
      .then(async (extractor) => {
        const queryOutput = await extractor(query, { pooling: 'mean', normalize: true });
        const queryVector = Array.from(queryOutput.data);
        
        const results = cachedElements.map(el => {
          let score = 0;
          for (let i = 0; i < queryVector.length; i++) {
            score += queryVector[i] * el.vector[i];
          }
          return {
            id: el.id,
            text: el.text,
            score: score
          };
        });
        
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        
        sendResponse({ status: 'success', results: results });
      })
      .catch((error) => {
        sendResponse({ status: 'error', message: error.message });
      });
      
    return true; // Keep channel open for async response
  }
});
