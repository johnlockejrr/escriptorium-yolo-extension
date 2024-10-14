import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import labels from "./labels.json";

let model = null;
const inputSize = 960;
let ImageOriginalWidth = 0;
let ImageOriginalHeight = 0;
let modelFilesPath = '';
let modelFiles = []; 
const numClass = labels.length;
let typeMappings = {};

function displayMessage(message) {
  const statusMessages = document.getElementById('status-messages');
  statusMessages.innerHTML += `<p>${message} <span class="checkmark"></span></p>`;
  statusMessages.scrollTop = statusMessages.scrollHeight;
}

async function initializeBackend() {
  await tf.setBackend('webgl');
  await tf.ready();
  
  if (tf.getBackend() !== 'webgl') {
    console.warn('WebGL not supported, switching to CPU backend');
    await tf.setBackend('cpu');
  }
  console.log(`Backend initialized to ${tf.getBackend()}`);
}


async function loadModelFromFiles(files) {
  const modelFile = files.find(file => file.name.endsWith('model.json'));
  const weightFiles = files.filter(file => file.name.endsWith('.bin'));

  if (!modelFile || weightFiles.length === 0) {
    console.error('Model file or weight files are missing');
    alert('Please ensure the folder contains model.json and .bin files.');
    return;
  }

  console.log('Loading model from selected files...');
  model = await tf.loadGraphModel(tf.io.browserFiles([modelFile, ...weightFiles]));
  console.log('Model loaded successfully');
  displayMessage('Model loaded successfully');
  document.getElementById('annotate-button').disabled = false;

    // save the folder path in cache
    const folderPath = files[0].webkitRelativePath.split('/')[0];
    chrome.storage.local.set({ modelPath: folderPath }, () => {
      if (chrome.runtime.lastError) {
          console.error('Error caching model path:', chrome.runtime.lastError);
      } else {
          console.log('Model path cached successfully');
      }
  });  
    console.log('Model loaded and path cached:', folderPath);
  
    document.getElementById('model-path').textContent = folderPath; 
}

async function loadApiToken() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['apiToken'], (result) => {
      if (result.apiToken) {
        document.getElementById('api-token').value = result.apiToken;
      }
      resolve(result.apiToken);
    });
  });
}

async function saveApiToken(token) {
  chrome.storage.sync.set({ apiToken: token }, () => {
    console.log('API Token saved');
    displayMessage('API Token saved successfully!');
  });
}

async function cacheModelPath(path) {
  chrome.storage.sync.set({ modelFilesPath: path }, () => {
    console.log('Model folder path cached');
  });
}

async function loadCachedModelPath() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['modelFilesPath'], (result) => {
      modelFilesPath = result.modelFilesPath || '';
      resolve(modelFilesPath);
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadApiToken(); 
  await loadCachedModelPath();
});

document.getElementById('model-files').addEventListener('change', async (event) => {
  modelFiles = Array.from(event.target.files); 

  if (modelFiles.length > 0) {
    const folderPath = modelFiles[0].name.split('/')[0];
    // if model in cache
    chrome.storage.local.get('modelPath', async (result) => {
      console.log('Cached model path:', result.modelPath);
      console.log('Selected folder path:', folderPath);
      if (result.modelPath === folderPath && model) {
        // modelis already loaded from this path, so no need to reload
        console.log('Model already loaded from cached path:', folderPath);
        document.getElementById('model-path').textContent = folderPath;
        document.getElementById('annotate-button').disabled = false;
      } else {
        // load model and cache path since it's not loaded or it's a new path
        await loadModelFromFiles(modelFiles);
        // cache the new model path
        chrome.storage.local.set({ modelPath: folderPath }, () => {
          if (chrome.runtime.lastError) {
              console.error('Error setting model path:', chrome.runtime.lastError);
          }
      });
        document.getElementById('model-path').textContent = folderPath;
      }
    });
  } else {
    alert('Please select a folder containing the model files first.');
  }
});



document.getElementById('save-token').addEventListener('click', () => {
  const apiToken = document.getElementById('api-token').value;
  if (!apiToken) {
    alert("Please enter a valid API token to save.");
    return;
  }
  saveApiToken(apiToken);
});



