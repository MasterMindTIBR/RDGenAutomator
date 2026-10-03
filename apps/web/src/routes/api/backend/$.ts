import { createFileRoute } from '@tanstack/react-router';
import { forwardBackendRequest } from '@/lib/proxy';

export const Route = createFileRoute('/api/backend/$')({
  server: {
    handlers: {
      ANY: ({ request, params }) => { const values = params as Record<string, string>; return forwardBackendRequest(request, `/${values['_splat'] ?? values['id'] ?? ''}`); },
    },
  },
});
