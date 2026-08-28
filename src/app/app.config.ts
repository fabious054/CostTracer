import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';

/**
 * Zoneless: the whole app is signal-driven (see `ConnectionStore`), so zone.js earns nothing
 * here and we drop it from the bundle. Revisit only if a dependency needs zone patching.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideZonelessChangeDetection()],
};
