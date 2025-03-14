const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const exifr = require('exifr');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 34567;

app.use(cors());
app.use(express.json());

// Function to scan directory recursively
async function scanDirectory(dirPath) {
  console.log(`Scanning directory: ${dirPath}`);
  const files = await fs.readdir(dirPath);
  const photos = [];
  let totalProcessed = 0;

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = await fs.stat(fullPath);
    totalProcessed++;

    if (stat.isDirectory()) {
      console.log(`Found subdirectory: ${fullPath}`);
      const subPhotos = await scanDirectory(fullPath);
      photos.push(...subPhotos);
    } else if (file.match(/\.(jpg|jpeg|png|gif)$/i)) {
      console.log(`Processing photo: ${fullPath}`);
      try {
        const exif = await exifr.parse(fullPath);
        if (exif && exif.latitude && exif.longitude) {
          console.log(`Found GPS data in: ${file}`);
          photos.push({
            name: file,
            path: fullPath,
            latitude: exif.latitude,
            longitude: exif.longitude,
            date: exif.DateTimeOriginal || exif.CreateDate,
            thumbnail: `/api/thumbnail/${encodeURIComponent(fullPath)}`
          });
        } else {
          console.log(`No GPS data in: ${file}`);
        }
      } catch (error) {
        console.error(`Error processing ${fullPath}:`, error);
      }
    }
  }

  return photos;
}

// API Routes
app.post('/api/scan', async (req, res) => {
  try {
    const { directory } = req.body;
    if (!directory) {
      return res.status(400).json({ error: 'Directory path is required' });
    }

    console.log(`Starting scan of directory: ${directory}`);
    const photos = await scanDirectory(directory);
    console.log(`Scan complete. Found ${photos.length} photos with GPS data`);
    
    // Sort photos by date
    photos.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    res.json({
      total: photos.length,
      photos: photos
    });
  } catch (error) {
    console.error('Error scanning directory:', error);
    res.status(500).json({ error: 'Failed to scan directory' });
  }
});

app.get('/api/thumbnail/:path(*)', async (req, res) => {
  try {
    const filePath = decodeURIComponent(req.params.path);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 