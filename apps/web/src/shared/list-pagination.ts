export interface PageSlice<T> {
  readonly items: readonly T[];
  readonly currentPage: number;
  readonly pageCount: number;
  readonly totalItems: number;
  readonly pageSize: number;
}

export function paginate<T>(items: readonly T[], requestedPage: number, requestedPageSize: number): PageSlice<T> {
  const pageSize = Number.isFinite(requestedPageSize) ? Math.max(1, Math.floor(requestedPageSize)) : 1;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const currentPage = Math.min(pageCount, Math.max(1, safePage));
  const start = (currentPage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), currentPage, pageCount, totalItems: items.length, pageSize };
}
