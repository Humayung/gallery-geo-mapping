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

async function* getFiles(dirHandle, path = '') {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
        const file = await entry.getFile();
        // Attach the relative path to the file object
        file.relativePath = path ? `${path}/${entry.name}` : entry.name;
        yield file;
      }
    } else if (entry.kind === 'directory') {
      const newPath = path ? `${path}/${entry.name}` : entry.name;
      yield* getFiles(entry, newPath);
    }
  }
}

async function saveThumbnail(thumbnailData, fileName, relativePath, dirHandle) {
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

    // Create subdirectories in thumbnails if needed
    const pathParts = relativePath.split('/');
    let currentDirHandle = thumbnailsDirHandle;
    if (pathParts.length > 1) {
      for (let i = 0; i < pathParts.length - 1; i++) {
        currentDirHandle = await currentDirHandle.getDirectoryHandle(pathParts[i], { create: true });
      }
    }

    // Save thumbnail
    const thumbnailFile = await currentDirHandle.getFileHandle(fileName + '.thumb.jpg', { create: true });
    const writable = await thumbnailFile.createWritable();
    await writable.write(blob);
    await writable.close();

    return `thumbnails/${relativePath}.thumb.jpg`;
  } catch (err) {
    console.error('Error saving thumbnail:', err);
    throw err;
  }
}

async function saveToJson(photos, dirHandle) {
  try {
    // Save thumbnails first and get their paths
    const photoPromises = photos.map(async photo => {
      const thumbnailPath = await saveThumbnail(photo.thumbnail, photo.name, photo.relativePath, dirHandle);
      return {
        name: photo.name,
        relativePath: photo.relativePath,
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
    }, null, 2);

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
    // Split the relative path into parts
    const pathParts = photo.relativePath.split('/');
    let currentDirHandle = await dirHandle.getDirectoryHandle('thumbnails');
    
    // Navigate through subdirectories
    if (pathParts.length > 1) {
      for (let i = 0; i < pathParts.length - 1; i++) {
        currentDirHandle = await currentDirHandle.getDirectoryHandle(pathParts[i]);
      }
    }
    
    const thumbnailFile = await currentDirHandle.getFileHandle(photo.name + '.thumb.jpg');
    const thumbnailBlob = await thumbnailFile.getFile();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(thumbnailBlob);
    });
  } catch (err) {
    console.error(`Error loading thumbnail for ${photo.relativePath}:`, err);
    return null;
  }
}

function ScanProgress({ status, progress, processedPhotos, totalPhotos }) {
  return (
    <div className="scanning-message">
      {status}<br/>
      {progress > 0 && `Progress: ${progress}%`}<br/>
      {processedPhotos > 0 && `Processed: ${processedPhotos}/${totalPhotos} photos`}
    </div>
  );
}