chrome.runtime.onMessage.addListener((request, sender) => {
  if (sender.id === chrome.runtime.id) { 
    if (request.type === 'ANNOTATION_RESULT') {
      displayMessage(request.data);
    } else if (request.action === 'imageURL') {
      const img = document.getElementById('selected-image');
      img.src = request.imageUrl;

      ImageOriginalWidth = request.originalSize[0];
      ImageOriginalHeight = request.originalSize[1];
      console.log('Original image size:', ImageOriginalWidth, ImageOriginalHeight); 
      img.onload = () => {
        displayMessage('Image loaded successfully');
      };
    }
  }
});




chrome.runtime.onMessage.addListener((request, sender) => {
  if (sender.id === chrome.runtime.id && request.action === 'imageURL') {
    const img = document.getElementById('selected-image');
    img.src = request.imageUrl;
    ImageOriginalWidth = request.originalSize[0];
    ImageOriginalHeight = request.originalSize[1];
    const apiToken = document.getElementById('api-token').value;
    if (!apiToken) {
      alert("Please enter your API token.");
      return;
    }
    img.onload = async () => {
      displayMessage('Image loaded successfully');
      if (img && model) {
        try {
          const { pageId,documentId, blocksUrl } = await getBlocksUrl();
          await createTypes(apiToken);
          await updateValidBlockTypes(apiToken, documentId, typeMappings);
          const blocks = await detect(img, model);
          await createBlocks(apiToken, blocksUrl, pageId, blocks);
          displayMessage('Blocks added successfully!');
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'reloadPage' });
          });
        } catch (error) {
          console.error('Error during model execution:', error);
          displayMessage(`Error during annotation: ${error.message}`);
        }
      }
    };
  }
});


document.getElementById('annotate-button').addEventListener('click', async () => {
  const apiToken = document.getElementById('api-token').value;
  if (!apiToken) {
    alert("Please enter your API token.");
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: 'annotate',
      apiToken,
      url: tabs[0].url
    });
  });
});

async function getBlocksUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0].url;
      const regex = /^(?<domain>https?:\/\/[^\/]+)\/document(?:s?)\/(?<document>\d+)\/parts?\/(?<page>\d+)\/edit\/?$/;
      const match = regex.exec(url);

      if (!match) {
        throw new Error('Please navigate to a valid document page to annotate.');
      }

      const { domain, document, page } = match.groups;
      resolve({ 
        pageId: page, 
        documentId: document,
        blocksUrl: `${domain}/api/documents/${document}/parts/${page}/blocks/` 
      });
    });
  });
}

// first approach to extract bounding boxes, not used in the final version
function extractBoundingBoxes(predictions, confidenceThreshold = 0.5, originalWidth, originalHeight) {
  const boxes = [];
  const data = predictions.dataSync(); // Extract raw data as a flattened array
  const numDetections = predictions.shape[2]; // Number of detections (18900)
  const numClasses = predictions.shape[1] - 4; // Subtract 4 for the bounding box attributes

  // Offsets for bounding box attributes in the flattened array
  const x_center_offset = 0;
  const y_center_offset = numDetections;
  const width_offset = 2 * numDetections;
  const height_offset = 3 * numDetections;
  
  // Start class probabilities after bounding box attributes
  const class_probs_offset = 4 * numDetections;

  for (let i = 0; i < numDetections; i++) {
    // Extract bounding box values


    // Calculate confidence and class ID
    let maxProb = -Infinity;
    let classId = -1;

    for (let j = 0; j < numClasses; j++) {
      const prob = data[numDetections*i+j+4];
      if (prob > maxProb) {
        maxProb = prob;
        classId = j;
      }
    }

    // Only process detections with confidence above threshold
    if (maxProb > confidenceThreshold) {
       const x_center = data[numDetections*i] * (originalWidth / inputSize);
       const y_center = data[numDetections*i+1] * (originalWidth / inputSize);
       const width = data[numDetections*i+2] * (originalHeight / inputSize);
       const height = data[numDetections*i+3] * (originalHeight / inputSize);

      console.log("originalWidth",originalWidth,"originalHeight",originalHeight,"inputSize",inputSize);
      const x_min = x_center - width / 2;
      const y_min = y_center - height / 2;
      const x_max = x_center + width / 2;
      const y_max = y_center + height / 2;
      console.log(`Detection ${i}: x_center=${x_center}, y_center=${y_center}, width=${width}, height=${height}`);
      console.log('position in array',numDetections*i,"value",data[numDetections*i]);
      boxes.push({
        box: [[x_min, y_min], [x_min, y_max], [x_max, y_max], [x_max, y_min]],
        typology: null,
        class: classId,
        confidence: maxProb
      });
    }
  }

  console.log('Extracted boxes:', boxes);
  return boxes;
}




