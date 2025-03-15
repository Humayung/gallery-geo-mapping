# Photos Locator

A powerful web application that helps you visualize and organize your photos on a map based on their geolocation data. This tool is perfect for photographers, travelers, and anyone who wants to explore their photo collection in a geographical context.

## Features

- **Interactive Map Interface**: Visualize your photos on an interactive map using Leaflet
- **EXIF Data Extraction**: Automatically extracts location data from photo metadata
- **Batch Processing**: Efficiently process multiple photos simultaneously using Web Workers
- **Clustering**: Groups nearby photos into clusters for better visualization
- **Area Selection**: Select specific areas on the map to filter photos
- **Thumbnail Generation**: Creates and manages photo thumbnails for faster loading
- **Local Storage**: Save and load your photo collections locally
- **Responsive Design**: Works seamlessly on both desktop and mobile devices

## Technology Stack

- **Frontend Framework**: React.js
- **Map Library**: Leaflet with React-Leaflet integration
- **Clustering**: react-leaflet-cluster for marker clustering
- **Drawing Tools**: react-leaflet-draw for area selection
- **EXIF Processing**: exif-js for metadata extraction
- **File Handling**: JSZip for managing photo collections
- **Performance**: Web Workers for parallel processing
- **Styling**: Custom CSS with responsive design

## Getting Started

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm start
   ```
4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Usage

1. Click the "Scan Photos" button to select photos from your device
2. The app will process your photos and extract location data
3. Photos will appear as markers on the map
4. Use the clustering feature to manage large collections
5. Draw areas on the map to filter photos by location
6. Click on markers to view photo thumbnails and details

## Performance Features

- Parallel processing using Web Workers
- Efficient thumbnail generation and caching
- Marker clustering for handling large datasets
- Optimized image loading and processing
- Batch processing with configurable batch sizes

## Technical Details

- Supports multiple image formats
- Processes EXIF metadata for location information
- Converts DMS (Degrees, Minutes, Seconds) to decimal coordinates
- Implements efficient memory management for large collections
- Uses local storage for saving session data

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open source and available under the MIT License.

## Acknowledgments

- Leaflet.js for the mapping functionality
- React community for the excellent ecosystem
- Contributors and users of the project