const ImageViewer = React.memo(({ photo, onClose, dirHandle, photos, onNavigate, mapRef }) => {
  const [loading, setLoading] = useState(true);
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState(null);
  const [visited, setVisited] = useState([photo]); // Initialize with current photo

  // Update map view and show popup for the given photo
  const updateMapView = (photo) => {
    if (mapRef.current) {
      // Set map view to the photo's location
      mapRef.current.setView([photo.latitude, photo.longitude], 12);

      // Find and open the marker's popup
      mapRef.current.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          const markerLatLng = layer.getLatLng();
          if (markerLatLng.lat === photo.latitude && markerLatLng.lng === photo.longitude) {
            layer.openPopup();
          }
        }
      });
    }
  };

  // Find nearest unvisited photo based on location
  const findNearestUnvisitedPhoto = (currentPhoto) => {
    const currentLat = currentPhoto.latitude;
    const currentLng = currentPhoto.longitude;
    
    // Create array of unvisited photos with their distances
    const photosWithDistance = photos
      .filter(p => !visited.some(v => v.relativePath === p.relativePath)) // Exclude visited photos
      .map(p => ({
        photo: p,
        distance: Math.sqrt(
          Math.pow(p.latitude - currentLat, 2) + 
          Math.pow(p.longitude - currentLng, 2)
        )
      }));

    // Sort by distance and return the nearest photo
    photosWithDistance.sort((a, b) => a.distance - b.distance);
    return photosWithDistance[0]?.photo || null;
  };

  const handleNext = () => {
    const nearest = findNearestUnvisitedPhoto(photo);
    if (nearest) {
      setVisited([...visited, nearest]); // Add to visited
      updateMapView(nearest);
      onNavigate(nearest);
    }
  };

  const handlePrev = () => {
    if (visited.length > 1) {
      const newVisited = [...visited];
      newVisited.pop(); // Remove current photo
      const prevPhoto = newVisited[newVisited.length - 1]; // Get last photo from history
      setVisited(newVisited);
      updateMapView(prevPhoto);
      onNavigate(prevPhoto);
    }
  };

  // Update map when component mounts
  useEffect(() => {
    updateMapView(photo);
  }, [photo]);

  useEffect(() => {
    const loadFullImage = async () => {
      try {
        setLoading(true);
        setError(null);

        const pathParts = photo.relativePath.split('/');
        let currentDirHandle = dirHandle;
        
        if (pathParts.length > 1) {
          for (let i = 0; i < pathParts.length - 1; i++) {
            currentDirHandle = await currentDirHandle.getDirectoryHandle(pathParts[i]);
          }
        }
        
        const fileHandle = await currentDirHandle.getFileHandle(photo.name);
        const file = await fileHandle.getFile();
        const url = URL.createObjectURL(file);
        setImageUrl(url);
      } catch (err) {
        console.error('Error loading full resolution image:', err);
        setError('Failed to load image');
      } finally {
        setLoading(false);
      }
    };

    loadFullImage();

    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [photo, dirHandle]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowLeft') {
      handlePrev();
    } else if (e.key === 'ArrowRight') {
      handleNext();
    }
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visited]); // Only depend on visited array for navigation

  return (
    <div className="image-viewer-overlay" onClick={onClose}>
      <div className="image-viewer-content" onClick={e => e.stopPropagation()}>
        <button className="image-viewer-close" onClick={onClose}>×</button>
        
        {visited.length > 1 && (
          <button 
            className="image-viewer-nav image-viewer-prev"
            onClick={handlePrev}
          >
            ‹
          </button>
        )}
        
        {findNearestUnvisitedPhoto(photo) && (
          <button 
            className="image-viewer-nav image-viewer-next"
            onClick={handleNext}
          >
            ›
          </button>
        )}

        {loading ? (
          <div className="loading-spinner" />
        ) : error ? (
          <div className="image-viewer-error">{error}</div>
        ) : (
          <img
            src={imageUrl}
            alt={photo.name}
            className="image-viewer-image"
          />
        )}
        <div className="image-viewer-info">
          {photo.name} - {new Date(photo.date).toLocaleString()}
        </div>
      </div>
    </div>
  );
});

const PhotoPopup = React.memo(({ photo, thumbnail, onPhotoSelect, index, onThumbnailNeeded, onViewFullImage }) => {
  React.useEffect(() => {
    if (!thumbnail && onThumbnailNeeded) {
      onThumbnailNeeded(photo);
    }
  }, [photo, thumbnail, onThumbnailNeeded]);

  return (
    <div className="photo-popup">
      {thumbnail ? (
        <div className="popup-image-container">
          <img
            src={thumbnail}
            alt={photo.name}
            className="popup-image"
            onClick={(e) => {
              e.stopPropagation();
              onViewFullImage(photo);
            }}
          />
        </div>
      ) : (
        <div className="popup-image-container">
          <div className="thumbnail-placeholder">
            Loading...
          </div>
        </div>
      )}
      <p className="photo-name">{photo.name}</p>
      <p className="photo-path">{photo.relativePath}</p>
      <p className="photo-date">
        {new Date(photo.date).toLocaleString()}
      </p>
    </div>
  );
});