function exportRawData(data,name='Predictions') {

    // generate a timestamp 
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
  
  const filename = name+timestamp+'.json';
  const jsonData = JSON.stringify(Array.from(data));
  const blob = new Blob([jsonData], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function exportPredictions(predictions) {
  const rawData = await predictions.dataSync(); //  dataSync() if synchronous extraction is preferred , data() if not
  exportRawData(rawData);
}
  
async function exportDetectionsAndAttributes(predictions) {
  const [batchSize, numAttributes, numDetections] = predictions.shape;

  // export each detection 
  for (let i = 0; i < numDetections; i++) {
    const detection = predictions.slice([0, 0, i], [1, numAttributes, 1]);
    const detectionData = await detection.data();  //  dataSync() if synchronous extraction is preferred , data() if not
    exportRawData(detectionData, `Detection_${i + 1}_`); // export each detection individually
    detection.dispose(); // dispose to free memory
  }

  // export all detections along the numAttributes dimension in one file
  const allAttributesData = await predictions.slice([0, 0, 0], [1, numAttributes, numDetections]).data();
  exportRawData(allAttributesData, `AllAttributes_`);
}  

async function createTypes(apiToken) {
  for (const label of labels) {
    try {
      const response = await fetch('https://escriptorium.inria.fr/api/types/block/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${apiToken}` // Make sure apiToken is defined and valid
        },
        body: JSON.stringify({ name: label })
      });
      
      if (response.ok) {
        const type = await response.json();
        typeMappings[label] = type.pk; // Map label to pk
        console.log(`Created type: ${label} with pk: ${type.pk}`);
      } else {
        const errorData = await response.json();
        console.error(`Error creating type ${label}:`, errorData);
      }
    } catch (error) {
      console.error(`Failed to create type ${label}:`, error);
    }
  }
}


