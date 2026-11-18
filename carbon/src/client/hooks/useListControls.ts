import { useState } from 'react';

export type SortOrder = 'asc' | 'desc';

/**
 * Search, sort and page state for an admin list page. Every change of search
 * or sort goes back to page 1. The list starts sorted by `defaultField`,
 * descending.
 */
export function useListControls<F extends string>(defaultField: F) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<F>(defaultField);
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);

  /** Column header click: flip the order on the same field, else sort ascending. */
  const toggleSort = (field: F) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
    setPage(1);
  };

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  /** Sort select: a `<field>-<order>` value such as `created_at-desc`. */
  const selectSort = (value: string | null) => {
    if (!value) return;
    const [field, order] = value.split('-') as [F, SortOrder];
    setSortBy(field);
    setSortOrder(order);
    setPage(1);
  };

  return {
    search,
    sortBy,
    sortOrder,
    sortValue: `${sortBy}-${sortOrder}`,
    page,
    setPage,
    toggleSort,
    handleSearch,
    selectSort,
  };
}
