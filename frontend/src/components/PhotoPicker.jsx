import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import ImageCropper from './ImageCropper';
import { API } from '../config';

const MAX_PHOTOS = 5;

// A user's own photo library — upload, delete, and (when onSelect is
// given) pick which one backs a particular institution's ID card. Fully
// self-contained: fetches its own list from GET /api/me/photos rather than
// taking it as a prop, since it's reused both in MyProfile's general
// "manage my photos" section and inline wherever a card needs a photo
// picked, and both call sites want the same up-to-date list.
export default function PhotoPicker({ selectedPhotoId, onSelect }) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [cropFile, setCropFile] = useState(null);
  const fileInputRef = useRef(null);

  const fetchPhotos = () => {
    setLoading(true);
    axios.get(`${API}/api/me/photos`, { withCredentials: true })
      .then((res) => setPhotos(res.data.photos))
      .catch(() => setError('Could not load your photos.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPhotos(); }, []);

  // A raw picked file always goes through the cropper first (see
  // ImageCropper.jsx) — the actual upload only happens once the student's
  // confirmed a crop, via handleCropConfirm below.
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCropFile(file);
  };

  const handleCropConfirm = async (blob) => {
    setCropFile(null);
    setUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append('photo', blob, 'photo.jpg');
    try {
      await axios.post(`${API}/api/me/photos`, formData, { withCredentials: true });
      fetchPhotos();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload photo.');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (photoId) => {
    try {
      await axios.delete(`${API}/api/me/photos/${photoId}`, { withCredentials: true });
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      if (selectedPhotoId === photoId) onSelect?.(null);
    } catch {
      setError('Failed to delete photo.');
    }
  };

  return (
    <div className="photo-picker">
      {cropFile && (
        <div className="cropper-overlay" role="dialog" aria-modal="true">
          <ImageCropper file={cropFile} onCancel={() => setCropFile(null)} onConfirm={handleCropConfirm} />
        </div>
      )}
      {error && <div className="photo-picker-error">{error}</div>}
      {loading ? (
        <div className="photo-picker-empty">Loading photos…</div>
      ) : (
        <div className="photo-picker-grid">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className={`photo-picker-item${selectedPhotoId === photo.id ? ' photo-picker-item-selected' : ''}`}
            >
              <img
                src={photo.url}
                alt=""
                className="photo-picker-thumb"
                onClick={() => onSelect?.(photo.id)}
                role={onSelect ? 'button' : undefined}
              />
              <button type="button" className="photo-picker-delete" onClick={() => handleDelete(photo.id)} aria-label="Delete photo">×</button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button
              type="button"
              className="photo-picker-add"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Upload a photo"
            >
              {uploading ? '…' : '+'}
            </button>
          )}
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="image/*" className="photo-picker-input" onChange={handleFileChange} />
      <p className="photo-picker-hint">
        Up to {MAX_PHOTOS} photos, 5MB each.{onSelect ? ' Click a photo to use it on this card.' : ''}
      </p>
    </div>
  );
}
