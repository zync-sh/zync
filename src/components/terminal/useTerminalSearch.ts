import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal as XTerm } from '@xterm/xterm';

export interface UseTerminalSearchOptions {
  searchAddonRef: RefObject<SearchAddon | null>;
  termRef: RefObject<XTerm | null>;
}

export function useTerminalSearch({ searchAddonRef, termRef }: UseTerminalSearchOptions) {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const isSearchOpenRef = useRef(isSearchOpen);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  const handleNext = useCallback(() => {
    searchAddonRef.current?.findNext(searchText);
  }, [searchAddonRef, searchText]);

  const handlePrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(searchText);
  }, [searchAddonRef, searchText]);

  const handleClose = useCallback(() => {
    setIsSearchOpen(false);
    setSearchText('');
    termRef.current?.focus();
  }, [termRef]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const resetSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchText('');
    try {
      searchAddonRef.current?.clearDecorations();
    } catch {
      // Search addon may not be bound yet on first mount.
    }
  }, [searchAddonRef]);

  const handleSearchTextChange = useCallback((value: string) => {
    setSearchText(value);
    searchAddonRef.current?.findNext(value, { incremental: true });
  }, [searchAddonRef]);

  return {
    isSearchOpen,
    isSearchOpenRef,
    searchText,
    searchInputRef,
    handleNext,
    handlePrev,
    handleClose,
    openSearch,
    resetSearch,
    handleSearchTextChange,
  };
}