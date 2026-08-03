import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { router } from './router.js';
import './styles.css';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Dashboard root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: 1, refetchOnWindowFocus: false },
          },
        })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
