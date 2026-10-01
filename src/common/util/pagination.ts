import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The page shape the admin tables render ("Showing 1 to 7 of 32 results"). */
export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** 1-based inclusive span. */
  from: number;
  to: number;
};

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export type PageWindow = { page: number; size: number; skip: number; pageCount: number };

/** Clamps the requested page into range, the way the admin pager expects. */
export function pageWindow(total: number, page = 1, size = 20): PageWindow {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  return { page: current, size, skip: (current - 1) * size, pageCount };
}

export function toPage<T>(rows: T[], total: number, window: PageWindow): Page<T> {
  return {
    rows,
    total,
    page: window.page,
    pageCount: window.pageCount,
    pageSize: window.size,
    from: total === 0 ? 0 : window.skip + 1,
    to: window.skip + rows.length,
  };
}

/** Pages an in-memory list with the same semantics as the database pager. */
export function paginateArray<T>(items: T[], page = 1, size = 20): Page<T> {
  const window = pageWindow(items.length, page, size);
  return toPage(items.slice(window.skip, window.skip + window.size), items.length, window);
}