async function updateValidBlockTypes(apiToken, documentId, typeMappings) {
  const validBlockTypes = Object.values(typeMappings).map(pk => ({ pk }));
  
  try {
    const response = await fetch(`https://escriptorium.inria.fr/api/documents/${documentId}/`, {
      method: 'PATCH', 
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiToken}`
      },
      body: JSON.stringify({ valid_block_types: validBlockTypes })
    });

    if (response.ok) {
      console.log('Successfully updated valid block types for document:', documentId);
      console.log('response',response);
      console.log('validBlockTypes',validBlockTypes);
    } else {
      const errorData = await response.json();
      console.error('Error updating valid block types:', errorData);
    }
  } catch (error) {
    console.error('Failed to update valid block types:', error);
  }
}


const preprocess = (source, modelWidth, modelHeight) => {
  let xRatio, yRatio; // ratios for boxes

  const input = tf.tidy(() => {
    const img = tf.browser.fromPixels(source);

    // padding image to square => [n, m] to [n, n], n > m
    const [h, w] = img.shape.slice(0, 2); // get source width and height
    console.log("original shape",img.shape.slice(0, 2));
    const maxSize = Math.max(w, h); // get max size
    const imgPadded = img.pad([
      [0, maxSize - h], // padding y [bottom only]
      [0, maxSize - w], // padding x [right only]
      [0, 0],
    ]);
    console.log("imgPadded shape",imgPadded.shape.slice(0, 2));
    console.log("maxSize",maxSize);
    console.log("imgPadded",imgPadded);
    xRatio = maxSize / w; // update xRatio
    yRatio = maxSize / h; // update yRatio

    return tf.image
      .resizeBilinear(imgPadded, [modelWidth, modelHeight]) // resize frame
      .div(255.0) // normalize
      .expandDims(0); // add batch
  });

  return [input, xRatio, yRatio];
};



export const detect = async (source, model) => {
  let rendered_boxes = [];

  const [modelWidth, modelHeight] = model.inputs[0].shape.slice(1, 3); // get model width and height
  console.log("modelWidth",modelWidth,"modelHeight",modelHeight);
  tf.engine().startScope(); // start scoping tf engine
  const [input, xRatio, yRatio] = preprocess(source, modelWidth, modelHeight); // preprocess image

  const res = model.execute(input); // inference model
  const transRes = res.transpose([0, 2, 1]); // transpose result [b, det, n] => [b, n, det]
  const boxes = tf.tidy(() => {
    const w = transRes.slice([0, 0, 2], [-1, -1, 1]); // get width
    const h = transRes.slice([0, 0, 3], [-1, -1, 1]); // get height
    const x1 = tf.sub(transRes.slice([0, 0, 0], [-1, -1, 1]), tf.div(w, 2)); // x1
    const y1 = tf.sub(transRes.slice([0, 0, 1], [-1, -1, 1]), tf.div(h, 2)); // y1
    return tf
      .concat(
        [
          y1,
          x1,
          tf.add(y1, h), // y2
          tf.add(x1, w), // x2
        ],
        2
      )
      .squeeze();
    
  }); // process boxes [y1, x1, y2, x2]

  const [scores, classes] = tf.tidy(() => {
    // class scores
    const rawScores = transRes.slice([0, 0, 4], [-1, -1, numClass]).squeeze(0); // #6 only squeeze axis 0 to handle only 1 class models
    return [rawScores.max(1), rawScores.argMax(1)];
  }); // get max scores and classes index

  const nms = await tf.image.nonMaxSuppressionAsync(boxes, scores, 500, 0.45, 0.2); // NMS to filter boxes

  const boxes_data = boxes.gather(nms, 0).dataSync(); // indexing boxes by nms index
  const scores_data = scores.gather(nms, 0).dataSync(); // indexing scores by nms index
  const classes_data = classes.gather(nms, 0).dataSync(); // indexing classes by nms index


  rendered_boxes= renderBoxes( boxes_data, scores_data, classes_data, [xRatio, yRatio], modelWidth, modelHeight); // render boxes
  return rendered_boxes;
  
  //tf.dispose([res, transRes, boxes, scores, classes, nms]); // clear memory
  //callback();
  //tf.engine().endScope(); // end of scoping
};

export const renderBoxes = ( boxes_data, scores_data, classes_data, ratios, modelWidth, modelHeight) => {
  let boxes = [];
  console.log('scores_data',scores_data);
  console.log('ratios',ratios); 
  for (let i = 0; i < scores_data.length; ++i) {
    // filter based on class threshold
    // i need to get lables from the yaml file somehow
    //const klass = labels[classes_data[i]];
    const score = (scores_data[i] * 100).toFixed(1);

    let [y1, x1, y2, x2] = boxes_data.slice(i * 4, (i + 1) * 4);
    x1 *= ratios[0]*(ImageOriginalWidth / modelWidth);;
    x2 *= ratios[0]*(ImageOriginalWidth / modelWidth);;
    y1 *= ratios[1]*(ImageOriginalHeight / modelHeight);
    y2 *= ratios[1]*(ImageOriginalHeight / modelHeight);
    const width = x2 - x1;
    const height = y2 - y1;
    boxes.push({
      box: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
      typology: typeMappings[labels[classes_data[i]]],
    });
  

    

    
  }
  console.log('Extracted boxes:', boxes);
  return boxes;
};


async function createBlocks(apiToken, uri, pageId, blocks) {
  for (const block of blocks) {
    block.document_part = pageId;

    const response = await fetch(uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiToken}`
      },
      body: JSON.stringify(block)
    });

    if (!response.ok) {
      throw new Error(`Failed to add block: ${response.statusText}`);
    }
  }
}

initializeBackend();