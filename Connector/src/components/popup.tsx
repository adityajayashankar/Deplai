'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

type PopupType = 'success' | 'error' | 'warning' | 'info';

interface PopupConfig {
  id: string;
  message: string;
  type: PopupType;
  duration?: number;
  title?: string;
}

interface PopupContextType {
  showPopup: (config: Omit<PopupConfig, 'id'>) => void;
  hidePopup: (id: string) => void;
}

const PopupContext = createContext<PopupContextType | undefined>(undefined);

export function usePopup() {
  const context = useContext(PopupContext);
  if (!context) {
    throw new Error('usePopup must be used within a PopupProvider');
  }
  return context;
}

function PopupIcon({ path }: { path: string }) {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  );
}

const TYPE_CONFIG: Record<PopupType, {
  container: string;
  icon: string;
  title: string;
  defaultTitle: string;
  iconPath: string;
}> = {
  success: {
    container: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    icon: 'text-green-500 dark:text-green-400 bg-green-100 dark:bg-green-900/50',
    title: 'text-green-800 dark:text-green-200',
    defaultTitle: 'Success',
    iconPath: 'M5 13l4 4L19 7',
  },
  error: {
    container: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    icon: 'text-red-500 dark:text-red-400 bg-red-100 dark:bg-red-900/50',
    title: 'text-red-800 dark:text-red-200',
    defaultTitle: 'Error',
    iconPath: 'M6 18L18 6M6 6l12 12',
  },
  warning: {
    container: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    icon: 'text-yellow-500 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-900/50',
    title: 'text-yellow-800 dark:text-yellow-200',
    defaultTitle: 'Warning',
    iconPath: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  info: {
    container: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    icon: 'text-blue-500 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50',
    title: 'text-blue-800 dark:text-blue-200',
    defaultTitle: 'Info',
    iconPath: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
};

function PopupItem({ popup, onClose }: { popup: PopupConfig; onClose: () => void }) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const handleClose = useCallback(() => {
    setIsLeaving(true);
    setTimeout(() => {
      onClose();
    }, 300);
  }, [onClose]);

  useEffect(() => {
    // Trigger enter animation
    const enterTimer = setTimeout(() => setIsVisible(true), 10);

    // Auto dismiss
    const duration = popup.duration ?? 4000;
    if (duration > 0) {
      const dismissTimer = setTimeout(() => {
        handleClose();
      }, duration);
      return () => {
        clearTimeout(enterTimer);
        clearTimeout(dismissTimer);
      };
    }

    return () => clearTimeout(enterTimer);
  }, [popup.duration, handleClose]);

  const config = TYPE_CONFIG[popup.type];
  const title = popup.title ?? config.defaultTitle;

  return (
    <div
      className={`
        w-full max-w-sm pointer-events-auto
        transform transition-all duration-300 ease-out
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
      `}
    >
      <div className={`rounded-lg border shadow-lg ${config.container}`}>
        <div className="p-4">
          <div className="flex items-start">
            <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${config.icon}`}>
              <PopupIcon path={config.iconPath} />
            </div>
            <div className="ml-3 flex-1">
              <p className={`text-sm font-medium ${config.title}`}>
                {title}
              </p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {popup.message}
              </p>
            </div>
            <button
              onClick={handleClose}
              className="ml-4 shrink-0 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PopupProvider({ children }: { children: React.ReactNode }) {
  const [popups, setPopups] = useState<PopupConfig[]>([]);

  const showPopup = useCallback((config: Omit<PopupConfig, 'id'>) => {
    const id = `popup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setPopups((prev) => [...prev, { ...config, id }]);
  }, []);

  const hidePopup = useCallback((id: string) => {
    setPopups((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return (
    <PopupContext.Provider value={{ showPopup, hidePopup }}>
      {children}

      {popups.length > 0 && (
        <div className="fixed top-4 right-4 z-9999 flex flex-col gap-3 pointer-events-none">
          {popups.map((popup) => (
            <PopupItem
              key={popup.id}
              popup={popup}
              onClose={() => hidePopup(popup.id)}
            />
          ))}
        </div>
      )}
    </PopupContext.Provider>
  );
}

