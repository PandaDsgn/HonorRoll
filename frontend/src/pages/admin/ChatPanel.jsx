import { ChatWidget } from '../Chat';

// ============================================================================
// CHAT — a teacher's private, end-to-end-encrypted channel to each student
// in a subject they teach. Thin wrapper: all the actual contact-list/
// thread/encrypt-decrypt logic lives in ChatWidget (pages/Chat.jsx), shared
// with the student-facing page rather than duplicated here.
// ============================================================================
export default function ChatPanel() {
  return <ChatWidget />;
}
