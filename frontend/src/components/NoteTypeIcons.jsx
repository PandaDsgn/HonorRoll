// Feather-style stroke icons, same shape as EyeIcons.jsx — one per note
// media type, shared by the teacher Uploads picker/list and the student
// Notes list so both sides render an identical icon for the same type.
function Svg({ children, size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function PdfIcon({ size }) {
  return (
    <Svg size={size}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </Svg>
  );
}

function ImageIcon({ size }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </Svg>
  );
}

function VideoIcon({ size }) {
  return (
    <Svg size={size}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </Svg>
  );
}

function AudioIcon({ size }) {
  return (
    <Svg size={size}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </Svg>
  );
}

function TextIcon({ size }) {
  return (
    <Svg size={size}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </Svg>
  );
}

function LinkIcon({ size }) {
  return (
    <Svg size={size}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

// Single source of truth for every note-type option: the icon, the label,
// the accept filter for its file input (file-based types only), and
// whether it's file-based at all (drives which fields TeacherUploadsPanel
// shows for the currently-selected type).
export const NOTE_TYPES = [
  { value: 'pdf', label: 'PDF', icon: PdfIcon, isFile: true, accept: 'application/pdf' },
  { value: 'image', label: 'Photo', icon: ImageIcon, isFile: true, accept: 'image/*' },
  { value: 'video', label: 'Video', icon: VideoIcon, isFile: true, accept: 'video/*' },
  { value: 'audio', label: 'Audio', icon: AudioIcon, isFile: true, accept: 'audio/*' },
  { value: 'text', label: 'Text', icon: TextIcon, isFile: false },
  { value: 'link', label: 'Link', icon: LinkIcon, isFile: false },
];

// Admin notices skip audio/video (see POST /api/admin/notices' own
// backend-side NOTICE_TYPES set) — a notice is meant to be read at a
// glance, not sat through as a recording — so this is NOTE_TYPES minus
// those two entries rather than its own separately-maintained list.
export const NOTICE_TYPES = NOTE_TYPES.filter((t) => t.value !== 'video' && t.value !== 'audio');

const ICONS_BY_TYPE = Object.fromEntries(NOTE_TYPES.map((t) => [t.value, t.icon]));

// Renders just the icon for one note's type — used in list rows where the
// full NOTE_TYPES metadata isn't needed, just a visual tag. Falls back to
// the PDF icon for any unrecognized/legacy type value.
export function NoteTypeIcon({ type, size = 16 }) {
  const Icon = ICONS_BY_TYPE[type] || PdfIcon;
  return <Icon size={size} />;
}
