const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const exifr = require('exifr');
const archiver = require('archiver');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 34567;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

// Create ZIP file endpoint
app.post('/api/create-zip', (req, res) => {
  const { photos } = req.body;
  console.log(`Received zip creation request for ${photos?.length} photos`);
  
  if (!photos || !Array.isArray(photos) || photos.length === 0) {
    return res.status(400).json({ error: 'No photos provided' });
  }

  // Create a unique filename for this download
  const timestamp = new Date().getTime();
  const zipFileName = `photos_${timestamp}.zip`;
  const zipFilePath = path.join(__dirname, 'temp', zipFileName);

  // Ensure temp directory exists
  if (!fsSync.existsSync(path.join(__dirname, 'temp'))) {
    fsSync.mkdirSync(path.join(__dirname, 'temp'));
  }

  // Create write stream for the zip file
  const output = fsSync.createWriteStream(zipFilePath);
  const archive = archiver('zip');

  // Listen for all archive data to be written
  output.on('close', () => {
    console.log(`Archive created successfully: ${archive.pointer()} total bytes`);
    res.json({ 
      success: true, 
      zipFileName: zipFileName,
      message: 'ZIP file created successfully'
    });
  });

  // Error handling
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    fsSync.unlink(zipFilePath, () => {
      res.status(500).json({ error: 'Failed to create archive' });
    });
  });

  // Pipe archive data to the file
  archive.pipe(output);

  // Add files to archive
  photos.forEach(photo => {
    const filePath = photo.path;
    if (fsSync.existsSync(filePath)) {
      archive.file(filePath, { name: path.basename(filePath) });
    } else {
      console.warn(`File not found: ${filePath}`);
    }
  });

  // Finalize archive
  archive.finalize();
});

// Download the created ZIP file
app.get('/api/download-zip/:filename', (req, res) => {
  const zipFileName = req.params.filename;
  const zipFilePath = path.join(__dirname, 'temp', zipFileName);

  if (!fsSync.existsSync(zipFilePath)) {
    return res.status(404).json({ error: 'ZIP file not found' });
  }

  res.download(zipFilePath, 'selected_photos.zip', (err) => {
    if (err) {
      console.error('Error sending file:', err);
      return res.status(500).json({ error: 'Failed to download file' });
    }
    
    // Clean up: delete the temporary file after successful download
    fsSync.unlink(zipFilePath, (unlinkErr) => {
      if (unlinkErr) {
        console.error('Error deleting temporary file:', unlinkErr);
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 