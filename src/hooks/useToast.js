import { createContext, useContext } from 'react';

export const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // No-op fallback so components never crash if rendered outside a provider.
    return { info: () => {}, success: () => {}, error: () => {} };
  }
  return ctx;
}
