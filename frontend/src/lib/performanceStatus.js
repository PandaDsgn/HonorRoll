// Shared status → label/chip-class mapping for assignment/exam performance
// rows — the same status vocabulary the backend's getAssignmentPerformance/
// getExamPerformance helpers emit (see backend/index.js), used by both the
// teacher dashboard (AdminDashboard.jsx) and the student cross-institution
// performance dashboard (MyPerformance.jsx).
export const PERF_STATUS_LABELS = {
  not_submitted: 'Not submitted',
  not_attempted: 'Not attempted',
  pending_grading: 'Pending grading',
  in_progress: 'In progress',
  graded: 'Graded',
};

export const PERF_STATUS_CLASS = {
  not_submitted: 'chip-neutral',
  not_attempted: 'chip-neutral',
  pending_grading: 'chip-medium',
  in_progress: 'chip-medium',
  graded: 'chip-easy',
};
