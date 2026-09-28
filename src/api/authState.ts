// The authenticated-user triple, in a module with NO imports and no runtime
// dependencies beyond the type itself.
//
// It lives apart from auth.ts because the service worker needs the type: it
// performs follow approvals and severs on the user's behalf, and shares those
// helpers with the app. auth.ts is app-only (localStorage, window, the OAuth
// redirect), and TypeScript type-checks every module in a program — so importing
// the interface from there would drag the whole app-only module into the SW build
// and fail it. A type-only module keeps the SW program free of DOM-typed code,
// which is exactly what its stricter tsconfig.sw.json is there to enforce.
export interface AuthState {
  instance: string;
  accessToken: string;
  accountId: string;
}
