import { env } from '$env/dynamic/public';

export const ADMIN_EMAIL = 'eventivicini.info@gmail.com'; // deve coincidere con isAdmin() in firestore.rules
export const SITE_NAME = 'Eventi Vicini';

export const siteUrl = () => (env.PUBLIC_SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
export const useEmulators = () => env.PUBLIC_USE_EMULATORS === 'true';

export const firebaseConfig = () => ({
	apiKey: env.PUBLIC_FIREBASE_API_KEY,
	authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
	projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
	appId: env.PUBLIC_FIREBASE_APP_ID
});
