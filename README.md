# Photos Locator

A web application that scans photos in a directory, extracts their location information from EXIF data, and displays them on an interactive map.

## Features

- Scan directories recursively for photos
- Extract GPS coordinates from photo EXIF data
- Display photos on an interactive map
- View photo thumbnails and dates by clicking markers
- Support for JPG, JPEG, PNG, and GIF files

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd photos-locator
```

2. Install backend dependencies:
```bash
npm install
```

3. Install frontend dependencies:
```bash
cd client
npm install
```

## Running the Application

1. Start the backend server:
```bash
# From the root directory
npm run dev
```

2. Start the frontend development server:
```bash
# From the root directory
npm run client
```

Or run both simultaneously:
```bash
npm run dev:full
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:34567

## Usage

1. Enter the full path to the directory containing your photos in the input field
2. Click "Scan Directory" to start scanning for photos
3. Wait for the scanning process to complete
4. View your photos on the map by clicking the markers
5. Each marker shows a thumbnail and the date the photo was taken

## Notes

- The application only processes photos that have GPS coordinates in their EXIF data
- Large directories may take some time to scan
- Make sure you have read permissions for the directory you want to scan 