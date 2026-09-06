import { Link } from 'react-router-dom';

// items: [{ label, to? }] — the last item renders as plain text (current page),
// every earlier item with a `to` renders as a link.
export default function Breadcrumbs({ items }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="breadcrumb-item">
            {item.to && !isLast
              ? <Link to={item.to}>{item.label}</Link>
              : <span aria-current={isLast ? 'page' : undefined}>{item.label}</span>}
            {!isLast && <span className="breadcrumb-sep" aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}