const PhotosMap = React.memo(({ 
  photos, 
  thumbnailCache, 
  onPhotoSelect, 
  onAreaSelect, 
  mapRef, 
  featureGroupRef,
  onThumbnailNeeded,
  onViewFullImage
}) => {
  return (
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
          onCreated={onAreaSelect}
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
            key={photo.relativePath}
            position={[photo.latitude, photo.longitude]}
          >
            <Popup>
              <PhotoPopup
                photo={photo}
                thumbnail={thumbnailCache.get(photo.relativePath)}
                onPhotoSelect={onPhotoSelect}
                onThumbnailNeeded={onThumbnailNeeded}
                onViewFullImage={onViewFullImage}
                index={index}
              />
            </Popup>
          </Marker>
        ))}
      </MarkerClusterGroup>
    </MapContainer>
  );
});

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
  const [selectedFullImage, setSelectedFullImage] = useState(null);
  
  // Initialize worker pool
  useEffect(() => {
    workerPool.current = createWorkerPool(PARALLEL_WORKERS);
    return () => {
      // Cleanup workers on unmount
      workerPool.current?.forEach(worker => worker.terminate());
    };
  }, []);

  // Memoize handler functions
  const handlePhotoSelectMemoized = React.useCallback((index, shouldUpdateView = true) => {
    const photo = photos[index];
    
    // Load thumbnail if not in cache
    if (!thumbnailCache.has(photo.relativePath) && dirHandleRef.current) {
      loadThumbnail(photo, dirHandleRef.current).then(thumbnail => {
        if (thumbnail) {
          setThumbnailCache(prev => new Map(prev).set(photo.relativePath, thumbnail));
        }
      });
    }
    
    // Only update view and selected photo if shouldUpdateView is true
    if (shouldUpdateView) {
      setSelectedPhoto(index);
      if (mapRef.current) {
        mapRef.current.setView([photo.latitude, photo.longitude], 12);
      }
    }
  }, [photos, thumbnailCache]);

  // Add a new handler for thumbnail loading
  const handleThumbnailNeeded = React.useCallback((photo) => {
    if (!thumbnailCache.has(photo.relativePath) && dirHandleRef.current) {
      loadThumbnail(photo, dirHandleRef.current).then(thumbnail => {
        if (thumbnail) {
          setThumbnailCache(prev => new Map(prev).set(photo.relativePath, thumbnail));
        }
      });
    }
  }, [thumbnailCache]);

  // Initialize intersection observer
  useEffect(() => {
    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const photoIndex = parseInt(entry.target.dataset.index);
            const photo = photos[photoIndex];
            if (photo && !thumbnailCache.has(photo.relativePath) && dirHandleRef.current) {
              handleThumbnailNeeded(photo);
            }
          }
        });
      },
      { 
        root: document.querySelector('.photo-items'),
        rootMargin: '50px',
        threshold: 0.1 
      }
    );

    // Observe all existing photo items
    photoRefs.current.forEach((element) => {
      if (element) {
        observerRef.current.observe(element);
      }
    });

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [photos, thumbnailCache, handleThumbnailNeeded]);

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
          worker.postMessage({
            file,
            arrayBuffer,
            relativePath: file.relativePath
          }, [arrayBuffer]);
        });

        if (result.error) {
          throw new Error(result.error);
        }

        if (result.metadata.latitude && result.metadata.longitude) {
          // Create subdirectories in thumbnails if needed
          const pathParts = file.relativePath.split('/');
          let currentDirHandle = thumbnailsDirHandle;
          if (pathParts.length > 1) {
            for (let i = 0; i < pathParts.length - 1; i++) {
              currentDirHandle = await currentDirHandle.getDirectoryHandle(pathParts[i], { create: true });
            }
          }

          // Save thumbnail
          const thumbnailFile = await currentDirHandle.getFileHandle(file.name + '.thumb.jpg', { create: true });
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
            name: file.name,
            relativePath: file.relativePath,
            date: dateInMillis,
            latitude: result.metadata.latitude,
            longitude: result.metadata.longitude,
            thumbnailPath: `thumbnails/${file.relativePath}.thumb.jpg`,
            lastModified: file.lastModified,
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
      let photoMap = new Map(); // Use a map to track all photos by relative path
      
      if (cachedData) {
        setStatus('Found cached data, loading...');
        cachedData.photos.forEach(photo => {
          photoMap.set(photo.relativePath, photo);
        });
        // Display cached photos immediately
        const cachedPhotos = Array.from(photoMap.values()).sort((a, b) => b.date - a.date);
        setPhotos(cachedPhotos);
        if (cachedPhotos.length > 0) {
          const bounds = L.latLngBounds(cachedPhotos.map(photo => [photo.latitude, photo.longitude]));
          mapRef.current?.fitBounds(bounds, { padding: [50, 50] });
        }
      }

      // First pass: count total files
      setStatus('Counting files...');
      let totalFiles = 0;
      let countedFiles = 0;
      const countFiles = async (handle, path = '') => {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') {
            if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
              totalFiles++;
              countedFiles++;
              setProgress(Math.round((countedFiles / totalFiles) * 100));
              setStatus(`Counting files... (${countedFiles} found)`);
            }
          } else if (entry.kind === 'directory') {
            await countFiles(entry, path ? `${path}/${entry.name}` : entry.name);
          }
        }
      };
      await countFiles(dirHandle);
      setTotalPhotos(totalFiles);

      // Reset progress for file collection phase
      setProgress(0);
      setStatus('Collecting files...');

      // Second pass: collect files with progress
      const allFiles = [];
      const seenFiles = new Set();
      let collectedFiles = 0;

      const collectFiles = async (handle, path = '') => {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') {
            if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
              const file = await entry.getFile();
              file.relativePath = path ? `${path}/${entry.name}` : entry.name;
              
              if (!seenFiles.has(file.relativePath)) {
                seenFiles.add(file.relativePath);
                const existingPhoto = photoMap.get(file.relativePath);
                if (!existingPhoto || existingPhoto.lastModified !== file.lastModified) {
                  allFiles.push(file);
                }
              }
              
              collectedFiles++;
              setProgress(Math.round((collectedFiles / totalFiles) * 100));
              setProcessedPhotos(collectedFiles);
            }
          } else if (entry.kind === 'directory') {
            const newPath = path ? `${path}/${entry.name}` : entry.name;
            await collectFiles(entry, newPath);
          }
        }
      };

      await collectFiles(dirHandle);

      // Sort files by relative path for consistent processing order
      allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      
      if (allFiles.length === 0) {
        setStatus('No new or modified photos to scan');
        return; // Already displaying cached photos, so we can return here
      }

      // Reset progress for photo processing phase
      setProgress(0);
      setTotalPhotos(allFiles.length);
      setProcessedPhotos(0);

      // Process files in parallel and save thumbnails immediately
      setStatus('Processing photos and saving thumbnails...');
      const processedPhotos = await processImagesParallel(allFiles, dirHandle);
      
      // Update the photo map with new/updated photos
      processedPhotos.forEach(photo => {
        photoMap.set(photo.relativePath, photo);
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

  const handleAreaSelectMemoized = React.useCallback(async (e) => {
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
        // Get the original file by traversing the directory structure
        const pathParts = photo.relativePath.split('/');
        let currentDirHandle = dirHandleRef.current;
        
        // Navigate through subdirectories
        if (pathParts.length > 1) {
          for (let i = 0; i < pathParts.length - 1; i++) {
            currentDirHandle = await currentDirHandle.getDirectoryHandle(pathParts[i]);
          }
        }
        
        const file = await currentDirHandle.getFileHandle(photo.name);
        const fileData = await file.getFile();
        // Preserve directory structure in the zip
        zip.file(photo.relativePath, fileData);
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
  }, [photos]);

  return (
    <div className="App">
      <div className="sidebar">
        <div className="controls">
          <button onClick={handleScan} disabled={loading}>
            {loading ? 'Scanning...' : 'Select Directory'}
          </button>
          {loading && (
            <ScanProgress
              status={status}
              progress={progress}
              processedPhotos={processedPhotos}
              totalPhotos={totalPhotos}
            />
          )}
          {error && <div className="error">{error}</div>}
          {downloading && <div className="downloading">Creating zip file...</div>}
        </div>
        
        <div className="photos-list">
          <h3>Photos with GPS Data ({photos.length})</h3>
          <p className="help-text">Draw a rectangle on the map to select and download photos from that area.</p>
          <div className="photo-items" style={{ maxHeight: 'calc(100vh - 150px)', overflowY: 'auto' }}>
            {photos.map((photo, index) => (
              <div 
                key={photo.relativePath}
                ref={el => {
                  if (el) {
                    photoRefs.current.set(index, el);
                    if (observerRef.current) {
                      observerRef.current.observe(el);
                    }
                  }
                }}
                data-index={index}
                className={`photo-item ${selectedPhoto === index ? 'selected' : ''}`}
                onClick={() => handlePhotoSelectMemoized(index)}
              >
                {thumbnailCache.has(photo.relativePath) ? (
                  <img
                    src={thumbnailCache.get(photo.relativePath)}
                    alt={photo.relativePath}
                    className="thumbnail"
                  />
                ) : (
                  <div className="thumbnail-placeholder">
                    Loading...
                  </div>
                )}
                <div className="photo-info">
                  <div className="photo-name">{photo.name}</div>
                  <div className="photo-path">{photo.relativePath}</div>
                  <div className="photo-date">
                    {new Date(photo.date).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="map-container">
        <PhotosMap
          photos={photos}
          thumbnailCache={thumbnailCache}
          onPhotoSelect={handlePhotoSelectMemoized}
          onAreaSelect={handleAreaSelectMemoized}
          onThumbnailNeeded={handleThumbnailNeeded}
          onViewFullImage={setSelectedFullImage}
          mapRef={mapRef}
          featureGroupRef={featureGroupRef}
        />
      </div>

      {selectedFullImage && (
        <ImageViewer
          photo={selectedFullImage}
          photos={photos}
          onClose={() => setSelectedFullImage(null)}
          onNavigate={setSelectedFullImage}
          dirHandle={dirHandleRef.current}
          mapRef={mapRef}
        />
      )}
    </div>
  );
}

export default App;
