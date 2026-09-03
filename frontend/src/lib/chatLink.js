// Where a click on "Chat" (a notification, or the top-bar shortcut icon)
// should send each role — a teacher's own chat inbox is a tab inside
// /admin, a student's is its own top-level page. Shared by
// NotificationBell.jsx and components/SpaceSwitcher.jsx's ChatShortcut;
// split into its own module (rather than exported alongside a component)
// so both stay fast-refresh-friendly single-component files.
export function chatLinkFor(role) {
  return role === 'teacher' ? { path: '/admin', state: { tab: 'chat' } } : { path: '/chat', state: undefined };
}
