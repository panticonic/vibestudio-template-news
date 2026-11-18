// The workspace TypeScript checker shares the Natlang untrusted text brand.
export type Untrusted<T> = T & { readonly __natlangUntrusted: true };
