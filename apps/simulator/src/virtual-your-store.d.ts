declare module 'virtual:your-store' {
  export const yourStore: import('./extensions').YourStoreExtension | undefined;
}
