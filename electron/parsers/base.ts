import type {
  CatalogFilterState,
  Category,
  MediaDetails,
  PagedResult,
  SourceInfo,
  StreamCatalog,
  StreamsRequest,
} from '../models';

export interface SourceParser extends SourceInfo {
  getCatalog(page: number, categoryId?: string, filters?: CatalogFilterState): Promise<PagedResult>;
  search(query: string): Promise<PagedResult>;
  getDetails(url: string): Promise<MediaDetails>;
  /** Optional: does this parser own the given media URL? */
  matchesUrl?(url: string): boolean;
  /** Optional: custom stream resolution (instead of the generic embed resolver). */
  resolveStreams?(req: StreamsRequest, referer?: string): Promise<StreamCatalog>;
}
