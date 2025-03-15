/* eslint-disable no-restricted-globals */
const EXIF = require('exif-js');

function convertDMSToDD(degrees, minutes, seconds, direction) {
  let dd = degrees + minutes / 60 + seconds / 3600;
  if (direction === 'S' || direction === 'W') {
    dd = dd * -1;
  }
  return dd;
}

async function processImage(imageData) {
  const { file, arrayBuffer, relativePath } = imageData;
  
  // Extract EXIF data
  const tags = EXIF.readFromBinaryFile(arrayBuffer);
  
  let metadata = {
    latitude: null,
    longitude: null,
    dateTimeOriginal: null
  };

  if (tags) {
    metadata.dateTimeOriginal = tags.DateTimeOriginal;

    if (tags.GPSLatitude && tags.GPSLongitude) {
      const latDegrees = tags.GPSLatitude[0].numerator / tags.GPSLatitude[0].denominator;
      const latMinutes = tags.GPSLatitude[1].numerator / tags.GPSLatitude[1].denominator;
      const latSeconds = tags.GPSLatitude[2].numerator / tags.GPSLatitude[2].denominator;
      const latDirection = tags.GPSLatitudeRef;

      const lonDegrees = tags.GPSLongitude[0].numerator / tags.GPSLongitude[0].denominator;
      const lonMinutes = tags.GPSLongitude[1].numerator / tags.GPSLongitude[1].denominator;
      const lonSeconds = tags.GPSLongitude[2].numerator / tags.GPSLongitude[2].denominator;
      const lonDirection = tags.GPSLongitudeRef;

      metadata.latitude = convertDMSToDD(latDegrees, latMinutes, latSeconds, latDirection);
      metadata.longitude = convertDMSToDD(lonDegrees, lonMinutes, lonSeconds, lonDirection);
    }
  }

  // Create thumbnail
  const img = await createImageBitmap(file);
  const MAX_SIZE = 200;
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

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const thumbnailArrayBuffer = await blob.arrayBuffer();

  return {
    metadata,
    thumbnailArrayBuffer,
    lastModified: file.lastModified
  };
}

self.onmessage = async function(e) {
  try {
    const result = await processImage(e.data);
    self.postMessage(result, [result.thumbnailArrayBuffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
}; 