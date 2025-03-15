import React, { useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, FeatureGroup } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import MarkerClusterGroup from 'react-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import L from 'leaflet';
import './App.css';
import JSZip from 'jszip';
import EXIF from 'exif-js';

// Fix for default marker icons in React-Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

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

    // Load thumbnails for each photo
    const thumbnailsDirHandle = await dirHandle.getDirectoryHandle('thumbnails');
    
    const loadedPhotos = await Promise.all(data.photos.map(async photo => {
      try {
        const thumbnailFile = await thumbnailsDirHandle.getFileHandle(photo.name + '.thumb.jpg');
        const thumbnailBlob = await thumbnailFile.getFile();
        const thumbnail = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(thumbnailBlob);
        });
        console.log(photo);
        return {
          ...photo,
          thumbnail,
          lastModified: new Date(photo.lastModified) // Convert date string back to Date object
        };
      } catch (err) {
        console.error(`Error loading thumbnail for ${photo.name}:`, err);
        return null;
      }
    }));

    // Filter out any photos where thumbnail loading failed
    return {
      ...data,
      photos: loadedPhotos.filter(photo => photo !== null)
    };
  } catch (err) {
    if (err.name === 'NotFoundError') {
      return null;
    }
    console.error('Error loading cache:', err);
    throw err;
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

  const handleScan = async () => {
    try {
      setLoading(true);
      setError(null);
      setPhotos([]);
      setProgress(0);
      setTotalPhotos(0);
      setProcessedPhotos(0);
      setStatus('');

      const dirHandle = await window.showDirectoryPicker();
      
      // Try to load existing cache
      setStatus('Checking for existing cache...');
      const cachedData = await loadFromJson(dirHandle);
      let existingPhotos = [];
      let existingPhotoNames = new Set();
      
      if (cachedData) {
        setStatus('Found cached data, loading...');
        existingPhotos = cachedData.photos;
        existingPhotoNames = new Set(existingPhotos.map(p => p.name));
        setPhotos(existingPhotos);
      }

      // Collect all photo files that aren't in the cache
      setStatus('Scanning for new photos...');
      const newPhotoFiles = [];
      for await (const file of getFiles(dirHandle)) {
        if (!existingPhotoNames.has(file.name)) {
          newPhotoFiles.push(file);
        }
      }

      setTotalPhotos(newPhotoFiles.length);
      
      if (newPhotoFiles.length === 0) {
        setStatus('No new photos to scan');
        if (existingPhotos.length > 0) {
          const bounds = L.latLngBounds(existingPhotos.map(photo => [photo.latitude, photo.longitude]));
          mapRef.current?.fitBounds(bounds, { padding: [50, 50] });
        }
        return;
      }

      // Process new files
      setStatus('Processing new photos...');
      const newPhotos = [...existingPhotos];

      for (const file of newPhotoFiles) {
        try {
          const metadata = await getExifData(file);
          const { latitude, longitude, dateTimeOriginal } = metadata;
          
          if (latitude && longitude) {
            const thumbnail = await createThumbnail(file);
            newPhotos.push({
              name: file.name,
              date: dateTimeOriginal || new Date(file.lastModified),
              latitude,
              longitude,
              thumbnail,
              file
            });
          }
        } catch (err) {
          console.error('Error processing file:', file.name, err);
        }
        
        setProcessedPhotos(prev => {
          const newValue = prev + 1;
          setProgress(Math.round((newValue / newPhotoFiles.length) * 100));
          return newValue;
        });
      }

      // Save updated data to cache
      setStatus('Saving updated cache...');
      await saveToJson(newPhotos, dirHandle);

      setPhotos(newPhotos);
      setStatus('Scan complete');

      if (newPhotos.length > 0) {
        const bounds = L.latLngBounds(newPhotos.map(photo => [photo.latitude, photo.longitude]));
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

  const handlePhotoSelect = (index) => {
    setSelectedPhoto(index);
    const photo = photos[index];
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
      const zip = new JSZip();
      
      for (const photo of selectedPhotos) {
        zip.file(photo.name, photo.file);
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
              Scanning directory... {progress}%<br/>
              Processed: {processedPhotos}/{totalPhotos} photos
            </div>
          ) : (
            <div className="photo-items">
              {photos.map((photo, index) => (
                <div 
                  key={index} 
                  className={`photo-item ${selectedPhoto === index ? 'selected' : ''}`}
                  onClick={() => handlePhotoSelect(index)}
                >
                  <img
                    src={photo.thumbnail}
                    alt={photo.name}
                    className="thumbnail"
                  />
                  <div className="photo-info">
                    <div className="photo-name">{photo.name}</div>
                    <div className="photo-date">
                      {photo.date.toLocaleString()}
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
                    <div className="popup-image-container">
                      <img
                        src={photo.thumbnail}
                        alt={photo.name}
                        className="popup-image"
                        onClick={() => handlePhotoSelect(index)}
                      />
                    </div>
                    <p className="photo-name">{photo.name}</p>
                    <p className="photo-date">
                      {photo.date.toLocaleString()}
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
