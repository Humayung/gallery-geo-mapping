import React, { useState, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, FeatureGroup } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import MarkerClusterGroup from 'react-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import L from 'leaflet';
import './App.css';

// Fix for default marker icons in React-Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

function App() {
  const [photos, setPhotos] = useState([]);
  const [directory, setDirectory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const mapRef = useRef(null);
  const featureGroupRef = useRef(null);

  const handleScan = async () => {
    if (!directory) {
      setError('Please enter a directory path');
      return;
    }

    setLoading(true);
    setError(null);
    setPhotos([]);

    try {
      const response = await fetch('http://localhost:34567/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ directory }),
      });

      if (!response.ok) {
        throw new Error('Failed to scan directory');
      }

      const data = await response.json();
      setPhotos(data.photos);

      // Center map on photos if any are found
      if (data.photos.length > 0) {
        const bounds = L.latLngBounds(data.photos.map(photo => [photo.latitude, photo.longitude]));
        mapRef.current?.fitBounds(bounds, { padding: [50, 50] });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      setError(null);
      
      // Step 1: Create the ZIP file
      const createResponse = await fetch('http://localhost:34567/api/create-zip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          photos: selectedPhotos
        }),
      });

      if (!createResponse.ok) {
        throw new Error('Failed to create ZIP file');
      }

      const { zipFileName } = await createResponse.json();
      
      // Step 2: Download the ZIP file
      window.location.href = `http://localhost:34567/api/download-zip/${zipFileName}`;

    } catch (err) {
      console.error('Download error:', err);
      setError('Failed to download photos. Please try again.');
    } finally {
      // Give some time for the download to start before clearing
      setTimeout(() => {
        setDownloading(false);
        featureGroupRef.current.clearLayers();
      }, 1000);
    }
  };

  return (
    <div className="App">
      <div className="sidebar">
        <div className="controls">
          <input
            type="text"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="Enter directory path"
            className="directory-input"
          />
          <button onClick={handleScan} disabled={loading}>
            {loading ? 'Scanning...' : 'Scan Directory'}
          </button>
          {error && <div className="error">{error}</div>}
          {downloading && <div className="downloading">Creating zip file...</div>}
        </div>
        
        <div className="photos-list">
          <h3>Photos with GPS Data ({photos.length})</h3>
          <p className="help-text">Draw a rectangle on the map to select and download photos from that area.</p>
          {loading ? (
            <div className="scanning-message">Scanning directory...</div>
          ) : (
            <div className="photo-items">
              {photos.map((photo, index) => (
                <div 
                  key={index} 
                  className={`photo-item ${selectedPhoto === index ? 'selected' : ''}`}
                  onClick={() => handlePhotoSelect(index)}
                >
                  <img
                    src={`http://localhost:34567${photo.thumbnail}`}
                    alt={photo.name}
                    className="thumbnail"
                  />
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
                    <div className="popup-image-container">
                      <img
                        src={`http://localhost:34567${photo.thumbnail}`}
                        alt={photo.name}
                        className="popup-image"
                        onClick={() => handlePhotoSelect(index)}
                      />
                    </div>
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
