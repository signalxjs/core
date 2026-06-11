import { lazy } from 'sigx';

/**
 * Shared lazy factories. Defined in their own module so BOTH the page (to
 * render) and entry-client.tsx (to preload before hydration) reference the
 * same instance.
 */
export const TechDetails = lazy(() => import('./sections/TechDetails'));
