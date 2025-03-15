export default function createImageWorker() {
  return new Worker(new URL('./imageWorker.js', import.meta.url));
} 