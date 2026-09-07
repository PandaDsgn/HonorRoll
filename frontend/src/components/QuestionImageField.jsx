import { useState } from 'react';
import axios from 'axios';
import { API } from '../config';

// Shared by AssignmentForm and ExamForm — picks a file, uploads it
// immediately (see POST /api/admin/question-images, which exists precisely
// because a question in either form builder has no row/id to key an object
// under until the whole assignment/exam is saved), and reports the
// resulting imageKey back up so the parent can carry it in the question's
// own payload at submit time. Preview/uploading/error state all live here
// since none of it needs to survive outside this one field.
export default function QuestionImageField({ imageUrl, onChange }) {
  const [preview, setPreview] = useState(imageUrl || '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await axios.post(`${API}/api/admin/question-images`, formData, { withCredentials: true });
      setPreview(res.data.url);
      onChange(res.data.imageKey);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload image.');
    } finally {
      setUploading(false);
    }
  };

  const remove = () => {
    setPreview('');
    setError('');
    onChange(null);
  };

  return (
    <div className="field">
      <label>Image (optional)</label>
      {preview ? (
        <div className="question-image-preview">
          <img src={preview} alt="Attached to this question" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={remove}>Remove image</button>
        </div>
      ) : (
        <input type="file" accept="image/*" onChange={handleFile} disabled={uploading} />
      )}
      {uploading && <p className="sb-loading">Uploading…</p>}
      {error && <p className="auth-sub" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
