import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/feedback';
import { buttonClasses } from '../components/Button';

export function NotFound() {
  return (
    <EmptyState
      icon={<Compass size={22} />}
      title="Page not found"
      description="There's nothing at this address. It may have moved, or the link is mistyped."
      action={
        <Link to="/" className={buttonClasses('secondary', 'sm')}>
          Back to dashboard
        </Link>
      }
      className="py-24"
    />
  );
}
