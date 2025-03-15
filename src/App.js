import React, { useState, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, FeatureGroup } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import MarkerClusterGroup from 'react-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import L from 'leaflet';
import './App.css';
import JSZip from 'jszip';
import EXIF from 'exif-js';
import createImageWorker from './createImageWorker';

// Fix for default marker icons in React-Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

// Constants for optimization
const PARALLEL_WORKERS = navigator.hardwareConcurrency || 4;
const BATCH_SIZE = 50;

// Create a pool of workers
const createWorkerPool = (size) => {
  return Array.from({ length: size }, () => createImageWorker());
};

function convertDMSToDD(degrees, minutes, seconds, direction) {
  let dd = degrees + minutes / 60 + seconds / 3600;
  if (direction === 'S' || direction === 'W') {
    dd = dd * -1;
  }
  return dd;
}

function getExifData(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      const tags = EXIF.readFromBinaryFile(e.target.result);
      
      if (!tags) {
        resolve({ latitude: null, longitude: null, dateTimeOriginal: null });
        return;
      }

      let latitude = null;
      let longitude = null;
      let dateTimeOriginal = tags.DateTimeOriginal;

      if (tags.GPSLatitude && tags.GPSLongitude) {
        const latDegrees = tags.GPSLatitude[0].numerator / tags.GPSLatitude[0].denominator;
        const latMinutes = tags.GPSLatitude[1].numerator / tags.GPSLatitude[1].denominator;
        const latSeconds = tags.GPSLatitude[2].numerator / tags.GPSLatitude[2].denominator;
        const latDirection = tags.GPSLatitudeRef;

        const lonDegrees = tags.GPSLongitude[0].numerator / tags.GPSLongitude[0].denominator;
        const lonMinutes = tags.GPSLongitude[1].numerator / tags.GPSLongitude[1].denominator;
        const lonSeconds = tags.GPSLongitude[2].numerator / tags.GPSLongitude[2].denominator;
        const lonDirection = tags.GPSLongitudeRef;

        latitude = convertDMSToDD(latDegrees, latMinutes, latSeconds, latDirection);
        longitude = convertDMSToDD(lonDegrees, lonMinutes, lonSeconds, lonDirection);
      }

      resolve({ 
        latitude, 
        longitude, 
        dateTimeOriginal: dateTimeOriginal 
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

async function createThumbnail(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const MAX_SIZE = 100;
        let width = img.width;
        let height = img.height;
        
        if (width > height) {
          if (width > MAX_SIZE) {
            height = height * (MAX_SIZE / width);
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width = width * (MAX_SIZE / height);
            height = MAX_SIZE;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function* getFiles(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
        yield await entry.getFile();
      }
    } else if (entry.kind === 'directory') {
      yield* getFiles(entry);
    }
  }
}

async function saveThumbnail(thumbnailData, fileName, dirHandle) {
  try {
    // Create thumbnails directory if it doesn't exist
    let thumbnailsDirHandle;
    try {
      thumbnailsDirHandle = await dirHandle.getDirectoryHandle('thumbnails', { create: true });
    } catch (err) {
      console.error('Error creating thumbnails directory:', err);
      throw err;
    }

    // Convert base64 to blob
    const base64Data = thumbnailData.split(',')[1];
    const byteCharacters = atob(base64Data);
    const byteArrays = [];
    for (let i = 0; i < byteCharacters.length; i++) {
      byteArrays.push(byteCharacters.charCodeAt(i));
    }
    const blob = new Blob([new Uint8Array(byteArrays)], { type: 'image/jpeg' });

    // Save thumbnail
    const thumbnailFile = await thumbnailsDirHandle.getFileHandle(fileName + '.thumb.jpg', { create: true });
    const writable = await thumbnailFile.createWritable();
    await writable.write(blob);
    await writable.close();

    return `thumbnails/${fileName}.thumb.jpg`;
  } catch (err) {
    console.error('Error saving thumbnail:', err);
    throw err;
  }
}

async function saveToJson(photos, dirHandle) {
  try {
    // Save thumbnails first and get their paths
    const photoPromises = photos.map(async photo => {
      const thumbnailPath = await saveThumbnail(photo.thumbnail, photo.name, dirHandle);
      return {
        name: photo.name,
        date: photo.date,
        latitude: photo.latitude,
        longitude: photo.longitude,
        thumbnailPath: thumbnailPath,
        lastModified: photo.file.lastModified
      };
    });

    const serializablePhotos = await Promise.all(photoPromises);

    // Create the JSON file with metadata only
    const jsonContent = JSON.stringify({ 
      photos: serializablePhotos,
      lastScanned: new Date().toISOString()
    }, null, 2); // Added formatting for better readability

    // Save the metadata file
    const jsonFile = await dirHandle.getFileHandle('photos-metadata.json', { create: true });
    const writable = await jsonFile.createWritable();
    await writable.write(jsonContent);
    await writable.close();
  } catch (err) {
    console.error('Error saving metadata:', err);
    throw err;
  }
}

async function loadFromJson(dirHandle) {
  try {
    const jsonFile = await dirHandle.getFileHandle('photos-metadata.json');
    const file = await jsonFile.getFile();
    const content = await file.text();
    const data = JSON.parse(content);

    // Ensure all dates are milliseconds timestamps
    return {
      ...data,
      photos: data.photos.map(photo => ({
        ...photo,
        date: typeof photo.date === 'string' ? new Date(photo.date).getTime() : photo.date,
        lastModified: typeof photo.lastModified === 'string' ? new Date(photo.lastModified).getTime() : photo.lastModified
      }))
    };
  } catch (err) {
    if (err.name === 'NotFoundError') {
      return null;
    }
    console.error('Error loading cache:', err);
    throw err;
  }
}

// Add a function to load thumbnail when needed
async function loadThumbnail(photo, dirHandle) {
  try {
    const thumbnailsDirHandle = await dirHandle.getDirectoryHandle('thumbnails');
    const thumbnailFile = await thumbnailsDirHandle.getFileHandle(photo.name + '.thumb.jpg');
    const thumbnailBlob = await thumbnailFile.getFile();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(thumbnailBlob);
    });
  } catch (err) {
    console.error(`Error loading thumbnail for ${photo.name}:`, err);
    return null;
  }
}

function App() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const mapRef = useRef(null);
  const featureGroupRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [processedPhotos, setProcessedPhotos] = useState(0);
  const [status, setStatus] = useState('');
  const workerPool = useRef(null);
  const dirHandleRef = useRef(null);
  const [thumbnailCache, setThumbnailCache] = useState(new Map());
  const observerRef = useRef(null);
  const photoRefs = useRef(new Map());
  
  // Initialize worker pool
  useEffect(() => {
    workerPool.current = createWorkerPool(PARALLEL_WORKERS);
    return () => {
      // Cleanup workers on unmount
      workerPool.current?.forEach(worker => worker.terminate());
    };
  }, []);

  // Initialize intersection observer
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const photoIndex = parseInt(entry.target.dataset.index);
            const photo = photos[photoIndex];
            if (photo && !thumbnailCache.has(photo.name) && dirHandleRef.current) {
              handlePhotoSelect(photoIndex);
            }
          }
        });
      },
      { threshold: 0.1 }
    );

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [photos]); // Re-initialize when photos array changes

  // Load initial visible thumbnails
  useEffect(() => {
    if (photos.length > 0 && dirHandleRef.current) {
      // Load first N thumbnails immediately
      const initialLoadCount = Math.min(20, photos.length);
      for (let i = 0; i < initialLoadCount; i++) {
        handlePhotoSelect(i);
      }
    }
  }, [photos]);

  // Update observer entries when photos change
  useEffect(() => {
    photoRefs.current.forEach((element) => {
      if (observerRef.current && element) {
        observerRef.current.observe(element);
      }
    });

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [photos]);

  // Request permission for the directory
  const requestPermission = async (dirHandle) => {
    // Request permission if not already granted
    const options = { mode: 'readwrite' };
    if ((await dirHandle.queryPermission(options)) !== 'granted') {
      if ((await dirHandle.requestPermission(options)) !== 'granted') {
        throw new Error('Permission to access directory was denied');
      }
    }
    return dirHandle;
  };

  // Process images in parallel using worker pool
  const processImagesParallel = async (files, dirHandle) => {
    const results = [];
    const errors = [];
    let completedCount = 0;
    const thumbnailsDirHandle = await dirHandle.getDirectoryHandle('thumbnails', { create: true });

    // Create a queue of available workers
    const workerQueue = [...workerPool.current];

    const getNextWorker = () => {
      return new Promise((resolve) => {
        if (workerQueue.length > 0) {
          resolve(workerQueue.shift());
        } else {
          const checkInterval = setInterval(() => {
            if (workerQueue.length > 0) {
              clearInterval(checkInterval);
              resolve(workerQueue.shift());
            }
          }, 100);
        }
      });
    };

    const releaseWorker = (worker) => {
      workerQueue.push(worker);
    };

    const processFile = async (file) => {
      const worker = await getNextWorker();
      
      try {
        const arrayBuffer = await file.arrayBuffer();
        
        const result = await new Promise((resolve, reject) => {
          const handleMessage = (e) => {
            worker.removeEventListener('message', handleMessage);
            resolve(e.data);
          };
          
          const handleError = (e) => {
            worker.removeEventListener('error', handleError);
            reject(new Error(e.message));
          };
          
          worker.addEventListener('message', handleMessage);
          worker.addEventListener('error', handleError);
          worker.postMessage({ file, arrayBuffer }, [arrayBuffer]);
        });

        if (result.error) {
          throw new Error(result.error);
        }

        if (result.metadata.latitude && result.metadata.longitude) {
          // Save thumbnail
          const thumbnailFile = await thumbnailsDirHandle.getFileHandle(result.fileName + '.thumb.jpg', { create: true });
          const writable = await thumbnailFile.createWritable();
          await writable.write(result.thumbnailArrayBuffer);
          await writable.close();

          // Convert date to milliseconds timestamp if it's a string
          const dateTimeOriginal = result.metadata.dateTimeOriginal;
          const dateInMillis = dateTimeOriginal ? 
            (typeof dateTimeOriginal === 'string' ? 
              new Date(dateTimeOriginal.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')).getTime() : 
              dateTimeOriginal) : 
            result.lastModified;

          // Add to results without the thumbnail data
          results.push({
            name: result.fileName,
            date: dateInMillis,
            latitude: result.metadata.latitude,
            longitude: result.metadata.longitude,
            thumbnailPath: `thumbnails/${result.fileName}.thumb.jpg`,
            lastModified: result.lastModified,
            file: file // Keep file reference for saving
          });
        }

        completedCount++;
        setProgress(Math.round((completedCount / files.length) * 100));
        setProcessedPhotos(completedCount);
        
      } catch (error) {
        errors.push({ file: file.name, error: error.message });
        console.error(`Error processing file ${file.name}:`, error);
      } finally {
        releaseWorker(worker);
      }
    };

    // Process files sequentially in small batches to maintain order and prevent overwhelming
    const CONCURRENT_BATCH = Math.min(PARALLEL_WORKERS, 4); // Limit concurrent processing
    for (let i = 0; i < files.length; i += CONCURRENT_BATCH) {
      const batch = files.slice(i, i + CONCURRENT_BATCH);
      await Promise.all(batch.map(file => processFile(file)));
    }

    if (errors.length > 0) {
      console.warn('Files that failed to process:', errors);
    }

    // Sort results by date to maintain consistency
    return results.sort((a, b) => b.date - a.date);
  };

  const handleScan = async () => {
    try {
      setLoading(true);
      setError(null);
      setPhotos([]);
      setProgress(0);
      setTotalPhotos(0);
      setProcessedPhotos(0);
      setStatus('');
      setThumbnailCache(new Map()); // Clear thumbnail cache

      // Get directory handle and store it
      const dirHandle = await window.showDirectoryPicker();
      await requestPermission(dirHandle);
      dirHandleRef.current = dirHandle;
      
      // Try to load existing cache
      setStatus('Checking for existing cache...');
      const cachedData = await loadFromJson(dirHandle);
      let photoMap = new Map(); // Use a map to track all photos by name
      
      if (cachedData) {
        setStatus('Found cached data, loading...');
        cachedData.photos.forEach(photo => {
          photoMap.set(photo.name, photo);
        });
      }

      // Collect all files first
      setStatus('Collecting files...');
      const allFiles = [];
      const seenFiles = new Set();

      for await (const file of getFiles(dirHandle)) {
        if (!seenFiles.has(file.name)) {
          seenFiles.add(file.name);
          const existingPhoto = photoMap.get(file.name);
          if (!existingPhoto || existingPhoto.lastModified !== file.lastModified) {
            allFiles.push(file);
          }
        }
      }

      // Sort files by name for consistent processing order
      allFiles.sort((a, b) => a.name.localeCompare(b.name));
      setTotalPhotos(allFiles.length);
      
      if (allFiles.length === 0) {
        setStatus('No new or modified photos to scan');
        const existingPhotos = Array.from(photoMap.values());
        setPhotos(existingPhotos);
        if (existingPhotos.length > 0) {
          const bounds = L.latLngBounds(existingPhotos.map(photo => [photo.latitude, photo.longitude]));
          mapRef.current?.fitBounds(bounds, { padding: [50, 50] });
        }
        return;
      }

      // Process files in parallel and save thumbnails immediately
      setStatus('Processing photos and saving thumbnails...');
      const processedPhotos = await processImagesParallel(allFiles, dirHandle);
      
      // Update the photo map with new/updated photos
      processedPhotos.forEach(photo => {
        photoMap.set(photo.name, photo);
      });

      // Convert map back to array, sorted by date
      const allPhotos = Array.from(photoMap.values()).sort((a, b) => b.date - a.date);

      // Save metadata
      setStatus('Saving metadata...');
      const jsonContent = JSON.stringify({ 
        photos: allPhotos.map(photo => ({
          ...photo,
          file: undefined // Remove file reference before saving
        })),
        lastScanned: new Date().toISOString()
      }, null, 2);

      const jsonFile = await dirHandle.getFileHandle('photos-metadata.json', { create: true });
      const writable = await jsonFile.createWritable();
      await writable.write(jsonContent);
      await writable.close();

      setPhotos(allPhotos);
      setStatus('Scan complete');

      if (allPhotos.length > 0) {
        const bounds = L.latLngBounds(allPhotos.map(photo => [photo.latitude, photo.longitude]));
        mapRef.current?.fitBounds(bounds, { padding: [50, 50] });
      }
    } catch (err) {
      setError(err.message);
      console.error('Scan error:', err);
    } finally {
      setLoading(false);
      setProgress(0);
      setTotalPhotos(0);
      setProcessedPhotos(0);
    }
  };

  const handlePhotoSelect = async (index) => {
    const photo = photos[index];
    
    // Load thumbnail if not in cache
    if (!thumbnailCache.has(photo.name) && dirHandleRef.current) {
      const thumbnail = await loadThumbnail(photo, dirHandleRef.current);
      if (thumbnail) {
        setThumbnailCache(prev => new Map(prev).set(photo.name, thumbnail));
      }
    }
    
    setSelectedPhoto(index);
    if (mapRef.current) {
      mapRef.current.setView([photo.latitude, photo.longitude], 12);
    }
  };

  const handleAreaSelect = async (e) => {
    const bounds = e.layer.getBounds();
    const selectedPhotos = photos.filter(photo => {
      const latLng = L.latLng(photo.latitude, photo.longitude);
      return bounds.contains(latLng);
    });

    if (selectedPhotos.length === 0) {
      alert('No photos found in the selected area');
      featureGroupRef.current.clearLayers();
      return;
    }

    setDownloading(true);
    try {
      // Verify permission before accessing files
      if (dirHandleRef.current) {
        await requestPermission(dirHandleRef.current);
      }

      const zip = new JSZip();
      
      for (const photo of selectedPhotos) {
        // Get the original file
        const file = await dirHandleRef.current.getFileHandle(photo.name);
        const fileData = await file.getFile();
        zip.file(photo.name, fileData);
      }
      
      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'STORE'
      });
      
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'selected-photos.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
      setError('Failed to download photos. Please try again.');
    } finally {
      setDownloading(false);
      featureGroupRef.current.clearLayers();
    }
  };

  return (
    <div className="App">
      <div className="sidebar">
        <div className="controls">
          <button onClick={handleScan} disabled={loading}>
            {loading ? `${status} ${progress > 0 ? `${progress}% (${processedPhotos}/${totalPhotos})` : ''}` : 'Select Directory'}
          </button>
          {error && <div className="error">{error}</div>}
          {downloading && <div className="downloading">Creating zip file...</div>}
        </div>
        
        <div className="photos-list">
          <h3>Photos with GPS Data ({photos.length})</h3>
          <p className="help-text">Draw a rectangle on the map to select and download photos from that area.</p>
          {loading ? (
            <div className="scanning-message">
              {status}<br/>
              {progress > 0 && `Progress: ${progress}%`}<br/>
              {processedPhotos > 0 && `Processed: ${processedPhotos}/${totalPhotos} photos`}
            </div>
          ) : (
            <div className="photo-items">
              {photos.map((photo, index) => (
                <div 
                  key={index}
                  ref={el => photoRefs.current.set(index, el)}
                  data-index={index}
                  className={`photo-item ${selectedPhoto === index ? 'selected' : ''}`}
                  onClick={() => handlePhotoSelect(index)}
                >
                  {thumbnailCache.has(photo.name) ? (
                    <img
                      src={thumbnailCache.get(photo.name)}
                      alt={photo.name}
                      className="thumbnail"
                    />
                  ) : (
                    <div className="thumbnail-placeholder">
                      Loading...
                    </div>
                  )}
                  <div className="photo-info">
                    <div className="photo-name">{photo.name}</div>
                    <div className="photo-date">
                      {new Date(photo.date).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="map-container">
        <MapContainer
          center={[0, 0]}
          zoom={2}
          style={{ height: '100%', width: '100%' }}
          ref={mapRef}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <FeatureGroup ref={featureGroupRef}>
            <EditControl
              position="topright"
              onCreated={handleAreaSelect}
              draw={{
                rectangle: true,
                circle: false,
                circlemarker: false,
                marker: false,
                polyline: false,
                polygon: false,
              }}
              edit={{
                edit: false,
                remove: false,
              }}
            />
          </FeatureGroup>
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={50}
          >
            {photos.map((photo, index) => (
              <Marker
                key={index}
                position={[photo.latitude, photo.longitude]}
              >
                <Popup>
                  <div className="photo-popup">
                    {thumbnailCache.has(photo.name) && (
                      <div className="popup-image-container">
                        <img
                          src={thumbnailCache.get(photo.name)}
                          alt={photo.name}
                          className="popup-image"
                          onClick={() => handlePhotoSelect(index)}
                        />
                      </div>
                    )}
                    <p className="photo-name">{photo.name}</p>
                    <p className="photo-date">
                      {new Date(photo.date).toLocaleString()}
                    </p>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MarkerClusterGroup>
        </MapContainer>
      </div>
    </div>
  );
}

export default App;
